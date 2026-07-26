#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * standalone_update.php — Actualiza data/cartera_v4.sqlite desde APIs, sin MySQL.
 *
 * Pensado para GitHub Actions (cron diario). Idempotente: cada corrida solo
 * descarga lo que falta; no re-procesa años de histórico.
 *
 * APIs utilizadas:
 *   ArgentinaDatos (sin clave) : dólar MEP · UVA · IPC AR · depósitos 30 días
 *   Tiingo         (TIINGO_API_KEY): SPY · TLT · IEF
 *   FRED           (FRED_API_KEY)  : CPI US (inflación USD)
 *
 * Usage:
 *   php cron/standalone_update.php [--dry-run] [--verbose] [--from=YYYY-MM-DD]
 *
 * Exit codes: 0 OK · 1 al menos un error.
 */

// ── Config ─────────────────────────────────────────────────────────────────────

// Carga .env del root del repo si existe (para uso local)
$dotenv = dirname(__DIR__) . '/.env';
if (is_file($dotenv)) {
    foreach (file($dotenv, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        if ($line === '' || $line[0] === '#') continue;
        if (!str_contains($line, '=')) continue;
        [$k, $v] = explode('=', $line, 2);
        $k = trim($k); $v = trim($v, " \t\"'");
        if ($k !== '' && !getenv($k)) putenv("{$k}={$v}");
    }
}

define('SQLITE_FILE',   dirname(__DIR__) . '/data/cartera_v4.sqlite');
define('TIINGO_KEY',    (string)(getenv('TIINGO_API_KEY') ?: ''));
define('FRED_KEY',      (string)(getenv('FRED_API_KEY')   ?: ''));
define('BACKFILL_FROM', '2020-01-01');

$opts    = getopt('', ['dry-run', 'verbose', 'from:']);
$dryRun  = isset($opts['dry-run']);
$verbose = isset($opts['verbose']);
$fromCli = $opts['from'] ?? null;

if ($fromCli !== null && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $fromCli)) {
    fwrite(STDERR, "Fecha --from inválida: {$fromCli} (esperado YYYY-MM-DD)\n");
    exit(1);
}

$errors = [];

// ── Helpers ────────────────────────────────────────────────────────────────────

function out(string $msg): void { echo $msg . PHP_EOL; }

function http_get(string $url, int $timeout = 30): string {
    $ctx = stream_context_create(['http' => [
        'timeout'       => $timeout,
        'method'        => 'GET',
        'header'        => "User-Agent: cartera-clara/1.0\r\nAccept: application/json\r\n",
        'ignore_errors' => true,
    ]]);
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false) {
        throw new RuntimeException("HTTP error fetching: {$url}");
    }
    return $body;
}

function json_get(string $url, int $timeout = 30): array {
    $body = http_get($url, $timeout);
    $data = json_decode($body, true);
    if (!is_array($data)) {
        throw new RuntimeException("Respuesta no-JSON de {$url}: " . substr($body, 0, 150));
    }
    return $data;
}

/**
 * Calcula retorno mensual % a partir del ÚLTIMO valor de cada mes.
 *
 * @param array<string,float> $byMonth  ['YYYY-MM-01' => valor_fin_de_mes, ...]
 * @return array<int, array{month:string, value:float}>
 */
function monthly_returns(array $byMonth): array {
    ksort($byMonth);
    $result = [];
    $prev   = null;
    foreach ($byMonth as $month => $val) {
        if ($prev !== null && $prev > 0 && $val > 0) {
            $result[] = ['month' => $month, 'value' => round(($val / $prev - 1) * 100, 4)];
        }
        $prev = $val;
    }
    return $result;
}

/**
 * Último mes que debería estar publicado para el IPC.
 * El IPC de mes M se publica ~día 15 de M+1; antes del 15 se espera M-2.
 */
function ipc_expected_month(): string {
    $now  = new DateTimeImmutable();
    $back = (int)$now->format('j') >= 15 ? 1 : 2;
    return (new DateTimeImmutable($now->format('Y-m-01')))
        ->modify("-{$back} months")->format('Y-m-01');
}

// ── SQLite: abrir / crear ─────────────────────────────────────────────────────

$dataDir = dirname(SQLITE_FILE);
if (!is_dir($dataDir) && !mkdir($dataDir, 0775, true)) {
    fwrite(STDERR, "No se pudo crear: {$dataDir}\n");
    exit(1);
}

$db = new PDO('sqlite:' . SQLITE_FILE, null, null, [
    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
]);
$db->exec('PRAGMA journal_mode = DELETE');
$db->exec('PRAGMA synchronous  = NORMAL');

