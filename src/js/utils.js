export const $ = (selector, root = document) => root.querySelector(selector);

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function icon(name, size = 18) {
  return `<i data-lucide="${name}" style="width:${size}px;height:${size}px"></i>`;
}

export function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
}

export function makeId(prefix = "portfolio") {
  if (window.crypto && window.crypto.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === value;
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function minDate(values) {
  return values.filter(Boolean).slice().sort()[0] || "";
}

export function maxDate(values) {
  const sorted = values.filter(Boolean).slice().sort();
  return sorted[sorted.length - 1] || "";
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

export function daysInMonth(monthIso) {
  const [year, month] = monthIso.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function fmtDate(iso) {
  if (!isIsoDate(iso)) return iso || "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function fmtMoney(value, currency) {
  const amount = Number(value || 0);
  if (currency === "USD") {
    return `USD ${amount.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `$ ${Math.round(amount).toLocaleString("es-AR")}`;
}

export function fmtPct(value, signed = true) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "N/D";
  const num = Number(value);
  const sign = signed && num >= 0 ? "+" : "";
  return `${sign}${(num * 100).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

export function fmtPp(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "N/D";
  const num = Number(value);
  const sign = num >= 0 ? "+" : "";
  return `${sign}${(num * 100).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} pp`;
}

export function toneClass(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  return Number(value) >= 0 ? "pos" : "neg";
}

export function sourceMeta(source) {
  const plugin = globalThis.CarteraV4Plugins?.get?.(source) || globalThis.CarteraV4Plugins?.items?.[source] || null;
  if (plugin) {
    const label = plugin.label || plugin.broker || plugin.name || source;
    return {
      label,
      broker: plugin.broker || label
    };
  }

  const map = {
    inviu_movimientos: { label: "INVIU", broker: "INVIU" },
    balanz_movimientos: { label: "Balanz", broker: "Balanz" },
    manual_csv: { label: "Carga manual", broker: "Manual" }
  };
  return map[source] || { label: source || "Carga manual", broker: source || "Manual" };
}

export function normalizeMovement(row, index = 0) {
  if (!row || typeof row !== "object") return null;
  const type = String(row.tipo || row.type || "").trim().toLowerCase();
  const currency = String(row.moneda || row.currency || "").trim().toUpperCase();
  const amount = row.monto ?? row.amount;
  return {
    id: row.id || makeId(`mov-${index}`),
    date: String(row.date || row.fecha || "").trim(),
    tipo: type === "retiro" ? "retiro" : "ingreso",
    moneda: currency === "USD" ? "USD" : "ARS",
    monto: String(amount ?? "").trim()
  };
}

export function cleanMovements(movements) {
  return movements.map(normalizeMovement).filter((movement) => {
    const amount = Number(movement.monto);
    return isIsoDate(movement.date)
      && ["ingreso", "retiro"].includes(movement.tipo)
      && ["ARS", "USD"].includes(movement.moneda)
      && Number.isFinite(amount)
      && amount > 0;
  }).map((movement) => ({
    id: movement.id,
    date: movement.date,
    tipo: movement.tipo,
    moneda: movement.moneda,
    monto: Number(movement.monto)
  })).sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.tipo !== b.tipo) return a.tipo.localeCompare(b.tipo);
    return a.moneda.localeCompare(b.moneda);
  });
}

export function validateMovements(movements) {
  const errors = [];
  movements.forEach((movement, index) => {
    const row = normalizeMovement(movement, index);
    const label = `Movimiento ${index + 1}`;
    const amount = Number(row?.monto);
    if (!row || !isIsoDate(row.date)) errors.push(`${label}: fecha inválida.`);
    if (!row || !["ingreso", "retiro"].includes(row.tipo)) errors.push(`${label}: tipo inválido.`);
    if (!row || !["ARS", "USD"].includes(row.moneda)) errors.push(`${label}: moneda inválida.`);
    if (!row || String(row.monto).trim() === "" || !Number.isFinite(amount) || amount <= 0) {
      errors.push(`${label}: monto inválido.`);
    }
  });
  if (!movements.length) errors.push("Agregá al menos un ingreso o retiro.");
  return errors;
}

export function buildSnapshotDefaults(movements) {
  const clean = cleanMovements(movements);
  const allDates = clean.map((movement) => movement.date);
  const incomeDates = clean.filter((movement) => movement.tipo === "ingreso").map((movement) => movement.date);
  const firstIncome = minDate(incomeDates) || minDate(allDates);
  const lastFlow = maxDate(allDates);
  if (!firstIncome || !lastFlow) return [];

  const startDate = addDays(firstIncome, -1);
  const startYear = Number(startDate.slice(0, 4));
  const finalYear = Number(lastFlow.slice(0, 4));
  const rows = [{
    id: "base",
    label: "Inicio",
    date: startDate,
    amount: "",
    currency: "ARS",
    timing: "end_day",
    locked: true
  }];

  for (let year = startYear; year <= finalYear; year += 1) {
    const yearEnd = `${year}-12-31`;
    if (yearEnd > startDate && yearEnd < lastFlow) {
      rows.push({ id: `year-${year}`, label: `Cierre ${year}`, date: yearEnd, amount: "", currency: "ARS", timing: "end_day", locked: true });
    }
  }

  if (rows[rows.length - 1].date !== lastFlow) {
    rows.push({ id: "final", label: "Final", date: lastFlow, amount: "", currency: "ARS", timing: "end_day", locked: true });
  }
  return rows;
}

export function normalizeSnapshot(row, index = 0) {
  return {
    id: row.id || makeId(`snap-${index}`),
    label: String(row.label || "Snapshot").trim() || "Snapshot",
    date: String(row.date || "").trim(),
    amount: row.amount === 0 ? "0" : String(row.amount || "").trim(),
    currency: row.currency === "USD" ? "USD" : "ARS",
    timing: row.timing === "start_day" ? "start_day" : "end_day",
    locked: row.locked !== false
  };
}

export function validateSnapshots(snapshots, movements) {
  const errors = [];
  const rows = snapshots.map(normalizeSnapshot);
  const seen = new Set();
  if (rows.length < 2) errors.push("Cargá al menos una foto inicial y una final.");
  rows.forEach((snapshot) => {
    const amount = Number(snapshot.amount);
    if (!isIsoDate(snapshot.date)) errors.push(`Fecha inválida en ${snapshot.label}.`);
    if (String(snapshot.amount).trim() === "" || !Number.isFinite(amount) || amount < 0) {
      errors.push(`Valor inválido en ${snapshot.label}.`);
    }
    const key = `${snapshot.date}:${snapshot.timing}`;
    if (seen.has(key)) errors.push(`La fecha ${fmtDate(snapshot.date)} está repetida para el mismo momento del día.`);
    seen.add(key);
  });
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const order = { start_day: 0, end_day: 1 };
    return (order[a.timing] ?? 1) - (order[b.timing] ?? 1);
  });
  if (rows.length >= 2 && rows[0].date >= rows[rows.length - 1].date) {
    errors.push("La foto inicial debe ser anterior a la final.");
  }
  const clean = cleanMovements(movements);
  if (clean.length && rows.length >= 2) {
    const first = rows[0].date;
    const last = rows[rows.length - 1].date;
    const outside = clean.filter((movement) => {
      const beforeFirst = rows[0].timing === "start_day" ? movement.date < first : movement.date <= first;
      const afterLast = rows[rows.length - 1].timing === "start_day" ? movement.date >= last : movement.date > last;
      return beforeFirst || afterLast;
    }).length;
    if (outside) errors.push(`${outside} movimiento(s) quedan fuera del intervalo de snapshots.`);
  }
  return errors;
}
