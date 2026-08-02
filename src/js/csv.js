import { isIsoDate } from "./utils.js";

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function parseFlexibleNumber(raw) {
  let value = String(raw || "").trim().replace(/\s/g, "");
  if (!value) return NaN;
  const hasComma = value.includes(",");
  const hasDot = value.includes(".");
  if (hasComma && hasDot) {
    value = value.lastIndexOf(",") > value.lastIndexOf(".")
      ? value.replace(/\./g, "").replace(",", ".")
      : value.replace(/,/g, "");
  } else if (hasComma) {
    value = value.replace(",", ".");
  }
  return Number(value);
}

export function parseFlexibleDate(raw) {
  const value = String(raw || "").trim();
  if (isIsoDate(value)) return value;
  let match = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    const iso = `${year}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
    return isIsoDate(iso) ? iso : "";
  }
  match = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (match) {
    const iso = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    return isIsoDate(iso) ? iso : "";
  }
  return "";
}

function parseRows(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((csvRow) => csvRow.some((value) => String(value).trim()));
}

function sniffDelimiter(line) {
  const counts = {
    ",": (line.match(/,/g) || []).length,
    ";": (line.match(/;/g) || []).length,
    "\t": (line.match(/\t/g) || []).length
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function mapType(raw) {
  const value = normalizeText(raw);
  if (["ingreso", "deposito", "aporte", "aportes", "recibo de cobro"].includes(value)) return "ingreso";
  if (["retiro", "egreso", "extraccion", "comprobante de pago"].includes(value)) return "retiro";
  return "";
}

function mapCurrency(raw) {
  const value = normalizeText(raw);
  if (["ars", "peso", "pesos"].includes(value)) return "ARS";
  if (["usd", "dolar", "dolares", "us dollar"].includes(value)) return "USD";
  return "";
}

export function parseManualCsv(text) {
  const clean = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!clean) throw new Error("Pegá el CSV manual antes de importar.");
  const firstLine = clean.split(/\r?\n/, 1)[0] || "";
  const rows = parseRows(clean, sniffDelimiter(firstLine));
  if (rows.length < 2) throw new Error("El CSV debe tener encabezado y al menos una fila.");

  const header = rows[0].map(normalizeText);
  const idx = {
    date: header.findIndex((value) => ["fecha", "date"].includes(value)),
    type: header.findIndex((value) => ["tipo", "type", "movimiento"].includes(value)),
    currency: header.findIndex((value) => ["moneda", "currency"].includes(value)),
    amount: header.findIndex((value) => ["monto", "amount", "importe"].includes(value))
  };
  const missing = [];
  if (idx.date < 0) missing.push("fecha");
  if (idx.type < 0) missing.push("tipo");
  if (idx.currency < 0) missing.push("moneda");
  if (idx.amount < 0) missing.push("monto");
  if (missing.length) throw new Error(`Faltan columnas requeridas: ${missing.join(", ")}.`);

  const parsed = [];
  const errors = [];
  rows.slice(1).forEach((row, index) => {
    const line = index + 2;
    const date = parseFlexibleDate(row[idx.date]);
    const tipo = mapType(row[idx.type]);
    const moneda = mapCurrency(row[idx.currency]);
    const monto = parseFlexibleNumber(row[idx.amount]);
    if (!date) errors.push(`Fila ${line}: fecha inválida.`);
    else if (!tipo) errors.push(`Fila ${line}: tipo inválido.`);
    else if (!moneda) errors.push(`Fila ${line}: moneda inválida.`);
    else if (!Number.isFinite(monto) || monto <= 0) errors.push(`Fila ${line}: monto inválido.`);
    else parsed.push({ date, tipo, moneda, monto });
  });

  parsed.sort((a, b) => a.date.localeCompare(b.date) || a.tipo.localeCompare(b.tipo));
  return {
    rows: parsed,
    errors,
    report: {},
    meta: { broker: "Manual", accountId: "" }
  };
}

export function downloadCsvTemplate(afterDate = null) {
  const base = afterDate ? new Date(`${afterDate}T00:00:00`) : new Date("2026-01-01T00:00:00");
  const d1 = new Date(base); d1.setDate(d1.getDate() + 10);
  const d2 = new Date(base); d2.setDate(d2.getDate() + 46);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const csv = `fecha,tipo,moneda,monto\n${fmt(d1)},ingreso,ARS,100000\n${fmt(d2)},retiro,USD,500\n`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "movimientos-cartera-v4.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