$db->exec(
    'CREATE TABLE IF NOT EXISTS market_daily (
        date   TEXT NOT NULL,
        symbol TEXT NOT NULL,
        compra REAL,
        venta  REAL,
        valor  REAL,
        moneda TEXT NOT NULL DEFAULT "ARS",
        PRIMARY KEY (date, symbol)
    )'
);
$db->exec(
    'CREATE TABLE IF NOT EXISTS exchange_rates (
        date        TEXT PRIMARY KEY,
        ars_per_usd REAL NOT NULL
    )'
);
$db->exec(
    'CREATE TABLE IF NOT EXISTS benchmarks (
        month          TEXT PRIMARY KEY,
        plazo_fijo_tna REAL,
        inflacion_ar   REAL,
        inflacion_us   REAL,
        uva            REAL,
        dolar_mep      REAL,
        spy            REAL,
        tlt            REAL,
        ief            REAL
    )'
);
$db->exec(
    'CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )'
);

out('Cartera Clara — standalone_update.php');
out('SQLite  : ' . SQLITE_FILE);
out('Dry-run : ' . ($dryRun ? 'YES' : 'no'));
out(str_repeat('=', 60));

// ── 1) market_daily: series diarias ──────────────────────────────────────────

$DAILY_SERIES = [
    'dolar_mep' => ['type' => 'argdatos_dolar', 'casa' => 'bolsa', 'moneda' => 'ARS'],
    'uva'       => ['type' => 'argdatos_uva',                       'moneda' => 'ARS'],
    'spy'       => ['type' => 'tiingo', 'symbol' => 'SPY',          'moneda' => 'USD'],
];

$stmtMarket = $db->prepare(
    'INSERT OR REPLACE INTO market_daily (date, symbol, compra, venta, valor, moneda)
     VALUES (?,?,?,?,?,?)'
);

foreach ($DAILY_SERIES as $symbol => $cfg) {
    out(PHP_EOL . "→ market_daily/{$symbol}");

    $stLast = $db->prepare('SELECT MAX(date) FROM market_daily WHERE symbol=?');
    $stLast->execute([$symbol]);
    $maxDate = $stLast->fetchColumn() ?: null;

    $from = $fromCli ?? ($maxDate
        ? (new DateTimeImmutable((string)$maxDate))->modify('-30 days')->format('Y-m-d')
        : BACKFILL_FROM);

    out("  Desde : {$from}  (último en BD: " . ($maxDate ?? 'ninguno') . ')');

    try {
        $rows = [];

        if ($cfg['type'] === 'argdatos_dolar') {
            $raw = json_get("https://api.argentinadatos.com/v1/cotizaciones/dolares/{$cfg['casa']}");
            foreach ($raw as $r) {
                $fecha = $r['fecha'] ?? '';
                $venta = (float)($r['venta'] ?? 0);
                if ($fecha < $from || $venta <= 0) continue;
                $rows[] = [
                    'date'   => $fecha,
                    'compra' => isset($r['compra']) && $r['compra'] > 0 ? (float)$r['compra'] : null,
                    'venta'  => $venta,
                    'valor'  => $venta,
                ];
            }
        } elseif ($cfg['type'] === 'argdatos_uva') {
            $raw = json_get('https://api.argentinadatos.com/v1/finanzas/indices/uva');
            foreach ($raw as $r) {
                $fecha = $r['fecha'] ?? '';
                $valor = (float)($r['valor'] ?? 0);
                if ($fecha < $from || $valor <= 0) continue;
                $rows[] = ['date' => $fecha, 'compra' => null, 'venta' => null, 'valor' => $valor];
            }
        } elseif ($cfg['type'] === 'tiingo') {
            if (!TIINGO_KEY) { out('  SKIP: TIINGO_API_KEY no configurada.'); continue; }
            $url = "https://api.tiingo.com/tiingo/daily/{$cfg['symbol']}/prices"
                 . "?startDate={$from}&token=" . TIINGO_KEY;
            $raw = json_get($url, 30);
            foreach ($raw as $r) {
                $valor = (float)($r['adjClose'] ?? $r['close'] ?? 0);
                if (!isset($r['date']) || $valor <= 0) continue;
                $rows[] = [
                    'date' => substr($r['date'], 0, 10), 'compra' => null, 'venta' => null,
                    'valor' => round($valor, 4),
                ];
            }
        }

        out("  Registros de API: " . count($rows));
        if ($dryRun) { out('  DRY-RUN: no se escribe.'); continue; }

        // Cargar existentes del período para detectar cambios sin consulta por fila
        $stExist = $db->prepare('SELECT date, valor FROM market_daily WHERE symbol=? AND date>=?');
        $stExist->execute([$symbol, $from]);
        $existing = array_column($stExist->fetchAll(), 'valor', 'date');

        $inserted = 0; $updated = 0;
        $db->beginTransaction();
        foreach ($rows as $r) {
            if (isset($existing[$r['date']]) && abs((float)$existing[$r['date']] - $r['valor']) < 0.0001) {
                continue;
            }
            $isNew = !isset($existing[$r['date']]);
            $stmtMarket->execute([$r['date'], $symbol, $r['compra'], $r['venta'], $r['valor'], $cfg['moneda']]);
            $isNew ? $inserted++ : $updated++;
            if ($verbose) out("    {$r['date']}: valor={$r['valor']}");
        }
        $db->commit();
        out("  inserted={$inserted}  updated={$updated}");

    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        $errors[] = "market_daily/{$symbol}: " . $e->getMessage();
        out('  ERROR: ' . $e->getMessage());
    }
}

