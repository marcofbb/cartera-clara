import { calculatePortfolio, loadMarketDb, marketRateAt, queryMarketRows } from "./calc.js";
import { cleanMovements, daysInMonth, isIsoDate, normalizeSnapshot, todayIso } from "./utils.js";

const STYLE = {
  normal: 0,
  title: 1,
  subtitle: 2,
  header: 3,
  label: 4,
  date: 5,
  integer: 6,
  amount: 7,
  percent: 8,
  rate: 9,
  muted: 10,
  pp: 11
};

export async function exportPortfolioExcel(portfolio) {
  if (!window.JSZip) {
    throw new Error("No se pudo cargar JSZip para generar el Excel.");
  }

  const db = await loadMarketDb();
  const periods = await buildResultPeriods(portfolio);
  const sheets = [
    buildResumenSheet(portfolio, periods),
    buildResultadosSheet(periods),
    buildMovementsSheet(db, portfolio),
    buildSnapshotsSheet(db, portfolio),
    buildBenchmarksSheet(db, periods)
  ];

  const blob = await buildWorkbook(sheets);
  downloadBlob(blob, `cartera-v4-${slug(portfolio.portfolio_name)}-${todayIso()}.xlsx`);
}

async function buildResultPeriods(portfolio) {
  const periods = annualAndYtdPeriods(portfolio);
  const rows = [];

  for (const period of periods) {
    const result = await calculatePortfolio(portfolioForPeriod(portfolio, period));
    const benchmarkMap = Object.fromEntries(result.benchmarks.map((item) => [item.id, item.return]));
    rows.push({
      ...period,
      result,
      benchmarkMap,
      warnings: result.warnings || []
    });
  }

  return rows;
}

function buildResumenSheet(portfolio, periods) {
  const years = periods.map((period) => period.year);
  const defaultYear = years.includes(Number(todayIso().slice(0, 4))) ? Number(todayIso().slice(0, 4)) : years.at(-1);
  const lastResultRow = Math.max(2, periods.length + 1);
  const resultFormula = (col) => `IFERROR(INDEX('Resultados'!$${col}$2:$${col}$${lastResultRow},MATCH($B$4,'Resultados'!$A$2:$A$${lastResultRow},0)),"Sin datos")`;
  const resultNumberFormula = (col) => `IFERROR(INDEX('Resultados'!$${col}$2:$${col}$${lastResultRow},MATCH($B$4,'Resultados'!$A$2:$A$${lastResultRow},0)),"")`;
  const benchmarkRows = [
    ["Dólar MEP", "ARS", "W", "H"],
    ["Plazo fijo", "ARS", "X", "H"],
    ["UVA", "ARS", "Y", "H"],
    ["SPY", "USD", "Z", "P"],
    ["TLT", "USD", "AA", "P"],
    ["IEF", "USD", "AB", "P"]
  ];

  const rows = [
    [s("Resumen de cartera", STYLE.title)],
    [s("Cartera", STYLE.label), s(portfolio.portfolio_name || "Cartera")],
    [s("Generado", STYLE.label), s(new Date().toLocaleString("es-AR"))],
    [s("Año editable", STYLE.label), n(defaultYear || "", STYLE.integer), s("Cambiá este valor para ver otro año con snapshots.", STYLE.subtitle)],
    [],
    [s("Métrica", STYLE.header), s("Valor", STYLE.header), s("Detalle", STYLE.header)],
    [s("Periodo", STYLE.label), f(resultFormula("B"), STYLE.normal, "str"), s("El resultado se busca en la hoja Resultados.", STYLE.subtitle)],
    [s("Desde", STYLE.label), f(resultNumberFormula("C"), STYLE.date)],
    [s("Hasta", STYLE.label), f(resultNumberFormula("D"), STYLE.date)],
    [s("Benchmark hasta", STYLE.label), f(resultNumberFormula("F"), STYLE.date), s("Usa la última fecha efectiva del snapshot del período.", STYLE.subtitle)],
    [s("XIRR periodo ARS", STYLE.label), f(resultNumberFormula("H"), STYLE.percent)],
    [s("Modified Dietz ARS", STYLE.label), f(resultNumberFormula("G"), STYLE.percent)],
    [s("XIRR periodo USD", STYLE.label), f(resultNumberFormula("P"), STYLE.percent)],
    [s("Modified Dietz USD", STYLE.label), f(resultNumberFormula("O"), STYLE.percent)],
    [s("Valor final ARS", STYLE.label), f(resultNumberFormula("K"), STYLE.integer)],
    [s("Valor final USD", STYLE.label), f(resultNumberFormula("S"), STYLE.amount)],
    [],
    [s("Benchmark", STYLE.header), s("Rendimiento", STYLE.header), s("Diferencia vs cartera (pp)", STYLE.header)]
  ];

  benchmarkRows.forEach(([label, group, benchmarkCol, portfolioCol]) => {
    rows.push([
      s(`${label} (${group})`),
      f(resultNumberFormula(benchmarkCol), STYLE.percent),
      f(`IFERROR((INDEX('Resultados'!$${portfolioCol}$2:$${portfolioCol}$${lastResultRow},MATCH($B$4,'Resultados'!$A$2:$A$${lastResultRow},0))-INDEX('Resultados'!$${benchmarkCol}$2:$${benchmarkCol}$${lastResultRow},MATCH($B$4,'Resultados'!$A$2:$A$${lastResultRow},0)))*100,"")`, STYLE.pp)
    ]);
  });

  if (!periods.length) {
    rows.push([], [s("Sin resultados anuales", STYLE.label), s("Cargá snapshots suficientes para calcular años completos.")]);
  }

  return {
    name: "Resumen",
    rows,
    cols: [28, 18, 54],
    validations: years.length ? [{
      sqref: "B4",
      formula: `"${years.join(",")}"`
    }] : []
  };
}

