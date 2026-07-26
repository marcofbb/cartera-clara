import { daysBetween, daysInMonth } from "./utils.js";

const SQL_WASM_BASE = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/";
const DB_URL = "data/cartera_v4.sqlite";

let dbPromise = null;
const rateCache = new Map();

export async function loadMarketDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    if (typeof window.initSqlJs !== "function") {
      throw new Error("No se pudo cargar sql.js para leer el SQLite.");
    }
    const SQL = await window.initSqlJs({ locateFile: (file) => SQL_WASM_BASE + file });
    const response = await fetch(`${DB_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`No se encontró ${DB_URL}. Ejecutá build_sqlite.php y reconstruí dist/.`);
    return new SQL.Database(new Uint8Array(await response.arrayBuffer()));
  })();
  return dbPromise;
}

function queryRows(db, sql, params = []) {
  const rows = [];
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

export function queryMarketRows(db, sql, params = []) {
  return queryRows(db, sql, params);
}

function rateAt(db, date, warnings) {
  if (rateCache.has(date)) return rateCache.get(date);
  let rows = queryRows(db, "SELECT ars_per_usd FROM exchange_rates WHERE date <= ? ORDER BY date DESC LIMIT 1", [date]);
  if (!rows.length) rows = queryRows(db, "SELECT ars_per_usd FROM exchange_rates ORDER BY date ASC LIMIT 1");
  const rate = rows.length ? Number(rows[0].ars_per_usd) : null;
  if (!Number.isFinite(rate) || rate <= 0) {
    warnings.push("No hay tipo de cambio MEP disponible para una conversión.");
    rateCache.set(date, null);
    return null;
  }
  rateCache.set(date, rate);
  return rate;
}

export function marketRateAt(db, date, warnings = []) {
  return rateAt(db, date, warnings);
}

function toDisplay(db, amount, currency, date, display, warnings) {
  const conversion = conversionForDisplay(db, amount, currency, date, display, warnings);
  return conversion ? conversion.amount : null;
}

function conversionForDisplay(db, amount, currency, date, display, warnings) {
  const sourceAmount = Number(amount);
  if (currency === display) {
    return {
      amount: sourceAmount,
      source_amount: sourceAmount,
      source_currency: currency,
      display_currency: display,
      rate: null,
      converted: false
    };
  }
  const rate = rateAt(db, date, warnings);
  if (rate === null) return null;
  return {
    amount: display === "USD" ? sourceAmount / rate : sourceAmount * rate,
    source_amount: sourceAmount,
    source_currency: currency,
    display_currency: display,
    rate,
    converted: true
  };
}

function snapshotCompare(a, b) {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  const order = { start_day: 0, end_day: 1 };
  return (order[a.timing] ?? 1) - (order[b.timing] ?? 1);
}

function movementInsideBounds(movement, startSnap, endSnap) {
  const afterStart = startSnap.timing === "start_day"
    ? movement.date >= startSnap.date
    : movement.date > startSnap.date;
  const beforeEnd = endSnap.timing === "start_day"
    ? movement.date < endSnap.date
    : movement.date <= endSnap.date;
  return afterStart && beforeEnd;
}

function movementsBetween(movements, startSnap, endSnap) {
  return movements.filter((movement) => movementInsideBounds(movement, startSnap, endSnap));
}

function computePair(db, startSnap, endSnap, movements, display, warnings) {
  const bmvConversion = conversionForDisplay(db, Number(startSnap.amount), startSnap.currency, startSnap.date, display, warnings);
  const emvConversion = conversionForDisplay(db, Number(endSnap.amount), endSnap.currency, endSnap.date, display, warnings);
  if (bmvConversion === null || emvConversion === null) return null;
  const bmv = bmvConversion.amount;
  const emv = emvConversion.amount;

  const totalDays = Math.max(1, daysBetween(startSnap.date, endSnap.date));
  let aportes = 0;
  let retiros = 0;
  let weightedCf = 0;
  let failed = false;
  const movDetail = [];

  movementsBetween(movements, startSnap, endSnap).forEach((movement) => {
    const conversion = conversionForDisplay(db, Number(movement.monto), movement.moneda, movement.date, display, warnings);
    if (conversion === null) {
      failed = true;
      return;
    }
    const amount = conversion.amount;
    const daysFromStart = Math.max(0, daysBetween(startSnap.date, movement.date));
    const weight = (totalDays - daysFromStart) / totalDays;
    if (movement.tipo === "ingreso") {
      aportes += amount;
      weightedCf += amount * weight;
    } else {
      retiros += amount;
      weightedCf -= amount * weight;
    }
    movDetail.push({ date: movement.date, type: movement.tipo, amount, conversion });
  });

  if (failed) return null;
  const netCf = aportes - retiros;
  const capitalBase = bmv + weightedCf;
  const gain = emv - bmv - netCf;
  let rendimiento = null;
  let degenerateReason = null;
  if (capitalBase < 0) degenerateReason = "Capital base negativo.";
  else if (Math.abs(capitalBase) < 0.05 * Math.max(Math.abs(bmv), Math.abs(emv), 1)) degenerateReason = "Capital base no significativo.";
  else rendimiento = gain / capitalBase;

  return {
    bmv,
    emv,
    bmv_date: startSnap.date,
    emv_date: endSnap.date,
    bmv_timing: startSnap.timing,
    emv_timing: endSnap.timing,
    bmv_conversion: bmvConversion,
    emv_conversion: emvConversion,
    aportes,
    retiros,
    net_cf: netCf,
    capital_base: capitalBase,
    ganancia_neta: gain,
    rendimiento,
    degenerate_reason: degenerateReason,
    mov_detail: movDetail
  };
}

function computeChained(db, snapshots, movements, display, warnings) {
  const ordered = snapshots.slice().sort(snapshotCompare);
  if (ordered.length < 2) return null;
  let factor = 1;
  let aportes = 0;
  let retiros = 0;
  const subPeriods = [];
  const movDetail = [];

  for (let i = 1; i < ordered.length; i += 1) {
    const sub = computePair(db, ordered[i - 1], ordered[i], movements, display, warnings);
    if (!sub) return null;
    if (sub.rendimiento !== null) factor *= 1 + sub.rendimiento;
    else warnings.push(`Tramo ${sub.bmv_date} - ${sub.emv_date} excluido: ${sub.degenerate_reason}`);
    aportes += sub.aportes;
    retiros += sub.retiros;
    subPeriods.push(sub);
    movDetail.push(...sub.mov_detail);
  }

  const first = subPeriods[0];
  const last = subPeriods[subPeriods.length - 1];
  const netCf = aportes - retiros;
  return {
    bmv: first.bmv,
    emv: last.emv,
    bmv_date: first.bmv_date,
    emv_date: last.emv_date,
    bmv_timing: first.bmv_timing,
    emv_timing: last.emv_timing,
    bmv_conversion: first.bmv_conversion,
    emv_conversion: last.emv_conversion,
    aportes,
    retiros,
    net_cf: netCf,
    ganancia_neta: last.emv - first.bmv - netCf,
    rendimiento: factor - 1,
    is_chained: subPeriods.length > 1,
    mov_detail: movDetail,
    sub_periods: subPeriods
  };
}

function xirr(cashflows) {
  if (!cashflows || cashflows.length < 2) return null;
  const sorted = cashflows.slice().sort((a, b) => a.date.localeCompare(b.date));
  const t0 = Date.parse(`${sorted[0].date}T00:00:00Z`);
  const amounts = sorted.map((flow) => flow.amount);
  const years = sorted.map((flow) => (Date.parse(`${flow.date}T00:00:00Z`) - t0) / 86400000 / 365);
  const npv = (rate) => {
    if (rate <= -1) return Number.MAX_VALUE;
    return amounts.reduce((sum, amount, index) => sum + amount / Math.pow(1 + rate, years[index]), 0);
  };
  const dnpv = (rate) => {
    if (rate <= -1) return Number.MAX_VALUE;
    return amounts.reduce((sum, amount, index) => {
      if (Math.abs(years[index]) < 1e-10) return sum;
      return sum - years[index] * amount / Math.pow(1 + rate, years[index] + 1);
    }, 0);
  };

  let rate = 0.1;
  for (let iter = 0; iter < 200; iter += 1) {
    const f = npv(rate);
    const df = dnpv(rate);
    if (Math.abs(df) < 1e-15) break;
    const next = rate - f / df;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - rate) < 1e-7) return next;
    rate = next;
  }

  let lo = -0.9999;
  let hi = 100;
  let fLo = npv(lo);
  let fHi = npv(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;
  for (let iter = 0; iter < 200; iter += 1) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-7 || (hi - lo) / 2 < 1e-7) return mid;
    if (fLo * fMid < 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return null;
}

function xirrCashflows(db, result, movements, display, warnings) {
  if (!result) return null;
  const startSnap = { date: result.bmv_date, timing: result.bmv_timing || "end_day" };
  const endSnap = { date: result.emv_date, timing: result.emv_timing || "end_day" };
  const flows = [];
  if (result.bmv !== 0) flows.push({ date: result.bmv_date, amount: -result.bmv, conversion: result.bmv_conversion || null });
  let failed = false;
  movementsBetween(movements, startSnap, endSnap).forEach((movement) => {
    const conversion = conversionForDisplay(db, Number(movement.monto), movement.moneda, movement.date, display, warnings);
    if (conversion === null) {
      failed = true;
      return;
    }
    flows.push({ date: movement.date, amount: movement.tipo === "ingreso" ? -conversion.amount : conversion.amount, conversion });
  });
  if (failed) return null;
  if (result.emv !== 0) flows.push({ date: result.emv_date, amount: result.emv, conversion: result.emv_conversion || null });
  if (!flows.some((flow) => flow.amount > 0) || !flows.some((flow) => flow.amount < 0)) return null;
  return flows.sort((a, b) => a.date.localeCompare(b.date));
}

function xirrPeriodReturn(cashflows) {
  if (!cashflows) return { annual: null, period: null };
  const annual = xirr(cashflows);
  if (annual === null) return { annual: null, period: null };
  const days = daysBetween(cashflows[0].date, cashflows[cashflows.length - 1].date);
  return { annual, period: days > 0 ? Math.pow(1 + annual, days / 365) - 1 : null };
}

function benchmarkReturns(db, start, end, warnings = []) {
  const items = {
    dolar_mep: { id: "dolar_mep", label: "Dólar MEP", group: "ARS", return: null, source: "benchmarks" },
    plazo_fijo: { id: "plazo_fijo", label: "Plazo fijo", group: "ARS", return: null, source: "benchmarks" },
    uva: { id: "uva", label: "UVA", group: "ARS", return: null, source: "benchmarks" },
    spy: { id: "spy", label: "SPY", group: "USD", return: null, source: "benchmarks" },
    tlt: { id: "tlt", label: "TLT", group: "USD", return: null, source: "benchmarks" },
    ief: { id: "ief", label: "IEF", group: "USD", return: null, source: "benchmarks" }
  };
  const currentMonth = new Date().toISOString().slice(0, 7) + "-01";
  const endMonth = `${end.slice(0, 7)}-01`;
  const benchmarkEndMonth = endMonth >= currentMonth ? previousMonth(currentMonth) : endMonth;
  Object.values(items).forEach((item) => {
    item.detail = {
      method: item.id === "plazo_fijo" ? "tna_prorated" : "monthly_compounded",
      start,
      end,
      benchmark_end_month: benchmarkEndMonth,
      periods: [],
      factor: 1,
      return: null
    };
  });
  if (benchmarkEndMonth < endMonth) {
    warnings.push(`Los benchmarks mensuales se calculan hasta ${formatMonth(benchmarkEndMonth)} por rezago de publicación.`);
  }

  const rows = benchmarkEndMonth >= `${start.slice(0, 7)}-01` ? queryRows(
    db,
    "SELECT month, plazo_fijo_tna, uva, dolar_mep, spy, tlt, ief FROM benchmarks WHERE month >= ? AND month <= ? ORDER BY month ASC",
    [`${start.slice(0, 7)}-01`, benchmarkEndMonth]
  ) : [];
  const factors = Object.fromEntries(Object.keys(items).map((key) => [key, 1]));
  const has = Object.fromEntries(Object.keys(items).map((key) => [key, false]));
  rows.forEach((row) => {
    const activeDays = daysInBenchmarkMonth(row.month, start, end);
    const monthDays = daysInMonth(row.month);
    if (activeDays <= 0 || monthDays <= 0) return;
    const monthWeight = activeDays / monthDays;
    ["dolar_mep", "uva", "spy", "tlt", "ief"].forEach((field) => {
      if (row[field] !== null && row[field] !== undefined && row[field] !== "") {
        const monthlyReturn = Number(row[field]) / 100;
        const periodFactor = Math.pow(1 + monthlyReturn, monthWeight);
        factors[field] *= periodFactor;
        has[field] = true;
        items[field].detail.periods.push({
          month: row.month,
          active_days: activeDays,
          month_days: monthDays,
          month_weight: monthWeight,
          monthly_return: monthlyReturn,
          period_factor: periodFactor,
          period_return: periodFactor - 1
        });
      }
    });
    if (Number(row.plazo_fijo_tna) > 0) {
      const tna = Number(row.plazo_fijo_tna) / 100;
      const periodReturn = tna * activeDays / 365;
      const periodFactor = 1 + periodReturn;
      factors.plazo_fijo *= periodFactor;
      has.plazo_fijo = true;
      items.plazo_fijo.detail.periods.push({
        month: row.month,
        active_days: activeDays,
        year_days: 365,
        tna,
        period_factor: periodFactor,
        period_return: periodReturn
      });
    }
  });
  Object.keys(items).forEach((key) => {
    if (has[key]) items[key].return = factors[key] - 1;
    items[key].detail.factor = factors[key];
    items[key].detail.return = items[key].return;
  });

  const startRate = rateAt(db, start, warnings);
  const endRate = rateAt(db, end, warnings);
  if (startRate !== null && endRate !== null && startRate > 0) {
    items.dolar_mep.return = endRate / startRate - 1;
    items.dolar_mep.source = "exchange_rates";
    items.dolar_mep.detail = {
      method: "exchange_rates",
      start,
      end,
      start_rate: startRate,
      end_rate: endRate,
      factor: endRate / startRate,
      return: items.dolar_mep.return,
      periods: []
    };
  }
  return Object.values(items);
}

function daysInBenchmarkMonth(monthIso, start, end) {
  const monthStart = monthIso;
  const [year, month] = monthIso.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const from = start > monthStart ? start : monthStart;
  const to = end < monthEnd ? end : monthEnd;
  if (to < from) return 0;
  return daysBetween(from, to) + 1;
}

function previousMonth(monthIso) {
  const [year, month] = monthIso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10);
}

function formatMonth(monthIso) {
  const [year, month] = monthIso.split("-").map(Number);
  return `${String(month).padStart(2, "0")}/${year}`;
}

export async function calculatePortfolio(portfolio) {
  const db = await loadMarketDb();
  const warnings = [];
  const snapshots = portfolio.snapshots.slice().sort(snapshotCompare);
  const movements = portfolio.movements.slice().sort((a, b) => a.date.localeCompare(b.date));
  const results = { ARS: null, USD: null };
  const xirrResults = {
    ARS: { annual: null, period: null },
    USD: { annual: null, period: null }
  };

  ["ARS", "USD"].forEach((currency) => {
    results[currency] = computeChained(db, snapshots, movements, currency, warnings);
    const flows = xirrCashflows(db, results[currency], movements, currency, warnings);
    xirrResults[currency] = { ...xirrPeriodReturn(flows), cashflows: flows || [] };
  });

  const start = portfolio.benchmark_start || snapshots[0]?.date || "";
  const end = portfolio.benchmark_end || snapshots[snapshots.length - 1]?.date || "";
  const benchmarks = start && end ? benchmarkReturns(db, start, end, warnings) : [];

  const metaRows = queryRows(db, "SELECT key, value FROM meta");
  const dbMeta = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));

  return {
    results,
    xirr: xirrResults,
    benchmarks,
    warnings: Array.from(new Set(warnings)),
    db_generated_at: dbMeta.generated_at || null,
  };
}