// ── 2) exchange_rates: dólar MEP venta desde market_daily ────────────────────

out(PHP_EOL . '→ exchange_rates (desde market_daily/dolar_mep)');

if (!$dryRun) {
    $affected = $db->exec(
        "INSERT OR REPLACE INTO exchange_rates (date, ars_per_usd)
         SELECT date, venta FROM market_daily
         WHERE symbol='dolar_mep' AND venta IS NOT NULL AND venta > 0"
    );
    out("  Filas upserted: {$affected}");
} else {
    $cnt = $db->query("SELECT COUNT(*) FROM market_daily WHERE symbol='dolar_mep' AND venta>0")->fetchColumn();
    out("  DRY-RUN: {$cnt} filas disponibles.");
}

// ── 3) benchmarks: retornos mensuales desde market_daily (MEP · UVA · SPY) ──

$LOCAL_BM = ['dolar_mep' => 'dolar_mep', 'uva' => 'uva', 'spy' => 'spy'];

foreach ($LOCAL_BM as $symbol => $field) {
    out(PHP_EOL . "→ benchmarks/{$field} (desde market_daily/{$symbol})");

    // Un mes extra antes del backfill para calcular el retorno del primer mes
    $prevFrom = (new DateTimeImmutable(BACKFILL_FROM))->modify('-1 month')->format('Y-m-d');

    $st = $db->prepare(
        "SELECT strftime('%Y-%m-01', date) AS m, valor
         FROM market_daily WHERE symbol=? AND valor>0 AND date>=?
         ORDER BY date ASC"
    );
    $st->execute([$symbol, $prevFrom]);

    $byMonth = [];
    while ($r = $st->fetch()) {
        $byMonth[$r['m']] = (float)$r['valor']; // ORDER BY ASC → queda el último del mes
    }

    if (count($byMonth) < 2) {
        out("  SKIP: datos insuficientes (se necesita al menos 2 meses en market_daily).");
        continue;
    }

    $returns = monthly_returns($byMonth);
    out("  Retornos calculados: " . count($returns));
    if ($dryRun) { out('  DRY-RUN: no se escribe.'); continue; }

    $stmt = $db->prepare(
        "INSERT INTO benchmarks (month, {$field}) VALUES (?,?)
         ON CONFLICT(month) DO UPDATE SET {$field}=excluded.{$field}"
    );
    $cnt = 0;
    foreach ($returns as $row) {
        $stmt->execute([$row['month'], $row['value']]);
        $cnt++;
    }
    out("  Upserted: {$cnt}");
}

// ── 4) benchmarks: campos que vienen de APIs externas ────────────────────────

// 4a) Inflación AR — ArgentinaDatos IPC INDEC
out(PHP_EOL . '→ benchmarks/inflacion_ar (ArgentinaDatos IPC)');
try {
    $expected = ipc_expected_month();
    $have     = $db->query(
        "SELECT MAX(month) FROM benchmarks WHERE inflacion_ar IS NOT NULL AND inflacion_ar != 0"
    )->fetchColumn();

    out("  Último en BD: " . ($have ?: 'ninguno') . "  · esperado publicado: {$expected}");

    if (!$dryRun && ($have === null || (string)$have < $expected)) {
        $raw  = json_get('https://api.argentinadatos.com/v1/finanzas/indices/inflacion');
        $stmt = $db->prepare(
            "INSERT INTO benchmarks (month, inflacion_ar) VALUES (?,?)
             ON CONFLICT(month) DO UPDATE SET inflacion_ar=excluded.inflacion_ar"
        );
        $cnt = 0;
        foreach ($raw as $r) {
            $month = $r['fecha'] ?? '';
            $valor = isset($r['valor']) ? (float)$r['valor'] : null;
            if (!$month || $valor === null || $month < BACKFILL_FROM) continue;
            // Normalizar: el endpoint puede devolver YYYY-MM-DD o YYYY-MM-01
            $month = substr($month, 0, 7) . '-01';
            $stmt->execute([$month, $valor]);
            $cnt++;
        }
        out("  Upserted: {$cnt}");
    } elseif ($dryRun) {
        out('  DRY-RUN.');
    } else {
        out('  OK: al día.');
    }
} catch (Throwable $e) {
    $errors[] = "inflacion_ar: " . $e->getMessage();
    out('  ERROR: ' . $e->getMessage());
}