function buildResultadosSheet(periods) {
  const rows = [[
    s("Año", STYLE.header),
    s("Periodo", STYLE.header),
    s("Desde", STYLE.header),
    s("Hasta", STYLE.header),
    s("Benchmark desde", STYLE.header),
    s("Benchmark hasta", STYLE.header),
    s("Modified Dietz ARS", STYLE.header),
    s("XIRR periodo ARS", STYLE.header),
    s("XIRR anual ARS", STYLE.header),
    s("Valor inicial ARS", STYLE.header),
    s("Valor final ARS", STYLE.header),
    s("Aportes ARS", STYLE.header),
    s("Retiros ARS", STYLE.header),
    s("Ganancia neta ARS", STYLE.header),
    s("Modified Dietz USD", STYLE.header),
    s("XIRR periodo USD", STYLE.header),
    s("XIRR anual USD", STYLE.header),
    s("Valor inicial USD", STYLE.header),
    s("Valor final USD", STYLE.header),
    s("Aportes USD", STYLE.header),
    s("Retiros USD", STYLE.header),
    s("Ganancia neta USD", STYLE.header),
    s("Dólar MEP", STYLE.header),
    s("Plazo fijo", STYLE.header),
    s("UVA", STYLE.header),
    s("SPY", STYLE.header),
    s("TLT", STYLE.header),
    s("IEF", STYLE.header),
    s("Alertas", STYLE.header)
  ]];

  periods.forEach((period) => {
    const ars = period.result.results.ARS || {};
    const usd = period.result.results.USD || {};
    rows.push([
      n(period.year, STYLE.integer),
      s(period.label),
      d(period.from),
      d(period.toEffective || period.to),
      d(period.benchmarkStart),
      d(period.benchmarkEnd),
      n(ars.rendimiento, STYLE.percent),
      n(period.result.xirr.ARS?.period, STYLE.percent),
      n(period.result.xirr.ARS?.annual, STYLE.percent),
      n(ars.bmv, STYLE.integer),
      n(ars.emv, STYLE.integer),
      n(ars.aportes, STYLE.integer),
      n(ars.retiros, STYLE.integer),
      n(ars.ganancia_neta, STYLE.integer),
      n(usd.rendimiento, STYLE.percent),
      n(period.result.xirr.USD?.period, STYLE.percent),
      n(period.result.xirr.USD?.annual, STYLE.percent),
      n(usd.bmv, STYLE.amount),
      n(usd.emv, STYLE.amount),
      n(usd.aportes, STYLE.amount),
      n(usd.retiros, STYLE.amount),
      n(usd.ganancia_neta, STYLE.amount),
      n(period.benchmarkMap.dolar_mep, STYLE.percent),
      n(period.benchmarkMap.plazo_fijo, STYLE.percent),
      n(period.benchmarkMap.uva, STYLE.percent),
      n(period.benchmarkMap.spy, STYLE.percent),
      n(period.benchmarkMap.tlt, STYLE.percent),
      n(period.benchmarkMap.ief, STYLE.percent),
      s(period.warnings.join(" | "))
    ]);
  });

  return {
    name: "Resultados",
    rows,
    cols: [10, 16, 13, 13, 16, 16, 18, 18, 18, 18, 18, 16, 16, 18, 18, 18, 18, 18, 18, 16, 16, 18, 13, 13, 13, 13, 13, 13, 42],
    autoFilter: `A1:AC${Math.max(1, rows.length)}`
  };
}

