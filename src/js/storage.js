import { cleanMovements, makeId, normalizeSnapshot, sourceMeta } from "./utils.js";

export const PORTFOLIOS_KEY = "carteraV4.portfolios";
export const CURRENT_ID_KEY = "carteraV4.currentPortfolioId";

export function normalizePortfolio(saved) {
  if (!saved || typeof saved !== "object") return null;
  const source = saved.source_type || "manual_csv";
  const meta = sourceMeta(source);
  return {
    id: saved.id || makeId(),
    portfolio_name: saved.portfolio_name || "Cartera",
    display_currency: "ARS",
    broker: saved.broker || meta.broker,
    source_type: source,
    source_label: saved.source_label || meta.label,
    import_locked: true,
    created_at: saved.created_at || new Date().toISOString(),
    updated_at: saved.updated_at || new Date().toISOString(),
    movements: cleanMovements(Array.isArray(saved.movements) ? saved.movements : []),
    snapshots: Array.isArray(saved.snapshots) ? saved.snapshots.map(normalizeSnapshot) : [],
    benchmarks: ["dolar_mep", "plazo_fijo", "uva", "spy", "tlt", "ief"]
  };
}

export function loadPortfolios() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PORTFOLIOS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizePortfolio).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function savePortfolios(portfolios, currentId = "") {
  const rows = portfolios.map(normalizePortfolio).filter(Boolean)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  localStorage.setItem(PORTFOLIOS_KEY, JSON.stringify(rows));
  if (currentId) localStorage.setItem(CURRENT_ID_KEY, currentId);
  else localStorage.removeItem(CURRENT_ID_KEY);
  return rows;
}

export function backupPortfolios(portfolios) {
  return {
    portfolios: portfolios.map(normalizePortfolio).filter(Boolean).map((portfolio) => ({
      portfolio_name: portfolio.portfolio_name,
      movements: cleanMovements(portfolio.movements).map(({ date, tipo, moneda, monto }) => ({ date, tipo, moneda, monto })),
      snapshots: portfolio.snapshots.map((snapshot) => ({
        label: snapshot.label,
        date: snapshot.date,
        amount: Number(snapshot.amount || 0),
        currency: snapshot.currency,
        timing: snapshot.timing
      }))
    }))
  };
}

export function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function readBackupFile(file) {
  const parsed = JSON.parse(await file.text());
  const incoming = Array.isArray(parsed) ? parsed : Array.isArray(parsed.portfolios) ? parsed.portfolios : [parsed];
  return incoming.map((portfolio) => normalizePortfolio({
    ...portfolio,
    id: makeId(),
    source_type: "manual_csv",
    source_label: "Backup",
    broker: "Manual",
    import_locked: true
  })).filter(Boolean);
}