// 4b) Inflación US — FRED CPIAUCSL
out(PHP_EOL . '→ benchmarks/inflacion_us (FRED CPIAUCSL)');
if (!FRED_KEY) {
    out('  SKIP: FRED_API_KEY no configurada.');
} else {
    try {
        $expected = ipc_expected_month();
        $have     = $db->query(
            "SELECT MAX(month) FROM benchmarks WHERE inflacion_us IS NOT NULL AND inflacion_us != 0"
        )->fetchColumn();

        out("  Último en BD: " . ($have ?: 'ninguno') . "  · esperado publicado: {$expected}");

        if (!$dryRun && ($have === null || (string)$have < $expected)) {
            $url  = 'https://api.stlouisfed.org/fred/series/observations'
                  . '?series_id=CPIAUCSL&file_type=json&observation_start=' . BACKFILL_FROM
                  . '&api_key=' . FRED_KEY;
            $resp = json_get($url);
            $obs  = $resp['observations'] ?? [];

            // Construir serie mensual de índice CPI
            $cpiByMonth = [];
            foreach ($obs as $o) {
                $date = $o['date'] ?? '';
                $val  = $o['value'] ?? '.';
                if ($val === '.' || !$date) continue;
                $cpiByMonth[substr($date, 0, 7) . '-01'] = (float)$val;
            }

            $returns = monthly_returns($cpiByMonth);
            $stmt    = $db->prepare(
                "INSERT INTO benchmarks (month, inflacion_us) VALUES (?,?)
                 ON CONFLICT(month) DO UPDATE SET inflacion_us=excluded.inflacion_us"
            );
            $cnt = 0;
            foreach ($returns as $row) {
                if ($row['month'] < BACKFILL_FROM) continue;
                $stmt->execute([$row['month'], $row['value']]);
                $cnt++;
            }
            out("  Upserted: {$cnt}");
        } elseif ($dryRun) {
            out('  DRY-RUN.');
        } else {
            out('  OK: al día.');
        }
    } catch (Throwable $e) {
        $errors[] = "inflacion_us: " . $e->getMessage();
        out('  ERROR: ' . $e->getMessage());
    }
}

// 4c) Plazo fijo TNA — ArgentinaDatos depósitos 30 días (promedio mensual)
out(PHP_EOL . '→ benchmarks/plazo_fijo_tna (ArgentinaDatos depósitos 30 días)');
try {
    $curMonth = (new DateTimeImmutable())->format('Y-m-01');
    $have     = $db->query(
        "SELECT MAX(month) FROM benchmarks WHERE plazo_fijo_tna IS NOT NULL AND plazo_fijo_tna != 0"
    )->fetchColumn();

    out("  Último en BD: " . ($have ?: 'ninguno') . "  · esperado: {$curMonth}");

    if (!$dryRun && ($have === null || (string)$have < $curMonth)) {
        $raw = json_get('https://api.argentinadatos.com/v1/finanzas/tasas/depositos30Dias');

        $sumByMonth = [];
        $cntByMonth = [];
        foreach ($raw as $r) {
            $fecha = $r['fecha'] ?? '';
            $valor = isset($r['valor']) ? (float)$r['valor'] : 0;
            if (!$fecha || $fecha < BACKFILL_FROM || $valor <= 0) continue;
            $month = substr($fecha, 0, 7) . '-01';
            $sumByMonth[$month] = ($sumByMonth[$month] ?? 0.0) + $valor;
            $cntByMonth[$month] = ($cntByMonth[$month] ?? 0) + 1;
        }

        $stmt = $db->prepare(
            "INSERT INTO benchmarks (month, plazo_fijo_tna) VALUES (?,?)
             ON CONFLICT(month) DO UPDATE SET plazo_fijo_tna=excluded.plazo_fijo_tna"
        );
        $cnt = 0;
        foreach ($sumByMonth as $month => $sum) {
            $avg = round($sum / $cntByMonth[$month], 4);
            $stmt->execute([$month, $avg]);
            $cnt++;
        }
        out("  Upserted: {$cnt}");
    } elseif ($dryRun) {
        out('  DRY-RUN.');
    } else {
        out('  OK: al día.');
    }
} catch (Throwable $e) {
    $errors[] = "plazo_fijo_tna: " . $e->getMessage();
    out('  ERROR: ' . $e->getMessage());
}