function buildMovementsSheet(db, portfolio) {
  const warnings = [];
  const rows = [[
    s("ID", STYLE.header),
    s("Fecha", STYLE.header),
    s("Tipo", STYLE.header),
    s("Moneda original", STYLE.header),
    s("Monto original", STYLE.header),
    s("Tasa cambio ARS/USD", STYLE.header),
    s("Monto ARS", STYLE.header),
    s("Monto USD", STYLE.header),
    s("Flujo ARS", STYLE.header),
    s("Flujo USD", STYLE.header)
  ]];

  cleanMovements(portfolio.movements).forEach((movement, index) => {
    const rate = marketRateAt(db, movement.date, warnings);
    const amountArs = convertAmount(movement.monto, movement.moneda, "ARS", rate);
    const amountUsd = convertAmount(movement.monto, movement.moneda, "USD", rate);
    const sign = movement.tipo === "ingreso" ? 1 : -1;
    rows.push([
      n(index + 1, STYLE.integer),
      d(movement.date),
      s(movement.tipo),
      s(movement.moneda),
      n(movement.monto, movement.moneda === "ARS" ? STYLE.integer : STYLE.amount),
      n(rate, STYLE.rate),
      n(amountArs, STYLE.integer),
      n(amountUsd, STYLE.amount),
      n(amountArs === null ? null : amountArs * sign, STYLE.integer),
      n(amountUsd === null ? null : amountUsd * sign, STYLE.amount)
    ]);
  });

  return {
    name: "Movimientos",
    rows,
    cols: [8, 13, 12, 18, 18, 22, 18, 18, 18, 18],
    autoFilter: `A1:J${Math.max(1, rows.length)}`
  };
}

function buildSnapshotsSheet(db, portfolio) {
  const warnings = [];
  const rows = [[
    s("ID", STYLE.header),
    s("Fecha", STYLE.header),
    s("Momento", STYLE.header),
    s("Etiqueta", STYLE.header),
    s("Moneda original", STYLE.header),
    s("Valor original", STYLE.header),
    s("Tasa cambio ARS/USD", STYLE.header),
    s("Valor ARS", STYLE.header),
    s("Valor USD", STYLE.header)
  ]];

  snapshotOptions(portfolio).forEach((snapshot, index) => {
    const rate = marketRateAt(db, snapshot.date, warnings);
    const valueArs = convertAmount(Number(snapshot.amount), snapshot.currency, "ARS", rate);
    const valueUsd = convertAmount(Number(snapshot.amount), snapshot.currency, "USD", rate);
    rows.push([
      n(index + 1, STYLE.integer),
      d(snapshot.date),
      s(snapshot.timing === "start_day" ? "Inicio del día" : "Cierre del día"),
      s(snapshot.label),
      s(snapshot.currency),
      n(Number(snapshot.amount), snapshot.currency === "ARS" ? STYLE.integer : STYLE.amount),
      n(rate, STYLE.rate),
      n(valueArs, STYLE.integer),
      n(valueUsd, STYLE.amount)
    ]);
  });

  return {
    name: "Snapshots",
    rows,
    cols: [8, 13, 16, 24, 18, 18, 22, 18, 18],
    autoFilter: `A1:I${Math.max(1, rows.length)}`
  };
}

