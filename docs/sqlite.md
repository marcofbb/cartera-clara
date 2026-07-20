# SQLite de mercado

La aplicacion lee datos de mercado desde `data/cartera_v4.sqlite`. Ese archivo es publico: se copia a `dist/data/cartera_v4.sqlite` y se descarga desde el navegador con `fetch`.

El generador privado `build_sqlite.php` no debe publicarse. Esta en `.gitignore` y el build publico se verifica con `npm run verify:public`.

## Como se usa en el frontend

`src/js/calc.js` carga:

```js
const DB_URL = "data/cartera_v4.sqlite";
```

Luego inicializa `sql.js`, descarga el SQLite y ejecuta consultas locales en el navegador.

El archivo se pide con cache busting (`?t=...`) y `cache: "no-store"` para evitar datos viejos durante el uso.

## Tablas

### exchange_rates

Tipos de cambio diarios.

```sql
CREATE TABLE exchange_rates (
  date TEXT PRIMARY KEY,
  ars_per_usd REAL NOT NULL
);
```

Columnas:

- `date`: fecha ISO `YYYY-MM-DD`.
- `ars_per_usd`: pesos argentinos por 1 USD MEP.

Uso:

- Conversion de movimientos y snapshots entre ARS y USD.
- Benchmark de Dolar MEP por variacion diaria.

Para una fecha dada, la app busca el ultimo tipo de cambio disponible menor o igual a esa fecha:

```sql
SELECT ars_per_usd
FROM exchange_rates
WHERE date <= ?
ORDER BY date DESC
LIMIT 1;
```

Si no encuentra ningun valor anterior, usa el primer valor disponible como fallback.

### benchmarks

Rendimientos mensuales y tasas publicadas.

```sql
CREATE TABLE benchmarks (
  month TEXT PRIMARY KEY,
  plazo_fijo_tna REAL,
  inflacion_ar REAL,
  inflacion_us REAL,
  uva REAL,
  dolar_mep REAL,
  spy REAL,
  tlt REAL,
  ief REAL
);
```

Columnas:

- `month`: primer dia del mes, en formato `YYYY-MM-01`.
- `plazo_fijo_tna`: TNA mensual publicada, expresada como porcentaje. Ejemplo: `110` significa 110%.
- `inflacion_ar`: inflacion Argentina mensual, como porcentaje.
- `inflacion_us`: inflacion Estados Unidos mensual, como porcentaje.
- `uva`: rendimiento mensual UVA, como porcentaje.
- `dolar_mep`: rendimiento mensual Dolar MEP, como porcentaje.
- `spy`: rendimiento mensual SPY, como porcentaje.
- `tlt`: rendimiento mensual TLT, como porcentaje.
- `ief`: rendimiento mensual IEF, como porcentaje.

Uso:

- `plazo_fijo_tna` se prorratea por dias: `TNA * dias_activos / 365`.
- `uva`, `spy`, `tlt` e `ief` se acumulan como rendimiento mensual ponderado por dias activos.
- `dolar_mep` mensual existe en la tabla, pero el resultado de Dolar MEP se reemplaza por la variacion diaria calculada desde `exchange_rates` cuando hay datos suficientes.

Los valores se guardan como porcentajes, no como decimales. La app divide por `100` antes de calcular.

### meta

Metadata del archivo generado.

```sql
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Claves generadas hoy:

- `generated_at`: fecha y hora UTC de generacion.
- `source_db`: nombre de la base fuente usada por el generador.
- `exchange_rate_count`: cantidad de filas de `exchange_rates`.
- `benchmark_count`: cantidad de filas de `benchmarks`.

Como `meta` tambien es publico, no debe contener secretos ni nombres sensibles.

## Generacion del archivo

`build_sqlite.php` lee una base MySQL y genera `data/cartera_v4.sqlite`.

Variables de entorno soportadas:

- `V4_DB_HOST`, default `127.0.0.1`.
- `V4_DB_PORT`, default vacio.
- `V4_DB_NAME`, default `carterav3`.
- `V4_DB_USER`, default `root`.
- `V4_DB_PASS`, default `root`.
- `V4_DB_CHARSET`, default `utf8mb4`.

Ejemplo local:

```bash
V4_DB_HOST=127.0.0.1 \
V4_DB_NAME=carterav3 \
V4_DB_USER=root \
V4_DB_PASS=root \
php build_sqlite.php
```

Despues de regenerar:

```bash
npm run build
npm run verify:public
```

Si `dist/` existe al correr el PHP, el script tambien copia el SQLite a `dist/data/cartera_v4.sqlite`.

## Reglas de calidad de datos

- `exchange_rates.ars_per_usd` debe ser mayor a `0`.
- Las fechas deben estar normalizadas como texto ISO.
- `benchmarks.month` debe ser siempre el primer dia del mes.
- Los rendimientos mensuales deben ser porcentajes, no factores.
- Los valores faltantes pueden quedar en `NULL`; la app los omite para ese benchmark.
- El mes corriente no se usa para benchmarks mensuales si todavia no esta cerrado.

## Seguridad

`data/cartera_v4.sqlite` esta pensado para ser publico. No debe incluir credenciales, datos de usuarios, cuentas personales, movimientos privados ni informacion interna sensible.

`build_sqlite.php` contiene detalles de conexion y logica de extraccion desde MySQL. Debe quedarse local:

- Esta ignorado en `.gitignore`.
- No se agrega al repo.
- No se copia a `dist/`.
- El workflow falla si aparece en el artefacto publico.