// 4d) TLT / IEF — Tiingo mensual (retorno % mes cerrado)
foreach (['TLT' => 'tlt', 'IEF' => 'ief'] as $ticker => $field) {
    out(PHP_EOL . "→ benchmarks/{$field} (Tiingo/{$ticker} mensual)");

    if (!TIINGO_KEY) { out('  SKIP: TIINGO_API_KEY no configurada.'); continue; }

    try {
        $prevMonth = (new DateTimeImmutable())->modify('-1 month')->format('Y-m-01');
        $have      = $db->query(
            "SELECT MAX(month) FROM benchmarks WHERE {$field} IS NOT NULL"
        )->fetchColumn();

        out("  Último en BD: " . ($have ?: 'ninguno') . "  · esperado: {$prevMonth}");

        if (!$dryRun && ($have === null || (string)$have < $prevMonth)) {
            // Traer desde 1 mes antes del último registrado para poder calcular el retorno
            $fetchFrom = $have
                ? (new DateTimeImmutable((string)$have))->modify('-1 month')->format('Y-m-d')
                : BACKFILL_FROM;

            $url = "https://api.tiingo.com/tiingo/daily/{$ticker}/prices"
                 . "?startDate={$fetchFrom}&resampleFreq=monthly&token=" . TIINGO_KEY;
            $raw = json_get($url, 30);

            $byMonth = [];
            foreach ($raw as $r) {
                $adjClose = (float)($r['adjClose'] ?? $r['close'] ?? 0);
                if (!isset($r['date']) || $adjClose <= 0) continue;
                $month           = substr($r['date'], 0, 7) . '-01';
                $byMonth[$month] = round($adjClose, 4);
            }

            $returns = monthly_returns($byMonth);
            $stmt    = $db->prepare(
                "INSERT INTO benchmarks (month, {$field}) VALUES (?,?)
                 ON CONFLICT(month) DO UPDATE SET {$field}=excluded.{$field}"
            );
            $cnt = 0;
            foreach ($returns as $row) {
                if ($row['month'] < BACKFILL_FROM) continue;
                $stmt->execute([$row['month'], $row['value']]);
                $cnt++;
            }
            out("  Upserted: {$cnt}");
        } elseif ($dryRun) {
            out('  DRY-RUN.');
        } else {
            out('  OK: al día.');
        }
    } catch (Throwable $e) {
        $errors[] = "{$field}: " . $e->getMessage();
        out('  ERROR: ' . $e->getMessage());
    }
}

// ── 5) meta ───────────────────────────────────────────────────────────────────

if (!$dryRun) {
    $rateCount = (int)$db->query("SELECT COUNT(*) FROM exchange_rates")->fetchColumn();
    $bmCount   = (int)$db->query("SELECT COUNT(*) FROM benchmarks")->fetchColumn();

    $stmtMeta = $db->prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)');
    foreach ([
        'generated_at'        => gmdate('c'),
        'exchange_rate_count' => (string)$rateCount,
        'benchmark_count'     => (string)$bmCount,
        'errors'              => empty($errors) ? '0' : implode('; ', $errors),
    ] as $k => $v) {
        $stmtMeta->execute([$k, $v]);
    }
}

// ── Resumen ───────────────────────────────────────────────────────────────────

out(PHP_EOL . str_repeat('=', 60));
out('exchange_rates : ' . $db->query("SELECT COUNT(*) FROM exchange_rates")->fetchColumn() . ' filas');
out('benchmarks     : ' . $db->query("SELECT COUNT(*) FROM benchmarks")->fetchColumn()   . ' filas');
out('market_daily   : ' . $db->query("SELECT COUNT(*) FROM market_daily")->fetchColumn() . ' filas');

if ($errors) {
    out(PHP_EOL . 'ERRORES (' . count($errors) . '):');
    foreach ($errors as $err) out('  - ' . $err);
}

$success = empty($errors);
out(PHP_EOL . ($success ? 'OK — sin errores.' : 'Terminado con errores (ver arriba).'));

exit($success ? 0 : 1);