function buildBenchmarksSheet(db, periods) {
  const rows = [[
    s("Mes", STYLE.header),
    s("Plazo fijo TNA", STYLE.header),
    s("Plazo fijo mensual usado", STYLE.header),
    s("UVA", STYLE.header),
    s("Dólar MEP mensual DB", STYLE.header),
    s("SPY", STYLE.header),
    s("TLT", STYLE.header),
    s("IEF", STYLE.header),
    s("Inflación AR", STYLE.header),
    s("Inflación US", STYLE.header)
  ]];

  const start = minIso(periods.map((period) => period.benchmarkStart));
  const end = maxIso(periods.map((period) => publishedBenchmarkEndMonth(period.benchmarkEnd)));
  const benchmarkRows = start && end && start <= end
    ? queryMarketRows(
      db,
      "SELECT month, plazo_fijo_tna, inflacion_ar, inflacion_us, uva, dolar_mep, spy, tlt, ief FROM benchmarks WHERE month >= ? AND month <= ? ORDER BY month ASC",
      [`${start.slice(0, 7)}-01`, `${end.slice(0, 7)}-01`]
    )
    : [];

  benchmarkRows.forEach((row) => {
    const tna = percentFromDb(row.plazo_fijo_tna);
    rows.push([
      d(row.month),
      n(tna, STYLE.percent),
      n(tna === null ? null : tna * daysInMonth(row.month) / 365, STYLE.percent),
      n(percentFromDb(row.uva), STYLE.percent),
      n(percentFromDb(row.dolar_mep), STYLE.percent),
      n(percentFromDb(row.spy), STYLE.percent),
      n(percentFromDb(row.tlt), STYLE.percent),
      n(percentFromDb(row.ief), STYLE.percent),
      n(percentFromDb(row.inflacion_ar), STYLE.percent),
      n(percentFromDb(row.inflacion_us), STYLE.percent)
    ]);
  });

  rows.push(
    [],
    [s("Nota", STYLE.label), s("Los resultados usan todos los benchmarks por defecto. Dólar MEP se calcula con exchange_rates diarios para las fechas exactas de inicio y fin.", STYLE.subtitle)]
  );

  return {
    name: "Benchmarks",
    rows,
    cols: [13, 17, 24, 12, 20, 12, 12, 12, 15, 15],
    autoFilter: benchmarkRows.length ? `A1:J${benchmarkRows.length + 1}` : ""
  };
}

function annualAndYtdPeriods(portfolio) {
  const snapshots = snapshotOptions(portfolio);
  const currentYear = Number(todayIso().slice(0, 4));
  const years = Array.from(new Set(snapshots.flatMap((snapshot) => {
    const year = Number(snapshot.date.slice(0, 4));
    return [year, year + 1];
  }))).sort((a, b) => a - b);
  const periods = [];

  years.forEach((year) => {
    const startContext = startContextForYear(snapshots, year);
    const start = startContext?.snapshot || null;
    const end = endBoundaryForYear(snapshots, year);
    if (!start || !end || snapshotCompare(start, end) >= 0) return;
    periods.push({
      mode: "year",
      year,
      label: `Año ${year}${startContext.partial ? " (parcial)" : ""}`,
      from: start.date,
      fromTiming: start.timing,
      to: end.date,
      toTiming: end.timing,
      toEffective: effectiveEndDate(end),
      benchmarkStart: startContext.benchmarkStart,
      benchmarkEnd: `${year}-12-31`
    });
  });

  return periods.sort((a, b) => a.year - b.year);
}

function portfolioForPeriod(portfolio, period) {
  const startBound = { date: period.from, timing: period.fromTiming || "end_day" };
  const endBound = { date: period.to, timing: period.toTiming || "end_day" };
  return {
    ...portfolio,
    benchmark_start: period.benchmarkStart,
    benchmark_end: period.benchmarkEnd,
    snapshots: snapshotOptions(portfolio).filter((snapshot) => snapshotCompare(snapshot, startBound) >= 0 && snapshotCompare(snapshot, endBound) <= 0)
  };
}

function snapshotOptions(portfolio) {
  return (portfolio.snapshots || [])
    .map(normalizeSnapshot)
    .filter((snapshot) => isIsoDate(snapshot.date) && Number.isFinite(Number(snapshot.amount)))
    .sort(snapshotCompare);
}

function snapshotCompare(a, b) {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  const order = { start_day: 0, end_day: 1 };
  return (order[a.timing] ?? 1) - (order[b.timing] ?? 1);
}

function startBoundaryForYear(snapshots, year) {
  const prevClose = `${year - 1}-12-31`;
  const yearStart = `${year}-01-01`;
  return snapshots.find((snapshot) => snapshot.date === prevClose && snapshot.timing === "end_day")
    || snapshots.find((snapshot) => snapshot.date === yearStart && snapshot.timing === "start_day")
    || null;
}

function firstSnapshotInYear(snapshots, year) {
  const prefix = `${year}-`;
  return snapshots.find((snapshot) => snapshot.date.startsWith(prefix)) || null;
}

function startContextForYear(snapshots, year) {
  const boundary = startBoundaryForYear(snapshots, year);
  if (boundary) {
    return {
      snapshot: boundary,
      benchmarkStart: `${year}-01-01`,
      partial: false
    };
  }

  const first = firstSnapshotInYear(snapshots, year);
  if (!first) return null;
  return {
    snapshot: first,
    benchmarkStart: first.date,
    partial: true
  };
}

function endBoundaryForYear(snapshots, year) {
  const yearClose = `${year}-12-31`;
  const nextStart = `${year + 1}-01-01`;
  return snapshots.find((snapshot) => snapshot.date === yearClose && snapshot.timing === "end_day")
    || snapshots.find((snapshot) => snapshot.date === nextStart && snapshot.timing === "start_day")
    || null;
}

function latestSnapshotUntilToday(snapshots) {
  const today = todayIso();
  return snapshots.filter((snapshot) => snapshot.date <= today).at(-1) || null;
}

function effectiveEndDate(snapshot) {
  if (!snapshot) return "";
  return snapshot.timing === "start_day" ? addDaysIso(snapshot.date, -1) : snapshot.date;
}

function addDaysIso(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function convertAmount(amount, currency, display, rate) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return null;
  if (currency === display) return value;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return display === "USD" ? value / rate : value * rate;
}

function percentFromDb(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num / 100 : null;
}

function publishedBenchmarkEndMonth(end) {
  if (!isIsoDate(end)) return "";
  const currentMonth = `${todayIso().slice(0, 7)}-01`;
  const endMonth = `${end.slice(0, 7)}-01`;
  return endMonth >= currentMonth ? previousMonth(currentMonth) : endMonth;
}

function previousMonth(monthIso) {
  const [year, month] = monthIso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
}

function minIso(values) {
  return values.filter(Boolean).sort()[0] || "";
}

function maxIso(values) {
  const sorted = values.filter(Boolean).sort();
  return sorted.at(-1) || "";
}

function slug(value) {
  return String(value || "cartera")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "cartera";
}

function s(value, style = STYLE.normal) {
  return { type: "s", value: String(value ?? ""), style };
}

function n(value, style = STYLE.normal) {
  const number = Number(value);
  return { type: "n", value: Number.isFinite(number) ? number : null, style };
}

function d(value) {
  return isIsoDate(value) ? { type: "d", value, style: STYLE.date } : { type: "s", value: "", style: STYLE.date };
}

function f(formula, style = STYLE.normal, resultType = "") {
  return { type: "f", formula, style, resultType };
}

async function buildWorkbook(sheets) {
  const zip = new window.JSZip();
  zip.file("[Content_Types].xml", contentTypesXml(sheets));
  zip.folder("_rels").file(".rels", rootRelsXml());
  zip.folder("docProps").file("core.xml", coreXml());
  zip.folder("docProps").file("app.xml", appPropsXml(sheets));
  const xl = zip.folder("xl");
  xl.file("workbook.xml", workbookXml(sheets));
  xl.file("styles.xml", stylesXml());
  xl.folder("_rels").file("workbook.xml.rels", workbookRelsXml(sheets));
  const worksheets = xl.folder("worksheets");
  sheets.forEach((sheet, index) => {
    worksheets.file(`sheet${index + 1}.xml`, worksheetXml(sheet));
  });
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    compression: "DEFLATE"
  });
}

function contentTypesXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n  ")}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function coreXml() {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Analizador de cartera</dc:creator>
  <cp:lastModifiedBy>Analizador de cartera</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function appPropsXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Analizador de cartera</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <HeadingPairs>
    <vt:vector size="2" baseType="variant">
      <vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>
      <vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant>
    </vt:vector>
  </HeadingPairs>
  <TitlesOfParts>
    <vt:vector size="${sheets.length}" baseType="lpstr">
      ${sheets.map((sheet) => `<vt:lpstr>${xml(sheet.name)}</vt:lpstr>`).join("")}
    </vt:vector>
  </TitlesOfParts>
</Properties>`;
}

function workbookXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr date1904="false"/>
  <sheets>
    ${sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("\n    ")}
  </sheets>
  <calcPr calcMode="auto" fullCalcOnLoad="1"/>
</workbook>`;
}

function workbookRelsXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("\n  ")}
  <Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="6">
    <numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>
    <numFmt numFmtId="165" formatCode="#,##0"/>
    <numFmt numFmtId="166" formatCode="#,##0.00"/>
    <numFmt numFmtId="167" formatCode="0.00%"/>
    <numFmt numFmtId="168" formatCode="#,##0.0000"/>
    <numFmt numFmtId="169" formatCode="0.00"/>
  </numFmts>
  <fonts count="4">
    <font><sz val="11"/><color rgb="FF111827"/><name val="Inter"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Inter"/></font>
    <font><b/><sz val="20"/><color rgb="FF111827"/><name val="Inter"/></font>
    <font><sz val="10"/><color rgb="FF6B7280"/><name val="Inter"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF2563EB"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF7F8FA"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFE5E7EB"/></left><right style="thin"><color rgb="FFE5E7EB"/></right><top style="thin"><color rgb="FFE5E7EB"/></top><bottom style="thin"><color rgb="FFE5E7EB"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="12">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1"/>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="168" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1"/>
    <xf numFmtId="169" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;
}

function worksheetXml(sheet) {
  const maxCols = Math.max(1, ...sheet.rows.map((row) => row.length));
  const maxRows = Math.max(1, sheet.rows.length);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:${columnName(maxCols)}${maxRows}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  ${colsXml(sheet.cols || [], maxCols)}
  <sheetData>
    ${sheet.rows.map((row, rowIndex) => rowXml(row, rowIndex + 1)).join("\n    ")}
  </sheetData>
  ${sheet.autoFilter ? `<autoFilter ref="${xml(sheet.autoFilter)}"/>` : ""}
  ${validationsXml(sheet.validations || [])}
  <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

function colsXml(widths, maxCols) {
  const rows = [];
  for (let i = 1; i <= maxCols; i += 1) {
    const width = widths[i - 1] || 14;
    rows.push(`<col min="${i}" max="${i}" width="${width}" customWidth="1"/>`);
  }
  return `<cols>${rows.join("")}</cols>`;
}

function rowXml(row, rowIndex) {
  const cells = row.map((cell, colIndex) => cellXml(cell, rowIndex, colIndex + 1)).filter(Boolean).join("");
  return `<row r="${rowIndex}">${cells}</row>`;
}

function cellXml(cell, rowIndex, colIndex) {
  if (!cell) return "";
  const ref = `${columnName(colIndex)}${rowIndex}`;
  const style = cell.style ? ` s="${cell.style}"` : "";

  if (cell.type === "n") {
    if (cell.value === null) return `<c r="${ref}"${style}/>`;
    return `<c r="${ref}"${style}><v>${cell.value}</v></c>`;
  }

  if (cell.type === "d") {
    return `<c r="${ref}"${style}><v>${excelSerial(cell.value)}</v></c>`;
  }

  if (cell.type === "f") {
    const resultType = cell.resultType === "str" ? ' t="str"' : "";
    return `<c r="${ref}"${style}${resultType}><f>${xml(cell.formula)}</f></c>`;
  }

  return `<c r="${ref}" t="inlineStr"${style}><is><t>${xml(cell.value)}</t></is></c>`;
}

function validationsXml(validations) {
  if (!validations.length) return "";
  return `<dataValidations count="${validations.length}">
    ${validations.map((item) => `<dataValidation type="list" allowBlank="0" sqref="${xml(item.sqref)}"><formula1>${xml(item.formula)}</formula1></dataValidation>`).join("\n    ")}
  </dataValidations>`;
}

function columnName(index) {
  let n = index;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function excelSerial(iso) {
  if (!isIsoDate(iso)) return "";
  const [year, month, day] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000) + 25569;
}

function xml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
