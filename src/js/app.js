import { parseManualCsv, downloadCsvTemplate } from "./csv.js";
import { track } from "./analytics.js";
import { calculatePortfolio, loadMarketDb, queryMarketRows } from "./calc.js";
import {
  $, buildSnapshotDefaults, cleanMovements, daysBetween, escapeHtml, fmtDate, fmtMoney, fmtPct, fmtPp,
  icon, isIsoDate, makeId, maxDate, normalizeMovement, normalizeSnapshot, refreshIcons,
  sourceMeta, todayIso, toneClass, validateMovements, validateSnapshots
} from "./utils.js";
import {
  CURRENT_ID_KEY, backupPortfolios, downloadJson, loadPortfolios, normalizePortfolio,
  readBackupFile, savePortfolios
} from "./storage.js";

const STEPS = [
  ["cartera", "Cartera"],
  ["importacion", "Importación"],
  ["movimientos", "Movimientos"],
  ["snapshots", "Snapshots"],
  ["final", "Resultados"]
];

const BENCHMARKS = [
  ["dolar_mep", "Dólar MEP", "ARS"],
  ["plazo_fijo", "Plazo fijo", "ARS"],
  ["uva", "UVA", "ARS"],
  ["spy", "SPY", "USD"],
  ["tlt", "TLT", "USD"],
  ["ief", "IEF", "USD"]
];
const ALL_BENCHMARK_IDS = BENCHMARKS.map(([id]) => id);
const PLUGIN_MANIFEST_URL = "plugins/manifest.json";
const XLSX_ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MANUAL_SOURCE = {
  id: "manual_csv",
  title: "Carga manual",
  label: "Carga manual",
  broker: "Manual",
  copy: "Pegá CSV o usá el prompt de IA.",
  logoHtml: icon("file-text", 34),
  logoClass: "",
  onboardingPdf: "guides/onboarding_manual.pdf",
  isManual: true
};

const AI_PROMPT = `Actuá como parser de movimientos de una cartera de inversión para calcular rendimiento.

Necesito que conviertas el archivo adjunto a un CSV con este encabezado exacto:
fecha,tipo,moneda,monto

Reglas obligatorias:
- Devolvé solo CSV, sin explicación, sin markdown y sin texto adicional.
- fecha debe estar en formato YYYY-MM-DD.
- tipo solo puede ser ingreso o retiro.
- moneda solo puede ser ARS o USD.
- monto debe ser positivo, sin separadores de miles y con punto decimal si hace falta.
- Incluí únicamente flujos externos de capital: depósitos/aportes, retiros/extracciones y traspasos externos que cambien el capital de la cartera.
- Omití operaciones internas del portafolio: compras, ventas, rentas, dividendos, comisiones, canjes, conversiones MEP, cauciones, intereses y ajustes.
- Si una fila es dudosa y no se puede confirmar que sea depósito o retiro externo, preguntá al usuario.

Ejemplo:
fecha,tipo,moneda,monto
2026-01-10,ingreso,ARS,100000
2026-02-15,retiro,USD,500`;

const app = $("#app");
const state = {
  portfolios: loadPortfolios(),
  activeId: localStorage.getItem(CURRENT_ID_KEY) || "",
  draft: null,
  screen: location.hash === "#final" ? "final" : "start",
  source: "manual_csv",
  file: null,
  fileReady: false,
  manualCsv: "",
  notice: null,
  result: null,
  resultRange: null,
  resultKey: "",
  calculating: false,
  pluginsLoaded: false,
  pluginLoadErrors: [],
  pluginFiles: [],
  db: null,
  dbLoading: false,
  dbTable: "exchange_rates",
  showLockedMovements: false
};

function pluginRegistry() {
  if (!window.CarteraV4Plugins) {
    window.CarteraV4Plugins = {
      items: {},
      register(plugin) {
        if (plugin?.id) this.items[plugin.id] = plugin;
      },
      get(id) {
        return this.items[id] || null;
      }
    };
  }
  return window.CarteraV4Plugins;
}

function brokerPlugins() {
  const registry = pluginRegistry();
  return Object.values(registry.items)
    .filter((plugin) => plugin?.id && typeof plugin.parse === "function")
    .sort((a, b) => String(pluginLabel(a)).localeCompare(String(pluginLabel(b)), "es"));
}

function pluginLabel(plugin) {
  return plugin.label || plugin.broker || String(plugin.name || plugin.id || "").replace(/\s*Movimientos\s*$/i, "") || plugin.id;
}

function sourceConfigForPlugin(plugin) {
  const label = pluginLabel(plugin);
  return {
    id: plugin.id,
    title: plugin.title || label,
    label,
    broker: plugin.broker || label,
    copy: plugin.cardDescription || plugin.description || `Importá movimientos desde ${label}.`,
    logoText: plugin.logoText || label,
    logoClass: plugin.logoClass || "",
    accept: plugin.accept || ".xlsx",
    importTitle: plugin.importTitle || `Exportar movimientos desde ${label}`,
    importSteps: Array.isArray(plugin.importSteps) && plugin.importSteps.length
      ? plugin.importSteps
      : [
        `Ingresá a tu cuenta de ${label}.`,
        "Abrí la sección de movimientos.",
        "Seleccioná el rango completo de fechas.",
        "Exportá en formato XLSX.",
        "Volvé a esta pantalla y subí el archivo."
      ],
    accountField: plugin.accountField || null,
    onboardingPdf: plugin.onboardingPdf || null,
    plugin,
    isManual: false
  };
}

function importSources() {
  return [...brokerPlugins().map(sourceConfigForPlugin), MANUAL_SOURCE];
}

function currentSourceConfig() {
  return importSources().find((source) => source.id === state.source) || MANUAL_SOURCE;
}

function defaultSourceId() {
  return brokerPlugins()[0]?.id || MANUAL_SOURCE.id;
}

function ensureSelectedSource() {
  const sources = importSources();
  if (!sources.some((source) => source.id === state.source)) {
    state.source = defaultSourceId();
  }
  if (state.draft) {
    const meta = sourceMeta(state.source);
    state.draft.source_type = state.source;
    state.draft.source_label = meta.label;
    state.draft.broker = meta.broker;
  }
}

function safePluginFileName(file) {
  const name = String(file?.file || file || "").trim();
  return /^[a-z0-9_.-]+\.js$/i.test(name) ? name : "";
}

async function loadBrokerPlugins() {
  pluginRegistry();
  let files = [];
  try {
    const response = await fetch(`${PLUGIN_MANIFEST_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json();
    const entries = Array.isArray(manifest) ? manifest : manifest.plugins;
    files = (Array.isArray(entries) ? entries : []).map(safePluginFileName).filter(Boolean);
  } catch {
    state.pluginLoadErrors.push("No se pudo leer el manifiesto de plugins. Solo queda disponible la carga manual.");
  }

  state.pluginFiles = files;
  await Promise.all(files.map(loadPluginScript));
  state.pluginsLoaded = true;
  ensureSelectedSource();
}

function loadPluginScript(fileName) {
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = `plugins/${encodeURIComponent(fileName)}?t=${Date.now()}`;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => {
      state.pluginLoadErrors.push(`No se pudo cargar ${fileName}.`);
      resolve();
    };
    document.head.appendChild(script);
  });
}

function activePortfolio() {
  return state.portfolios.find((portfolio) => portfolio.id === state.activeId) || state.portfolios[0] || null;
}

function setNotice(type, text) {
  state.notice = text ? { type, text } : null;
}

function invalidateResults() {
  state.result = null;
  state.resultKey = "";
  state.calculating = false;
}

function persistActive() {
  const active = activePortfolio();
  if (!active) return;
  active.updated_at = new Date().toISOString();
  state.portfolios = savePortfolios(state.portfolios, active.id);
  state.activeId = active.id;
}

function createDraft() {
  const source = defaultSourceId();
  const meta = sourceMeta(source);
  state.draft = {
    portfolio_name: "",
    display_currency: "ARS",
    source_type: source,
    source_label: meta.label,
    broker: meta.broker,
    movements: [],
    snapshots: [],
    benchmarks: ALL_BENCHMARK_IDS
  };
  state.source = source;
  state.file = null;
  state.fileReady = false;
}

function createPortfolioFromImport(result) {
  const meta = sourceMeta(state.source);
  const name = $("#portfolioName")?.value.trim() || state.draft?.portfolio_name || `Cartera ${meta.broker}`;
  const movements = cleanMovements((result.rows || []).map(normalizeMovement));
  if (!movements.length) throw new Error("No se detectaron movimientos de capital válidos.");

  const portfolio = normalizePortfolio({
    id: makeId(),
    portfolio_name: name,
    display_currency: "ARS",
    broker: meta.broker,
    source_type: state.source,
    source_label: meta.label,
    import_locked: true,
    movements,
    snapshots: buildSnapshotDefaults(movements),
    benchmarks: ALL_BENCHMARK_IDS,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  state.portfolios.unshift(portfolio);
  state.portfolios = savePortfolios(state.portfolios, portfolio.id);
  state.activeId = portfolio.id;
  state.draft = null;
  track("portfolio_created", { source_id: state.source, movement_count: movements.length });
  return portfolio;
}

function stepIndex() {
  if (["start", "new-basic", "open-existing"].includes(state.screen)) return 0;
  if (["source", "import", "import-summary"].includes(state.screen)) return 1;
  if (state.screen === "movements") return 2;
  if (state.screen === "snapshots") return 3;
  if (state.screen === "final") return 4;
  if (state.screen === "db-explorer") return 4;
  return 0;
}

function renderLayout(content, options = {}) {
  const current = stepIndex();
  const showStepper = state.screen !== "start";
  const active = state.draft ? null : activePortfolio();
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">${icon("line-chart", 20)}</div>
          <div>
            <h1 class="brand-title">Analizador de cartera</h1>
            <p class="brand-subtitle">${active ? escapeHtml(active.portfolio_name) : "Onboarding de rendimiento"}</p>
          </div>
        </div>
        <div class="toolbar" ${state.screen === "start" ? "hidden" : ""}>
          <button class="btn btn-secondary" data-action="go-start">${icon("home", 16)}Inicio</button>
          <button class="btn btn-secondary" data-action="export-backup">${icon("download", 16)}Backup</button>
        </div>
      </header>
      ${showStepper ? renderStepper(current) : ""}
      ${state.notice ? `<div class="notice ${state.notice.type}">${icon(noticeIcon(state.notice.type), 18)}<span>${escapeHtml(state.notice.text)}</span></div>` : ""}
      <section class="screen">${content}</section>
    </div>
  `;
  bindGlobalActions();
  if (options.afterRender) options.afterRender();
  refreshIcons();
}

function closeModal() {
  document.querySelector(".modal-backdrop")?.remove();
}

function showModal(content, bind) {
  closeModal();
  const wrapper = document.createElement("div");
  wrapper.className = "modal-backdrop";
  wrapper.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true">
      ${content}
    </div>
  `;
  document.body.appendChild(wrapper);
  wrapper.addEventListener("click", (event) => {
    if (event.target === wrapper || event.target.closest("[data-action='close-modal']")) {
      closeModal();
    }
  });
  bind?.(wrapper);
  refreshIcons();
}

function setModalError(message) {
  const box = $(".modal-error");
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
}

function renderStepper(current) {
  if (activePortfolio() && !state.draft) {
    const NAV_TABS = [
      [0, "Inicio"],
      [2, "Movimientos"],
      [3, "Snapshots"],
      [4, "Resultados"],
    ];
    return `
      <nav class="portfolio-nav" aria-label="Navegación">
        ${NAV_TABS.map(([index, label]) => {
          const active = index === current;
          const target = stepTarget(index);
          return `
            <button class="nav-tab ${active ? "active" : ""}" data-step="${index}" ${target ? "" : "disabled"}>
              ${label}
            </button>
          `;
        }).join("")}
      </nav>
    `;
  }
  return `
    <nav class="stepper" aria-label="Progreso">
      ${STEPS.map(([, label], index) => {
        const done = index < current;
        const active = index === current;
        const target = stepTarget(index);
        return `
          <button class="step ${done ? "done" : ""} ${active ? "active" : ""}" data-step="${index}" ${target ? "" : "disabled"}>
            <span class="step-dot">${done ? icon("check", 15) : index + 1}</span>
            <span>${label}</span>
          </button>
        `;
      }).join("")}
    </nav>
  `;
}

function stepTarget(index) {
  if (state.draft) {
    if (index === 0) return "new-basic";
    if (index === 1) return "source";
    return "";
  }

  const active = activePortfolio();
  if (index === 0) return state.draft ? "new-basic" : "open-existing";
  if (index === 1) return state.draft ? "source" : active ? "import-summary" : "";
  if (index === 2) return active ? "movements" : "";
  if (index === 3) return active ? "snapshots" : "";
  if (index === 4) return active ? "final" : "";
  return "";
}

function navigateToStep(index) {
  const target = stepTarget(index);
  if (!target) return;
  state.screen = target;
  state.notice = null;
  if (target === "final") invalidateResults();
  render();
}

function noticeIcon(type) {
  return type === "success" ? "check-circle-2" : type === "error" ? "circle-alert" : "info";
}

function bindGlobalActions() {
  document.querySelectorAll("[data-step]").forEach((button) => {
    button.addEventListener("click", () => navigateToStep(Number(button.dataset.step)));
  });
  $("[data-action='go-start']")?.addEventListener("click", () => {
    state.screen = "start";
    state.notice = null;
    render();
  });
  $("[data-action='export-backup']")?.addEventListener("click", () => {
    if (!state.portfolios.length) {
      setNotice("warn", "No hay carteras guardadas para exportar.");
      render();
      return;
    }
    track("backup_exported", { portfolio_count: state.portfolios.length });
    downloadJson(backupPortfolios(state.portfolios), `cartera-v4-backup-${todayIso()}.json`);
  });
}

async function loadDemo() {
  try {
    const res = await fetch("example.json");
    if (!res.ok) throw new Error("No se pudo cargar la cartera de ejemplo.");
    const data = await res.json();
    const incoming = Array.isArray(data.portfolios) ? data.portfolios : [data];
    const demos = incoming.map((p) => normalizePortfolio({
      ...p,
      id: makeId(),
      source_type: "manual_csv",
      source_label: "Demo",
      broker: "Demo",
      import_locked: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })).filter(Boolean);
    if (!demos.length) throw new Error("El archivo de demo está vacío.");
    const demo = demos.find((p) => p.movements.length > 50) || demos[0];
    const existing = state.portfolios.filter((p) => p.source_label !== "Demo");
    state.portfolios = savePortfolios([demo, ...existing], demo.id);
    state.activeId = demo.id;
    state.draft = null;
    state.screen = "final";
    state.notice = null;
    invalidateResults();
    track("demo_loaded");
    render();
  } catch (err) {
    setNotice("error", err.message || "No se pudo cargar la demo.");
    render();
  }
}

function renderStart() {
  renderLayout(`
    <div class="hero">
      <div class="eyebrow">Gratis · Sin registro · 100% en tu navegador</div>
      <h2 class="title">¿Tu cartera le está ganando al dólar, al plazo fijo y a la inflación?</h2>
      <p class="subtitle">Cartera Clara calcula el XIRR y Modified Dietz de tu cartera en pesos y USD MEP, y la compara contra benchmarks reales: dólar MEP, plazo fijo TNA, UVA, SPY y bonos del Tesoro. Tu información no sale del navegador.</p>
      <div class="start-grid">
        <button class="choice-card" data-action="new">
          <div class="card-icon">${icon("plus", 24)}</div>
          <h2>Crear cartera nueva</h2>
          <p>Importá tus movimientos de Balanz, Inviu o cualquier CSV. En minutos tenés el XIRR del período con comparación contra todos los benchmarks.</p>
        </button>
        <button class="choice-card" data-action="open">
          <div class="card-icon">${icon("folder-open", 24)}</div>
          <h2>Abrir cartera guardada</h2>
          <p>Retomá una cartera existente, agregá nuevos snapshots de valor y actualizá los resultados.</p>
        </button>
      </div>
      <div class="demo-row">
        <button class="btn-demo" data-action="load-demo">
          ${icon("play-circle", 16)}Ver cartera de ejemplo
        </button>
        <span class="demo-hint">Sin datos reales — para explorar cómo funciona</span>
      </div>
      <div class="onboarding-row">
        <a class="btn-onboarding" href="onboarding.html" target="_blank" rel="noopener">
          ${icon("book-open", 16)}Cómo usar Cartera Clara paso a paso
        </a>
      </div>
    </div>
  `, {
    afterRender() {
      $("[data-action='new']").addEventListener("click", () => {
        createDraft();
        state.screen = "new-basic";
        state.notice = null;
        render();
      });
      $("[data-action='open']").addEventListener("click", () => {
        state.draft = null;
        state.file = null;
        state.fileReady = false;
        state.manualCsv = "";
        state.screen = "open-existing";
        state.notice = null;
        render();
      });
      $("[data-action='load-demo']").addEventListener("click", () => loadDemo());
    }
  });
}

function renderOpenExisting() {
  const options = state.portfolios.map((portfolio) => `
    <option value="${escapeHtml(portfolio.id)}">${escapeHtml(portfolio.portfolio_name)} · ${escapeHtml(portfolio.source_label)}</option>
  `).join("");
  renderLayout(`
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">Abrir cartera</h2>
          <p class="panel-subtitle">Seleccioná una cartera local o restaurá un backup.</p>
        </div>
      </div>
      <div class="form-grid">
        <label class="field full">
          <span class="label">Carteras guardadas</span>
          <select class="select" id="existingPortfolio" ${state.portfolios.length ? "" : "disabled"}>
            ${state.portfolios.length ? options : '<option>Sin carteras guardadas</option>'}
          </select>
        </label>
      </div>
      <input type="file" id="backupFile" accept=".json,application/json" hidden>
      <div class="actions">
        <button class="btn btn-secondary" data-action="back">${icon("arrow-left", 16)}Volver</button>
        <div class="toolbar">
          <button class="btn btn-secondary" data-action="import-backup">${icon("upload", 16)}Importar backup</button>
          <button class="btn btn-danger" data-action="delete-selected" ${state.portfolios.length ? "" : "disabled"}>${icon("trash-2", 16)}Eliminar</button>
          <button class="btn btn-primary" data-action="open-selected" ${state.portfolios.length ? "" : "disabled"}>Abrir cartera${icon("arrow-right", 16)}</button>
        </div>
      </div>
    </div>
  `, {
    afterRender() {
      $("[data-action='back']").addEventListener("click", () => {
        state.screen = "start";
        render();
      });
      $("[data-action='open-selected']").addEventListener("click", () => {
        state.activeId = $("#existingPortfolio").value;
        localStorage.setItem(CURRENT_ID_KEY, state.activeId);
        state.resultRange = null;
        invalidateResults();
        state.screen = "final";
        track("portfolio_opened", { source_id: activePortfolio()?.source_type || "unknown" });
        render();
      });
      $("[data-action='delete-selected']").addEventListener("click", () => {
        openDeletePortfolioModal($("#existingPortfolio").value);
      });
      $("[data-action='import-backup']").addEventListener("click", () => $("#backupFile").click());
      $("#backupFile").addEventListener("change", async (event) => {
        try {
          const imported = await readBackupFile(event.target.files[0]);
          if (!imported.length) throw new Error("El backup no contiene carteras válidas.");
          state.portfolios = savePortfolios([...imported, ...state.portfolios], imported[0].id);
          state.activeId = imported[0].id;
          state.resultRange = null;
          invalidateResults();
          state.screen = "final";
          track("backup_imported", { portfolio_count: imported.length });
          setNotice("success", `Backup importado: ${imported.length} cartera(s).`);
          render();
        } catch (error) {
          setNotice("error", error.message || "No se pudo importar el backup.");
          render();
        }
      });
    }
  });
}

function openDeletePortfolioModal(portfolioId) {
  const portfolio = state.portfolios.find((item) => item.id === portfolioId);
  if (!portfolio) return;
  showModal(`
    <div class="modal-form">
      <div class="modal-head">
        <div>
          <h2>Eliminar cartera</h2>
          <p>Vas a borrar esta cartera guardada en este navegador. Esta acción elimina movimientos y snapshots locales, pero no afecta backups exportados.</p>
        </div>
        <button type="button" class="icon-btn" data-action="close-modal">${icon("x", 16)}</button>
      </div>
      <div class="delete-summary">
        <strong>${escapeHtml(portfolio.portfolio_name)}</strong>
        <span>${portfolio.movements.length} movimiento(s) · ${portfolio.snapshots.length} snapshot(s)</span>
      </div>
      <div class="actions">
        <button type="button" class="btn btn-secondary" data-action="close-modal">Cancelar</button>
        <button type="button" class="btn btn-danger" data-action="confirm-delete">${icon("trash-2", 16)}Eliminar cartera</button>
      </div>
    </div>
  `, () => {
    $("[data-action='confirm-delete']").addEventListener("click", () => {
      track("portfolio_deleted", { source_id: state.portfolios.find((p) => p.id === portfolioId)?.source_type || "unknown" });
      state.portfolios = state.portfolios.filter((item) => item.id !== portfolioId);
      const nextActive = state.activeId === portfolioId ? state.portfolios[0]?.id || "" : state.activeId;
      state.portfolios = savePortfolios(state.portfolios, nextActive);
      state.activeId = nextActive;
      state.resultRange = null;
      invalidateResults();
      setNotice("success", "Cartera eliminada.");
      closeModal();
      renderOpenExisting();
    });
  });
}

function renderNewBasic() {
  renderLayout(`
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">Datos básicos de la cartera</h2>
          <p class="panel-subtitle">Esto queda como borrador hasta que importes los movimientos.</p>
        </div>
      </div>
      <div class="form-grid">
        <label class="field full">
          <span class="label">Nombre de la cartera</span>
          <input class="input" id="portfolioName" placeholder="Ej: Mi cartera inversiones" value="${escapeHtml(state.draft?.portfolio_name || "")}">
        </label>
      </div>
      <div class="actions">
        <button class="btn btn-secondary" data-action="back">${icon("arrow-left", 16)}Volver</button>
        <button class="btn btn-primary" data-action="continue">Continuar${icon("arrow-right", 16)}</button>
      </div>
    </div>
  `, {
    afterRender() {
      $("[data-action='back']").addEventListener("click", () => {
        state.screen = "start";
        render();
      });
      $("[data-action='continue']").addEventListener("click", () => {
        state.draft.portfolio_name = $("#portfolioName").value.trim();
        state.draft.display_currency = "ARS";
        state.screen = "source";
        render();
      });
    }
  });
}

function renderSource() {
  ensureSelectedSource();
  const sources = importSources();
  const brokerCount = sources.filter((source) => !source.isManual).length;
  renderLayout(`
    <div class="panel wide-panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">¿Cómo querés importar los movimientos?</h2>
          <p class="panel-subtitle">La importación es inicial. Después solo vas a editar o agregar movimientos manualmente.</p>
        </div>
      </div>
      ${!brokerCount ? `<div class="notice warn">${icon("plug-zap", 18)}<span>No se detectaron plugins de broker en la carpeta plugins. Podés continuar con carga manual.</span></div>` : ""}
      ${state.pluginLoadErrors.map((error) => `<div class="notice warn">${icon("triangle-alert", 18)}<span>${escapeHtml(error)}</span></div>`).join("")}
      <div class="source-grid">
        ${sources.map(sourceCard).join("")}
      </div>
      <div class="actions">
        <button class="btn btn-secondary" data-action="back">${icon("arrow-left", 16)}Volver</button>
        <button class="btn btn-primary" data-action="continue">Continuar${icon("arrow-right", 16)}</button>
      </div>
    </div>
  `, {
    afterRender() {
      document.querySelectorAll("[data-source]").forEach((card) => {
        card.addEventListener("click", (event) => {
          event.preventDefault();
          state.source = card.dataset.source;
          const meta = sourceMeta(state.source);
          state.draft.source_type = state.source;
          state.draft.source_label = meta.label;
          state.draft.broker = meta.broker;
          track("source_selected", { source_id: state.source, source_label: meta.label });
          document.querySelectorAll("[data-source]").forEach((item) => {
            item.classList.toggle("active", item.dataset.source === state.source);
          });
        });
      });
      $("[data-action='back']").addEventListener("click", () => {
        state.screen = "new-basic";
        render();
      });
      $("[data-action='continue']").addEventListener("click", () => {
        state.file = null;
        state.fileReady = false;
        state.screen = "import";
        render();
      });
    }
  });
}

function sourceCard(source) {
  const logo = source.logoHtml || escapeHtml(source.logoText || source.title);
  return `
    <button type="button" class="source-card ${state.source === source.id ? "active" : ""}" data-source="${escapeHtml(source.id)}">
      <div class="source-card-logo ${escapeHtml(source.logoClass || "")}">${logo}</div>
      <h3>${escapeHtml(source.title)}</h3>
      <p>${escapeHtml(source.copy)}</p>
    </button>
  `;
}

function renderImportSummary() {
  const portfolio = activePortfolio();
  if (!portfolio) return renderStart();
  renderLayout(`
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">Importación inicial</h2>
          <p class="panel-subtitle">Esta cartera ya fue creada. La importación queda cerrada para evitar duplicar movimientos.</p>
        </div>
      </div>
      <div class="metric-grid">
        <div class="metric-card"><div class="metric-label">Origen</div><div class="metric-value">${escapeHtml(portfolio.source_label || "Manual")}</div></div>
        <div class="metric-card"><div class="metric-label">Movimientos</div><div class="metric-value">${portfolio.movements.length}</div></div>
        <div class="metric-card"><div class="metric-label">Moneda</div><div class="metric-value">ARS</div></div>
      </div>
      <div class="notice">${icon("lock", 18)}<span>Para corregir la cartera usá el paso Movimientos y editá o agregá registros manualmente.</span></div>
      <div class="actions">
        <button class="btn btn-secondary" data-action="back">${icon("arrow-left", 16)}Cartera</button>
        <button class="btn btn-primary" data-action="continue">Ir a movimientos${icon("arrow-right", 16)}</button>
      </div>
    </div>
  `, {
    afterRender() {
      $("[data-action='back']").addEventListener("click", () => {
        state.screen = "open-existing";
        render();
      });
      $("[data-action='continue']").addEventListener("click", () => {
        state.screen = "movements";
        render();
      });
    }
  });
}

function renderImport() {
  if (state.source === "manual_csv") return renderManualImport();
  const source = currentSourceConfig();
  if (!source.plugin) {
    state.screen = "source";
    setNotice("warn", "El plugin seleccionado ya no está disponible.");
    return renderSource();
  }
  const accept = fileAcceptForSource(source);
  renderLayout(`
    <div class="panel wide-panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">${escapeHtml(source.importTitle)}</h2>
          <p class="panel-subtitle">Subí el XLSX una sola vez para crear la cartera. Luego las ediciones son manuales.</p>
        </div>
        ${source.onboardingPdf ? `<a class="btn btn-secondary" href="${escapeHtml(source.onboardingPdf)}" target="_blank" rel="noopener">${icon("file-text", 16)}Guía completa (PDF)</a>` : ""}
      </div>
      <div class="import-layout">
        <div>
          <ol class="guide-list">
            ${source.importSteps.map((step, index) => `<li><strong>${index + 1}</strong><span>${escapeHtml(step)}</span></li>`).join("")}
          </ol>
          ${source.accountField ? `
            <label class="field" style="margin-top:24px">
              <span class="label">${escapeHtml(source.accountField.label || "ID de cuenta")}</span>
              <input class="input" id="${escapeHtml(source.accountField.id || "accountId")}" placeholder="${escapeHtml(source.accountField.placeholder || "")}">
              ${source.accountField.hint ? `<span class="field-hint" data-account-autofill-hint>${escapeHtml(source.accountField.hint)}</span>` : ""}
            </label>
          ` : ""}
        </div>
        <div>
          <input type="file" id="movementFile" accept="${escapeHtml(accept)}" hidden>
          <button type="button" class="dropzone ${state.fileReady ? "selected" : ""}" data-action="pick-file">
            ${icon("cloud-upload", 42)}
            <strong data-file-status>${state.fileReady ? "Archivo seleccionado y listo para importar" : "Arrastrá o seleccioná tu archivo"}</strong>
            <span class="muted" data-file-hint>${state.fileReady ? "El archivo quedó cargado para esta importación." : "El nombre del archivo no se guarda ni se muestra."}</span>
          </button>
        </div>
      </div>
      <div class="notice warn">${icon("lightbulb", 18)}<span>Incluí todo el historial necesario para medir el período de rendimiento.</span></div>
      <div class="actions">
        <button class="btn btn-secondary" data-action="back">${icon("arrow-left", 16)}Volver</button>
        <button class="btn btn-primary" data-action="import" ${state.fileReady ? "" : "disabled"}>Importar movimientos${icon("arrow-right", 16)}</button>
      </div>
    </div>
  `, { afterRender: bindImportFile });
}

function bindImportFile() {
  $("#movementFile").addEventListener("change", (event) => {
    state.file = event.target.files[0] || null;
    state.fileReady = Boolean(state.file);
    updateFileSelection();
    autoFillImportFieldsFromFile();
  });
  $("[data-action='pick-file']").addEventListener("click", () => $("#movementFile").click());
  $("[data-action='pick-file']").addEventListener("dragover", (event) => {
    event.preventDefault();
    event.currentTarget.classList.add("dragging");
  });
  $("[data-action='pick-file']").addEventListener("dragleave", (event) => {
    event.currentTarget.classList.remove("dragging");
  });
  $("[data-action='pick-file']").addEventListener("drop", (event) => {
    event.preventDefault();
    event.currentTarget.classList.remove("dragging");
    state.file = event.dataTransfer.files[0] || null;
    state.fileReady = Boolean(state.file);
    updateFileSelection();
    autoFillImportFieldsFromFile();
  });
  $("[data-action='back']").addEventListener("click", () => {
    state.screen = "source";
    render();
  });
  $("[data-action='import']").addEventListener("click", importMovements);
}

function updateFileSelection() {
  const dropzone = $("[data-action='pick-file']");
  const importButton = $("[data-action='import']");
  dropzone.classList.toggle("selected", state.fileReady);
  $("[data-file-status]").textContent = state.fileReady ? "Archivo seleccionado y listo para importar" : "Arrastrá o seleccioná tu archivo";
  $("[data-file-hint]").textContent = state.fileReady ? "El archivo quedó cargado para esta importación." : "El nombre del archivo no se guarda ni se muestra.";
  importButton.disabled = !state.fileReady;
}

function autoFillImportFieldsFromFile() {
  const source = currentSourceConfig();
  const accountField = source.accountField;
  if (!state.file || !accountField?.id || !accountField.fileNamePattern) return;
  const input = document.getElementById(accountField.id);
  if (!input) return;
  const value = valueFromFileName(state.file.name, accountField.fileNamePattern, accountField.fileNameGroup);
  if (!value) return;
  input.value = value;
  const hint = $("[data-account-autofill-hint]");
  if (hint) hint.textContent = `Completado automáticamente desde el nombre del archivo: ${value}. Podés editarlo manualmente si no corresponde.`;
}

function valueFromFileName(fileName, pattern, group = 1) {
  try {
    const match = String(fileName || "").match(new RegExp(pattern, "i"));
    return match?.[Number(group) || 1] || "";
  } catch {
    return "";
  }
}

function fileAcceptForSource(source) {
  const accept = String(source.accept || ".xlsx").trim();
  if (!accept || accept === ".xlsx") return XLSX_ACCEPT;
  return accept;
}

function renderManualImport() {
  renderLayout(`
    <div class="panel wide-panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">Carga manual de movimientos</h2>
          <p class="panel-subtitle">Pegá un CSV normalizado o usá IA para generarlo desde otro archivo.</p>
        </div>
        <a class="btn btn-secondary" href="${escapeHtml(MANUAL_SOURCE.onboardingPdf)}" target="_blank" rel="noopener">${icon("file-text", 16)}Guía completa (PDF)</a>
      </div>
      <div class="grid-2">
        <div class="utility-card">
          <h3>Skill de IA</h3>
          <p class="muted">Copiá el prompt, adjuntá tu archivo en ChatGPT o Claude y pegá el CSV resultante.</p>
          <button class="btn btn-secondary" data-action="copy-ai">${icon("copy", 16)}Copiar prompt para IA</button>
        </div>
        <div class="utility-card">
          <h3>Template CSV</h3>
          <p class="muted">Formato requerido: fecha, tipo, moneda y monto.</p>
          <button class="btn btn-secondary" data-action="download-template">${icon("download", 16)}Descargar template</button>
        </div>
      </div>
      <label class="field" style="margin-top:20px">
        <span class="label">CSV de movimientos</span>
        <textarea class="textarea" id="csvText" spellcheck="false" placeholder="fecha,tipo,moneda,monto&#10;2026-01-10,ingreso,ARS,100000&#10;2026-02-15,retiro,USD,500">${escapeHtml(state.manualCsv)}</textarea>
      </label>
      <div class="csv-status ${state.manualCsv.trim() ? "selected" : ""}" data-csv-status>
        ${icon(state.manualCsv.trim() ? "check-circle-2" : "file-text", 18)}
        <span>${state.manualCsv.trim() ? "CSV pegado y listo para importar." : "Pegá el CSV para continuar con la importación manual."}</span>
      </div>
      <div class="actions">
        <button class="btn btn-secondary" data-action="back">${icon("arrow-left", 16)}Volver</button>
        <button class="btn btn-primary" data-action="import">Importar movimientos${icon("arrow-right", 16)}</button>
      </div>
    </div>
  `, {
    afterRender() {
      $("[data-action='back']").addEventListener("click", () => {
        state.screen = "source";
        render();
      });
      $("[data-action='copy-ai']").addEventListener("click", async (event) => {
        state.manualCsv = $("#csvText").value;
        track("ai_prompt_copied");
        await navigator.clipboard.writeText(AI_PROMPT);
        event.currentTarget.innerHTML = `${icon("check", 16)}Prompt copiado`;
        refreshIcons();
      });
      $("#csvText").addEventListener("input", () => {
        state.manualCsv = $("#csvText").value;
        updateManualCsvStatus();
      });
      $("[data-action='download-template']").addEventListener("click", downloadCsvTemplate);
      $("[data-action='import']").addEventListener("click", importMovements);
    }
  });
}

function updateManualCsvStatus() {
  const status = $("[data-csv-status]");
  const ready = Boolean(state.manualCsv.trim());
  status.classList.toggle("selected", ready);
  status.innerHTML = `${icon(ready ? "check-circle-2" : "file-text", 18)}<span>${ready ? "CSV pegado y listo para importar." : "Pegá el CSV para continuar con la importación manual."}</span>`;
  refreshIcons();
}

async function importMovements() {
  try {
    let result;
    if (state.source === "manual_csv") {
      state.manualCsv = $("#csvText").value;
      result = parseManualCsv(state.manualCsv);
    } else {
      const plugin = window.CarteraV4Plugins?.get(state.source);
      if (!plugin) throw new Error("No se pudo cargar el importador seleccionado.");
      if (!state.file) throw new Error("Seleccioná un XLSX antes de importar.");
      const source = currentSourceConfig();
      const options = {};
      const accountField = source.accountField;
      if (accountField?.id) {
        options[accountField.optionKey || "account_id"] = document.getElementById(accountField.id)?.value.trim() || "";
      }
      result = await plugin.parse(state.file, options);
    }
    const portfolio = createPortfolioFromImport(result);
    track("movements_imported", { source_id: state.source, movement_count: portfolio.movements.length, has_errors: !!(result.errors?.length) });
    state.screen = "movements";
    state.file = null;
    state.fileReady = false;
    state.manualCsv = "";
    setNotice(result.errors?.length ? "warn" : "success", `Cartera creada con ${portfolio.movements.length} movimiento(s).`);
    render();
  } catch (error) {
    track("movements_import_error", { source_id: state.source, error_message: error.message });
    setNotice("error", error.message || "No se pudo importar movimientos.");
    render();
  }
}

function renderMovements() {
  const portfolio = activePortfolio();
  if (!portfolio) return renderStart();
  const lockDate = portfolio.movement_lock_date || null;
  const allMovements = portfolio.movements;
  const lockedMovements = lockDate ? allMovements.filter((m) => m.date <= lockDate) : [];
  const editableMovements = lockDate ? allMovements.filter((m) => m.date > lockDate) : allMovements;
  const showLocked = state.showLockedMovements;
  const editableRows = editableMovements.map((m) => movementRow(m)).join("");
  const lockedRows = lockedMovements.map((m) => lockedMovementRow(m)).join("");
  const totals = movementTotals(allMovements);
  const lastEditableDate = maxDate(editableMovements.map((m) => m.date));
  const extendAction = lockDate && editableMovements.length > 0 ? `
    <span class="lock-divider">·</span>
    <span class="lock-new-badge">${editableMovements.length} nuevo${editableMovements.length > 1 ? "s" : ""}</span>
    <button class="btn btn-ghost btn-sm" data-action="lock-all">Extender al ${fmtDate(lastEditableDate)}${icon("arrow-right", 13)}</button>
  ` : "";
  const quickLockAction = !lockDate && editableMovements.length > 0 ? `
    <button class="btn btn-ghost btn-sm" data-action="lock-all">${icon("lock", 13)}Bloquear al ${fmtDate(lastEditableDate)}</button>
  ` : "";
  const lockSection = `
    <div class="lock-section">
      <div class="lock-controls">
        <span class="lock-label">${icon("lock", 14)}${lockDate ? "Bloqueado hasta" : "Proteger hasta"}<span class="lock-tooltip" data-tooltip="Protege los movimientos hasta esta fecha: no se pueden agregar movimientos en ese período. Siguen usándose en los cálculos.">${icon("circle-help", 14)}</span></span>
        <input class="input input-sm" type="date" id="lockDateInput" value="${escapeHtml(lockDate || "")}">
        <button class="btn btn-secondary btn-sm" data-action="set-lock">Aplicar</button>
        ${lockDate ? `<button class="btn btn-ghost btn-sm" data-action="remove-lock">Quitar bloqueo</button>` : ""}
        ${extendAction}
        ${quickLockAction}
      </div>
    </div>
  `;
  const lockedSection = lockDate ? `
    <div>
      <div class="edit-table-head">
        <div class="edit-table-title locked-title">${icon("lock", 16)}Movimientos bloqueados hasta ${fmtDate(lockDate)}</div>
        <button class="btn btn-ghost btn-sm" data-action="toggle-locked">
          ${showLocked ? `${icon("eye-off", 13)}Ocultar` : `${icon("eye", 13)}Ver (${lockedMovements.length})`}
        </button>
      </div>
      <div class="${showLocked ? "" : "locked-rows-hidden"}">
        <div class="locked-movements-list">
          <div class="locked-movement-header">
            <span>Fecha</span><span>Tipo</span><span>Moneda</span><span>Monto</span><span></span>
          </div>
          ${lockedRows || '<div class="locked-movement-empty muted">Sin movimientos bloqueados.</div>'}
        </div>
      </div>
    </div>
  ` : "";
  renderLayout(`
    <div class="panel wide-panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">Editar movimientos</h2>
          <p class="panel-subtitle">La importación inicial está cerrada. Desde ahora solo editás o agregás movimientos manualmente.</p>
        </div>
        <div class="toolbar">
          <button class="btn btn-secondary" data-action="movement-help">${icon("circle-help", 16)}Cómo exportar movimientos</button>
          <div class="btn-group">
            <button class="btn btn-secondary" data-action="add-movement">${icon("plus", 16)}Agregar movimiento</button>
            <button class="btn btn-ghost" data-action="add-bulk">${icon("table-2", 16)}Agregar bulk</button>
          </div>
        </div>
      </div>
      ${lockSection}
      <div class="metric-grid movement-metrics">
        <div class="metric-card"><div class="metric-label">Movimientos</div><div class="metric-value">${allMovements.length}</div></div>
        <div class="metric-card"><div class="metric-label">Ingresos en ARS</div><div class="metric-value pos">${fmtMoney(totals.ingreso.ARS, "ARS")}</div></div>
        <div class="metric-card"><div class="metric-label">Ingresos en USD</div><div class="metric-value pos">${fmtMoney(totals.ingreso.USD, "USD")}</div></div>
        <div class="metric-card"><div class="metric-label">Retiros en ARS</div><div class="metric-value neg">${fmtMoney(totals.retiro.ARS, "ARS")}</div></div>
        <div class="metric-card"><div class="metric-label">Retiros en USD</div><div class="metric-value neg">${fmtMoney(totals.retiro.USD, "USD")}</div></div>
      </div>
      ${lockedSection}
      <div class="edit-table-head">
        <div class="edit-table-title">${icon("pencil-line", 16)}Movimientos editables</div>
      </div>
      <div class="table-wrap editable-table-wrap">
        <table class="table editable-table">
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Moneda</th><th class="num">Monto</th><th class="num">Acciones</th></tr></thead>
          <tbody>${editableRows || '<tr><td colspan="5" class="muted">Sin movimientos editables.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="actions">
        <button class="btn btn-secondary" data-action="back-start">${icon("arrow-left", 16)}Inicio</button>
        <button class="btn btn-primary" data-action="continue">Guardar y continuar${icon("arrow-right", 16)}</button>
      </div>
    </div>
  `, { afterRender: bindMovementEditor });
}

function movementRow(movement) {
  return `
    <tr data-movement="${escapeHtml(movement.id)}">
      <td>${editableField("calendar-days", `<input class="row-input" type="date" data-field="date" value="${escapeHtml(movement.date)}" aria-label="Fecha del movimiento">`)}</td>
      <td>
        ${editableField("arrow-left-right", `
        <select class="row-input" data-field="tipo" aria-label="Tipo de movimiento">
          <option value="ingreso" ${movement.tipo === "ingreso" ? "selected" : ""}>Ingreso</option>
          <option value="retiro" ${movement.tipo === "retiro" ? "selected" : ""}>Retiro</option>
        </select>
        `)}
      </td>
      <td>
        ${editableField("badge-dollar-sign", `
        <select class="row-input" data-field="moneda" aria-label="Moneda del movimiento">
          <option value="ARS" ${movement.moneda === "ARS" ? "selected" : ""}>ARS</option>
          <option value="USD" ${movement.moneda === "USD" ? "selected" : ""}>USD</option>
        </select>
        `)}
      </td>
      <td class="num">${editableField("coins", `<input class="row-input num" type="number" min="0.01" step="0.01" data-field="monto" value="${escapeHtml(movement.monto)}" aria-label="Monto del movimiento">`)}</td>
      <td class="num actions-cell"><button class="icon-btn danger-icon" data-action="remove-movement" aria-label="Eliminar movimiento">${icon("trash-2", 16)}</button></td>
    </tr>
  `;
}

function lockedMovementRow(movement) {
  const tipoLabel = movement.tipo === "ingreso" ? "Ingreso" : "Retiro";
  return `
    <div class="locked-movement-item">
      <div class="locked-cell">${icon("calendar-days", 14)}<span>${fmtDate(movement.date)}</span></div>
      <div class="locked-cell">${icon("arrow-left-right", 14)}<span>${tipoLabel}</span></div>
      <div class="locked-cell">${icon("badge-dollar-sign", 14)}<span>${movement.moneda}</span></div>
      <div class="locked-cell locked-cell-num">${icon("coins", 14)}<span>${fmtMoney(Number(movement.monto), movement.moneda)}</span></div>
      <div class="locked-cell locked-cell-icon">${icon("lock", 14)}</div>
    </div>
  `;
}

function readMovementEditor() {
  return Array.from(document.querySelectorAll("[data-movement]")).map((row, index) => normalizeMovement({
    id: row.dataset.movement || makeId(`mov-${index}`),
    date: $("[data-field='date']", row).value,
    tipo: $("[data-field='tipo']", row).value,
    moneda: $("[data-field='moneda']", row).value,
    monto: $("[data-field='monto']", row).value
  }));
}

function lockedMovementsOf(portfolio) {
  const lockDate = portfolio.movement_lock_date || null;
  return lockDate ? portfolio.movements.filter((m) => m.date <= lockDate) : [];
}

function bindMovementEditor() {
  const portfolio = activePortfolio();

  $("[data-action='back-start']").addEventListener("click", () => {
    state.screen = "start";
    render();
  });

  $("[data-action='movement-help']").addEventListener("click", () => {
    track("guide_opened", { guide_type: "movement", source_id: portfolio?.source_type || "unknown" });
    openMovementGuideModal();
  });

  $("[data-action='add-movement']").addEventListener("click", () => {
    openMovementModal();
  });

  $("[data-action='add-bulk']").addEventListener("click", () => {
    openBulkMovementModal();
  });

  $("[data-action='set-lock']")?.addEventListener("click", () => {
    const date = $("#lockDateInput").value;
    if (!date) { setNotice("error", "Ingresá una fecha de bloqueo."); return; }
    portfolio.movement_lock_date = date;
    state.showLockedMovements = false;
    persistActive();
    renderMovements();
  });

  $("[data-action='lock-all']")?.addEventListener("click", () => {
    const lastDate = maxDate(portfolio.movements.map((m) => m.date));
    if (!lastDate) return;
    portfolio.movement_lock_date = lastDate;
    state.showLockedMovements = false;
    persistActive();
    renderMovements();
  });

  $("[data-action='remove-lock']")?.addEventListener("click", () => {
    portfolio.movement_lock_date = null;
    state.showLockedMovements = false;
    persistActive();
    renderMovements();
  });

  $("[data-action='toggle-locked']")?.addEventListener("click", () => {
    state.showLockedMovements = !state.showLockedMovements;
    renderMovements();
  });

  document.querySelectorAll("[data-action='remove-movement']").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest("[data-movement]");
      const locked = lockedMovementsOf(portfolio);
      portfolio.movements = [...locked, ...readMovementEditor().filter((m) => m.id !== row.dataset.movement)];
      persistActive();
      renderMovements();
    });
  });

  $("[data-action='continue']").addEventListener("click", () => {
    const locked = lockedMovementsOf(portfolio);
    const editable = readMovementEditor();
    const combined = [...locked, ...editable];
    const errors = validateMovements(combined);
    if (errors.length) {
      setNotice("error", errors[0]);
      renderMovements();
      return;
    }
    portfolio.movements = cleanMovements(combined);
    if (!portfolio.snapshots.length || !portfolio.snapshots.some((snapshot) => String(snapshot.amount).trim())) {
      portfolio.snapshots = buildSnapshotDefaults(portfolio.movements);
    }
    persistActive();
    state.screen = "snapshots";
    state.notice = null;
    render();
  });
}

function openMovementModal() {
  const portfolio = activePortfolio();
  const defaultDate = maxDate(cleanMovements(readMovementEditor()).map((movement) => movement.date)) || todayIso();
  showModal(`
    <form class="modal-form" id="movementModalForm">
      <div class="modal-head">
        <div>
          <h2>Agregar movimiento</h2>
          <p>Registrá solo ingresos o retiros externos de dinero. No cargues compras, ventas, rentas ni movimientos internos.</p>
        </div>
        <button type="button" class="icon-btn" data-action="close-modal">${icon("x", 16)}</button>
      </div>
      <div class="form-grid">
        <label class="field">
          <span class="label">Fecha</span>
          <input class="input" type="date" id="modalMovementDate" value="${escapeHtml(defaultDate)}" required>
        </label>
        <label class="field">
          <span class="label">Tipo</span>
          <select class="select" id="modalMovementType">
            <option value="ingreso">Ingreso</option>
            <option value="retiro">Retiro</option>
          </select>
        </label>
        <label class="field">
          <span class="label">Moneda</span>
          <select class="select" id="modalMovementCurrency">
            <option value="ARS">ARS</option>
            <option value="USD">USD</option>
          </select>
        </label>
        <label class="field">
          <span class="label">Monto</span>
          <input class="input" type="number" min="0.01" step="0.01" id="modalMovementAmount" placeholder="0.00" required>
        </label>
      </div>
      <div class="modal-error" hidden></div>
      <div class="actions">
        <button type="button" class="btn btn-secondary" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Agregar movimiento${icon("check", 16)}</button>
      </div>
    </form>
  `, () => {
    $("#movementModalForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const row = normalizeMovement({
        id: makeId("mov"),
        date: $("#modalMovementDate").value,
        tipo: $("#modalMovementType").value,
        moneda: $("#modalMovementCurrency").value,
        monto: $("#modalMovementAmount").value
      });
      const errors = validateMovements([row]);
      if (errors.length) {
        setModalError(errors[0]);
        return;
      }
      const lockDate = portfolio.movement_lock_date;
      if (lockDate && row.date <= lockDate) {
        setModalError(`La fecha ${fmtDate(row.date)} está bloqueada hasta ${fmtDate(lockDate)}. No podés agregar movimientos en ese período.`);
        return;
      }
      const locked = lockedMovementsOf(portfolio);
      portfolio.movements = [...locked, ...readMovementEditor()];
      portfolio.movements.push(cleanMovements([row])[0]);
      invalidateResults();
      track("movement_added", { tipo: row.tipo, moneda: row.moneda });
      setNotice("success", "Movimiento agregado. Revisá la tabla y guardá para continuar.");
      closeModal();
      renderMovements();
    });
  });
}

function parseBulkCsv(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const rows = [];
  const errors = [];
  lines.forEach((line, idx) => {
    if (idx === 0 && /fecha|date/i.test(line.split(",")[0])) return;
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 4) { errors.push(`Línea ${idx + 1}: faltan columnas (se esperan fecha,tipo,moneda,monto).`); return; }
    rows.push({ date: parts[0], tipo: parts[1].toLowerCase(), moneda: parts[2].toUpperCase(), monto: parts[3], _line: idx + 1 });
  });
  return { rows, parseErrors: errors };
}

function openBulkMovementModal() {
  const portfolio = activePortfolio();
  const lockDate = portfolio.movement_lock_date || null;
  const lockNote = lockDate ? `<p class="muted" style="margin-top:8px">Los movimientos con fecha ≤ ${fmtDate(lockDate)} serán rechazados.</p>` : "";
  showModal(`
    <form class="modal-form" id="bulkModalForm">
      <div class="modal-head">
        <div>
          <h2>Agregar movimientos bulk</h2>
          <p>Pegá las filas en formato CSV: <code>fecha,tipo,moneda,monto</code>. La primera fila puede ser encabezado.</p>
          ${lockNote}
        </div>
        <button type="button" class="icon-btn" data-action="close-modal">${icon("x", 16)}</button>
      </div>
      <label class="field">
        <span class="label">CSV</span>
        <textarea class="input textarea-bulk" id="bulkCsvInput" rows="8" placeholder="fecha,tipo,moneda,monto&#10;2025-01-10,ingreso,ARS,100000&#10;2025-02-15,retiro,USD,500" required></textarea>
      </label>
      <div class="modal-error" hidden></div>
      <div class="actions">
        <button type="button" class="btn btn-secondary" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Agregar movimientos${icon("check", 16)}</button>
      </div>
    </form>
  `, () => {
    $("#bulkModalForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const text = $("#bulkCsvInput").value;
      const { rows, parseErrors } = parseBulkCsv(text);
      if (parseErrors.length) { setModalError(parseErrors[0]); return; }
      if (!rows.length) { setModalError("No se encontraron filas válidas."); return; }
      const blockedRows = lockDate ? rows.filter((r) => r.date <= lockDate) : [];
      if (blockedRows.length) {
        const sample = blockedRows.slice(0, 3).map((r) => `${fmtDate(r.date)}`).join(", ");
        setModalError(`${blockedRows.length} movimiento(s) tienen fecha bloqueada (hasta ${fmtDate(lockDate)}): ${sample}. Corregí las fechas o quitá el bloqueo.`);
        return;
      }
      const normalized = rows.map((r) => normalizeMovement({ id: makeId("mov"), date: r.date, tipo: r.tipo, moneda: r.moneda, monto: r.monto }));
      const validationErrors = validateMovements(normalized);
      if (validationErrors.length) { setModalError(validationErrors[0]); return; }
      const locked = lockedMovementsOf(portfolio);
      portfolio.movements = cleanMovements([...locked, ...readMovementEditor(), ...normalized]);
      invalidateResults();
      track("movement_bulk_added", { movement_count: normalized.length });
      setNotice("success", `${normalized.length} movimiento(s) agregados. Revisá la tabla y guardá para continuar.`);
      closeModal();
      renderMovements();
    });
  });
}

function movementTotals(movements) {
  const totals = { ingreso: { ARS: 0, USD: 0 }, retiro: { ARS: 0, USD: 0 } };
  cleanMovements(movements).forEach((movement) => {
    totals[movement.tipo][movement.moneda] += Number(movement.monto);
  });
  return totals;
}

function renderSnapshots() {
  const portfolio = activePortfolio();
  if (!portfolio) return renderStart();
  const rows = portfolio.snapshots.map(snapshotRow).join("");
  renderLayout(`
    <div class="panel wide-panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">Editar snapshots</h2>
          <p class="panel-subtitle">Agregá fotos del valor total de la cartera e indicá si son de inicio o cierre del día. El cierre incluye ingresos/retiros de esa fecha; el inicio todavía no los incluye.</p>
        </div>
        <div class="toolbar">
          <button class="btn btn-secondary" data-action="snapshot-help">${icon("circle-help", 16)}Ver cómo obtener snapshots</button>
          <button class="btn btn-secondary" data-action="add-snapshot">${icon("plus", 16)}Agregar snapshot</button>
        </div>
      </div>
      <div class="edit-table-head">
        <div class="edit-table-title">${icon("pencil-line", 16)}Snapshots editables</div>
      </div>
      <div class="table-wrap editable-table-wrap">
        <table class="table editable-table snapshot-editable-table">
          <thead><tr><th>Fecha</th><th>Moneda</th><th>Momento</th><th class="num">Valor total</th><th>Etiqueta</th><th class="num">Acciones</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="muted">Sin snapshots.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="actions">
        <button class="btn btn-secondary" data-action="back">${icon("arrow-left", 16)}Volver</button>
        <button class="btn btn-primary" data-action="continue">Guardar y continuar${icon("arrow-right", 16)}</button>
      </div>
    </div>
  `, { afterRender: bindSnapshotEditor });
}

function snapshotRow(snapshot) {
  return `
    <tr data-snapshot="${escapeHtml(snapshot.id)}">
      <td>${editableField("calendar-days", `<input class="row-input" type="date" data-field="date" value="${escapeHtml(snapshot.date)}" aria-label="Fecha del snapshot">`)}</td>
      <td>
        ${editableField("badge-dollar-sign", `
        <select class="row-input" data-field="currency" aria-label="Moneda del snapshot">
          <option value="ARS" ${snapshot.currency === "ARS" ? "selected" : ""}>ARS</option>
          <option value="USD" ${snapshot.currency === "USD" ? "selected" : ""}>USD</option>
        </select>
        `)}
      </td>
      <td>
        ${editableField("clock-3", `
        <select class="row-input" data-field="timing" aria-label="Momento del snapshot">
          <option value="end_day" ${snapshot.timing !== "start_day" ? "selected" : ""}>Cierre del día</option>
          <option value="start_day" ${snapshot.timing === "start_day" ? "selected" : ""}>Inicio del día</option>
        </select>
        `)}
      </td>
      <td class="num">${editableField("wallet-cards", `<input class="row-input num" type="number" min="0" step="0.01" data-field="amount" value="${escapeHtml(snapshot.amount)}" aria-label="Valor total del snapshot">`)}</td>
      <td>${editableField("tag", `<input class="row-input" data-field="label" value="${escapeHtml(snapshot.label)}" aria-label="Etiqueta del snapshot">`)}</td>
      <td class="num actions-cell">${snapshot.locked ? `<span class="locked-row">${icon("lock", 14)}</span>` : `<button class="icon-btn danger-icon" data-action="remove-snapshot" aria-label="Eliminar snapshot">${icon("trash-2", 16)}</button>`}</td>
    </tr>
  `;
}

function editableField(iconName, controlHtml) {
  return `
    <label class="editable-cell">
      ${icon(iconName, 15)}
      ${controlHtml}
    </label>
  `;
}

function readSnapshotEditor() {
  return Array.from(document.querySelectorAll("[data-snapshot]")).map((row, index) => normalizeSnapshot({
    id: row.dataset.snapshot || makeId(`snap-${index}`),
    date: $("[data-field='date']", row).value,
    currency: $("[data-field='currency']", row).value,
    timing: $("[data-field='timing']", row).value,
    amount: $("[data-field='amount']", row).value,
    label: $("[data-field='label']", row).value,
    locked: !$("[data-action='remove-snapshot']", row)
  }));
}

function bindSnapshotEditor() {
  $("[data-action='back']").addEventListener("click", () => {
    state.screen = "movements";
    render();
  });
  $("[data-action='add-snapshot']").addEventListener("click", () => {
    openSnapshotModal();
  });
  $("[data-action='snapshot-help']").addEventListener("click", () => {
    track("guide_opened", { guide_type: "snapshot", source_id: activePortfolio()?.source_type || "unknown" });
    openSnapshotGuideModal();
  });
  document.querySelectorAll("[data-action='remove-snapshot']").forEach((button) => {
    button.addEventListener("click", () => {
      const portfolio = activePortfolio();
      const row = button.closest("[data-snapshot]");
      portfolio.snapshots = readSnapshotEditor().filter((snapshot) => snapshot.id !== row.dataset.snapshot);
      persistActive();
      renderSnapshots();
    });
  });
  $("[data-action='continue']").addEventListener("click", () => {
    const portfolio = activePortfolio();
    portfolio.snapshots = readSnapshotEditor();
    const errors = validateSnapshots(portfolio.snapshots, portfolio.movements);
    if (errors.length) {
      setNotice("error", errors[0]);
      renderSnapshots();
      return;
    }
    portfolio.snapshots = portfolio.snapshots.sort(snapshotCompare);
    portfolio.benchmarks = ALL_BENCHMARK_IDS;
    persistActive();
    state.screen = "final";
    state.notice = null;
    invalidateResults();
    render();
  });
}

function openMovementGuideModal() {
  const portfolio = activePortfolio();
  const activeSource = portfolio?.source_type || state.source;
  const plugins = brokerPlugins();
  const hasMultiple = plugins.length > 1;

  const guideForPlugin = (p) => {
    const cfg = sourceConfigForPlugin(p);
    return { title: cfg.importTitle, steps: cfg.importSteps, pdf: p.onboardingPdf || null };
  };

  const bodyHtml = ({ title, steps }) => `
    <h3 class="movement-guide-title">${escapeHtml(title)}</h3>
    <ol class="guide-list snapshot-guide-list">
      ${steps.map((step, i) => `<li><strong>${i + 1}</strong><span>${escapeHtml(step)}</span></li>`).join("")}
    </ol>
  `;

  const pdfLinkHtml = (pdf) => pdf
    ? `<a class="btn btn-secondary" href="${escapeHtml(pdf)}" target="_blank" rel="noopener" data-pdf-action>${icon("file-text", 16)}Guía completa (PDF)</a>`
    : `<span data-pdf-action></span>`;

  const tabsHtml = hasMultiple ? `
    <div class="guide-plugin-tabs" role="tablist">
      ${plugins.map((p) => `
        <button class="guide-plugin-tab ${p.id === activeSource ? "active" : ""}" data-plugin-id="${escapeHtml(p.id)}" role="tab" aria-selected="${p.id === activeSource ? "true" : "false"}">
          ${escapeHtml(pluginLabel(p))}
        </button>
      `).join("")}
    </div>
  ` : "";

  const activePlugin = plugins.find((p) => p.id === activeSource) || plugins[0] || null;
  const initial = activePlugin ? guideForPlugin(activePlugin) : { title: "Cómo exportar movimientos", steps: [], pdf: null };

  showModal(`
    <div class="modal-form snapshot-guide-modal">
      <div class="modal-head">
        <div>
          <h2>Cómo exportar movimientos</h2>
          <p>Seguí los pasos para exportar el archivo de movimientos desde tu broker.</p>
        </div>
        <button type="button" class="icon-btn" data-action="close-modal">${icon("x", 16)}</button>
      </div>
      ${tabsHtml}
      <div class="snapshot-guide-body">
        ${bodyHtml(initial)}
      </div>
      <div class="actions">
        ${pdfLinkHtml(initial.pdf)}
        <button type="button" class="btn btn-primary" data-action="close-modal">Entendido${icon("check", 16)}</button>
      </div>
    </div>
  `, (wrapper) => {
    if (!hasMultiple) return;
    wrapper.querySelectorAll(".guide-plugin-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        wrapper.querySelectorAll(".guide-plugin-tab").forEach((t) => {
          t.classList.remove("active");
          t.setAttribute("aria-selected", "false");
        });
        tab.classList.add("active");
        tab.setAttribute("aria-selected", "true");
        const plugin = plugins.find((p) => p.id === tab.dataset.pluginId);
        const guide = plugin ? guideForPlugin(plugin) : initial;
        wrapper.querySelector(".snapshot-guide-body").innerHTML = bodyHtml(guide);
        const pdfEl = wrapper.querySelector("[data-pdf-action]");
        if (pdfEl) pdfEl.outerHTML = pdfLinkHtml(guide.pdf);
        refreshIcons();
      });
    });
  });
}

function snapshotGuideBody(guide) {
  return `
    <ol class="guide-list snapshot-guide-list">
      ${guide.steps.map((step, index) => `<li><strong>${index + 1}</strong><span>${escapeHtml(step)}</span></li>`).join("")}
    </ol>
    <div class="notice">${icon("info", 18)}<span>${escapeHtml(guide.note)}</span></div>
  `;
}

function openSnapshotGuideModal() {
  const portfolio = activePortfolio();
  const activeSource = portfolio?.source_type || state.source;
  const plugins = brokerPlugins();
  const hasMultiple = plugins.length > 1;

  const tabsHtml = hasMultiple ? `
    <div class="guide-plugin-tabs" role="tablist">
      ${plugins.map((p) => `
        <button class="guide-plugin-tab ${p.id === activeSource ? "active" : ""}" data-plugin-id="${escapeHtml(p.id)}" role="tab" aria-selected="${p.id === activeSource ? "true" : "false"}">
          ${escapeHtml(pluginLabel(p))}
        </button>
      `).join("")}
    </div>
  ` : "";

  const activePlugin = plugins.find((p) => p.id === activeSource) || plugins[0] || null;
  const initialGuide = activePlugin
    ? snapshotGuideForPlugin(activePlugin)
    : snapshotGuideForPortfolio(portfolio);
  const initialPdf = activePlugin?.onboardingPdf || null;

  const pdfLinkHtml = (pdf) => pdf
    ? `<a class="btn btn-secondary" href="${escapeHtml(pdf)}" target="_blank" rel="noopener" data-pdf-action>${icon("file-text", 16)}Guía completa (PDF)</a>`
    : `<span data-pdf-action></span>`;

  showModal(`
    <div class="modal-form snapshot-guide-modal">
      <div class="modal-head">
        <div>
          <h2>Cómo obtener snapshots</h2>
          <p>Seguí los pasos para obtener el valor total de la cartera desde tu broker.</p>
        </div>
        <button type="button" class="icon-btn" data-action="close-modal">${icon("x", 16)}</button>
      </div>
      ${tabsHtml}
      <div class="snapshot-guide-body">
        ${snapshotGuideBody(initialGuide)}
      </div>
      <div class="actions">
        ${pdfLinkHtml(initialPdf)}
        <button type="button" class="btn btn-primary" data-action="close-modal">Entendido${icon("check", 16)}</button>
      </div>
    </div>
  `, (wrapper) => {
    if (!hasMultiple) return;
    wrapper.querySelectorAll(".guide-plugin-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        wrapper.querySelectorAll(".guide-plugin-tab").forEach((t) => {
          t.classList.remove("active");
          t.setAttribute("aria-selected", "false");
        });
        tab.classList.add("active");
        tab.setAttribute("aria-selected", "true");
        const plugin = plugins.find((p) => p.id === tab.dataset.pluginId);
        const guide = plugin ? snapshotGuideForPlugin(plugin) : snapshotGuideForPortfolio(portfolio);
        wrapper.querySelector(".snapshot-guide-body").innerHTML = snapshotGuideBody(guide);
        const pdfEl = wrapper.querySelector("[data-pdf-action]");
        if (pdfEl) pdfEl.outerHTML = pdfLinkHtml(plugin?.onboardingPdf || null);
        refreshIcons();
      });
    });
  });
}

function snapshotGuideForPlugin(plugin) {
  const label = pluginLabel(plugin);
  const guide = plugin?.snapshotGuide || {};
  return {
    title: guide.title || `Cómo obtener snapshots en ${label}`,
    intro: guide.intro || "Un snapshot es una foto del valor total de la cartera en una fecha concreta.",
    steps: Array.isArray(guide.steps) && guide.steps.length ? guide.steps : defaultSnapshotSteps(label),
    note: guide.note || "Usá siempre el valor total de la cartera y mantené el mismo criterio de moneda y momento del día para todos los snapshots."
  };
}

function snapshotGuideForPortfolio(portfolio) {
  const source = portfolio?.source_type || state.source;
  const plugin = window.CarteraV4Plugins?.get?.(source) || null;
  if (plugin) return snapshotGuideForPlugin(plugin);
  const meta = sourceMeta(source);
  return {
    title: `Cómo obtener snapshots en ${meta.label}`,
    intro: "Un snapshot es una foto del valor total de la cartera en una fecha concreta.",
    steps: defaultSnapshotSteps(meta.label),
    note: "Usá siempre el valor total de la cartera y mantené el mismo criterio de moneda y momento del día para todos los snapshots."
  };
}

function defaultSnapshotSteps(sourceLabel) {
  return [
    `Abrí ${sourceLabel} y entrá a la vista donde se vea el valor total de la cartera.`,
    "Copiá el valor total consolidado y la moneda en la que está expresado.",
    "Definí si corresponde al inicio del día o al cierre del día.",
    "Cargá en esta pantalla la fecha, moneda, momento y valor total."
  ];
}

function openSnapshotModal() {
  const portfolio = activePortfolio();
  const currentSnapshots = readSnapshotEditor();
  const defaultDate = maxDate([
    ...currentSnapshots.map((snapshot) => snapshot.date),
    ...cleanMovements(portfolio.movements).map((movement) => movement.date)
  ]) || todayIso();
  showModal(`
    <form class="modal-form" id="snapshotModalForm">
      <div class="modal-head">
        <div>
          <h2>Agregar snapshot</h2>
          <p>Indicá si la foto representa el inicio o el cierre del día. Cierre del día incluye todos los ingresos y retiros de esa fecha; inicio del día todavía no los incluye.</p>
        </div>
        <button type="button" class="icon-btn" data-action="close-modal">${icon("x", 16)}</button>
      </div>
      <div class="form-grid">
        <label class="field">
          <span class="label">Fecha</span>
          <input class="input" type="date" id="modalSnapshotDate" value="${escapeHtml(defaultDate)}" required>
        </label>
        <label class="field">
          <span class="label">Moneda del valor</span>
          <select class="select" id="modalSnapshotCurrency">
            <option value="ARS">ARS</option>
            <option value="USD">USD</option>
          </select>
        </label>
        <label class="field">
          <span class="label">Momento</span>
          <select class="select" id="modalSnapshotTiming">
            <option value="end_day">Cierre del día</option>
            <option value="start_day">Inicio del día</option>
          </select>
        </label>
        <label class="field">
          <span class="label">Valor total</span>
          <input class="input" type="number" min="0" step="0.01" id="modalSnapshotAmount" placeholder="0.00" required>
        </label>
        <label class="field">
          <span class="label">Etiqueta</span>
          <input class="input" id="modalSnapshotLabel" value="Manual">
        </label>
      </div>
      <div class="notice">${icon("clock-3", 18)}<span>Un cierre del último día del mes también sirve como inicio del primer día del mes siguiente. Si ese día hubo aportes o retiros, elegí el momento correcto para que el rendimiento no quede distorsionado.</span></div>
      <div class="modal-error" hidden></div>
      <div class="actions">
        <button type="button" class="btn btn-secondary" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn btn-primary">Agregar snapshot${icon("check", 16)}</button>
      </div>
    </form>
  `, () => {
    $("#snapshotModalForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const row = normalizeSnapshot({
        id: makeId("snap"),
        date: $("#modalSnapshotDate").value,
        currency: $("#modalSnapshotCurrency").value,
        timing: $("#modalSnapshotTiming").value,
        amount: $("#modalSnapshotAmount").value,
        label: $("#modalSnapshotLabel").value || "Manual",
        locked: false
      });
      const amount = Number(row.amount);
      if (!isIsoDate(row.date)) {
        setModalError("Ingresá una fecha válida.");
        return;
      }
      if (String(row.amount).trim() === "" || !Number.isFinite(amount) || amount < 0) {
        setModalError("Ingresá un valor total válido.");
        return;
      }
      if (currentSnapshots.some((snapshot) => snapshot.date === row.date && snapshot.timing === row.timing)) {
        setModalError(`Ya existe un snapshot para ${fmtDate(row.date)} con ese momento del día.`);
        return;
      }
      portfolio.snapshots = readSnapshotEditor();
      portfolio.snapshots.push(row);
      portfolio.snapshots = portfolio.snapshots.sort(snapshotCompare);
      invalidateResults();
      track("snapshot_added", { currency: row.currency, timing: row.timing });
      setNotice("success", "Snapshot agregado. Revisá la tabla y guardá para continuar.");
      closeModal();
      renderSnapshots();
    });
  });
}

function snapshotOptions(portfolio) {
  const seen = new Set();
  return portfolio.snapshots
    .map(normalizeSnapshot)
    .filter((snapshot) => snapshot.date && String(snapshot.amount).trim() !== "" && Number.isFinite(Number(snapshot.amount)))
    .sort(snapshotCompare)
    .filter((snapshot) => {
      const key = `${snapshot.date}:${snapshot.timing}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function snapshotCompare(a, b) {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  const order = { start_day: 0, end_day: 1 };
  return (order[a.timing] ?? 1) - (order[b.timing] ?? 1);
}

function addDaysIso(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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

function makePeriod(mode, label, detail, startSnapshot, endSnapshot, benchmarkStart, benchmarkEnd, extra = {}) {
  const period = {
    mode,
    label,
    detail,
    from: startSnapshot.date,
    fromTiming: startSnapshot.timing,
    to: endSnapshot.date,
    toTiming: endSnapshot.timing,
    benchmarkStart,
    benchmarkEnd,
    ...extra
  };
  period.id = [
    period.mode,
    period.startYear || "",
    period.endValue || period.year || "",
    period.from,
    period.fromTiming,
    period.to,
    period.toTiming
  ].join(":");
  return period;
}

function snapshotRangeOptions(portfolio) {
  const snapshots = snapshotOptions(portfolio);
  const annual = [];
  const rangeStartYears = [];
  const currentYear = Number(todayIso().slice(0, 4));
  const availableYears = Array.from(new Set(snapshots.flatMap((snapshot) => {
    const year = Number(snapshot.date.slice(0, 4));
    return [year, year + 1];
  }))).sort((a, b) => a - b);

  availableYears.forEach((year) => {
    const startContext = startContextForYear(snapshots, year);
    const start = startContext?.snapshot || null;
    const closedEnd = endBoundaryForYear(snapshots, year);
    const isCurrentYear = year === currentYear;
    const end = closedEnd || (isCurrentYear ? latestSnapshotUntilToday(snapshots) : null);
    if (startContext) rangeStartYears.push(year);
    if (!start || !end || snapshotCompare(start, end) >= 0) return;
    const benchmarkEnd = closedEnd ? `${year}-12-31` : effectiveEndDate(end);
    const endLabel = closedEnd
      ? `${fmtDate(end.date)} (${end.timing === "end_day" ? "cierre" : "inicio"})`
      : `${fmtDate(effectiveEndDate(end))} (último dato)`;
    annual.push(makePeriod(
      "year",
      `Año ${year}${startContext.partial ? " (parcial)" : ""}`,
      `${fmtDate(start.date)} (${start.timing === "end_day" ? "cierre" : "inicio"}) - ${endLabel} · benchmark desde ${fmtDate(startContext.benchmarkStart)}`,
      start,
      end,
      startContext.benchmarkStart,
      benchmarkEnd,
      { year, partialStart: startContext.partial }
    ));
  });

  const latest = latestSnapshotUntilToday(snapshots);
  const validRangeStartYears = Array.from(new Set(rangeStartYears)).filter((year) => {
    const startContext = startContextForYear(snapshots, year);
    if (!startContext) return false;
    const start = startContext.snapshot;
    const hasClosedYear = annual.some((period) => period.year >= year && snapshotCompare(start, { date: period.to, timing: period.toTiming }) < 0);
    const hasLatest = latest && snapshotCompare(start, latest) < 0;
    return hasClosedYear || hasLatest;
  }).sort((a, b) => a - b);

  return { annual, rangeStartYears: validRangeStartYears, snapshots };
}

function rangeEndOptionsForStart(options, startYear) {
  const startContext = startContextForYear(options.snapshots, startYear);
  if (!startContext) return [];
  const start = startContext.snapshot;
  const ends = options.annual
    .filter((period) => period.year >= startYear && snapshotCompare(start, { date: period.to, timing: period.toTiming }) < 0)
    .map((period) => ({ value: String(period.year), label: String(period.year), period }));
  const latest = latestSnapshotUntilToday(options.snapshots);
  if (latest && snapshotCompare(start, latest) < 0) {
    const latestEnd = effectiveEndDate(latest);
    ends.push({ value: "latest", label: `Último snapshot (${fmtDate(latestEnd)})`, period: makePeriod(
      "range",
      `${startYear} a ${fmtDate(latestEnd)}`,
      `${fmtDate(start.date)} - ${fmtDate(latest.date)} · benchmark desde ${fmtDate(startContext.benchmarkStart)} hasta ${fmtDate(latestEnd)}`,
      start,
      latest,
      startContext.benchmarkStart,
      latestEnd,
      { startYear, endValue: "latest", partialStart: startContext.partial }
    ) });
  }
  return ends;
}

function rangePeriodForYears(options, startYear, endValue) {
  const endOptions = rangeEndOptionsForStart(options, startYear);
  const normalizedEndValue = endValue === "today" ? "latest" : endValue;
  const selected = endOptions.find((item) => item.value === String(normalizedEndValue)) || endOptions.at(-1);
  if (!selected) return null;
  if (selected.value === "latest") return selected.period;
  const endYear = Number(selected.value);
  const startContext = startContextForYear(options.snapshots, startYear);
  const start = startContext?.snapshot || null;
  const end = endBoundaryForYear(options.snapshots, endYear);
  if (!start || !end) return null;
  return makePeriod(
    "range",
    `${startYear} a ${endYear}`,
    `${fmtDate(start.date)} - ${fmtDate(end.date)} · benchmark desde ${fmtDate(startContext.benchmarkStart)}`,
    start,
    end,
    startContext.benchmarkStart,
    `${endYear}-12-31`,
    { startYear, endValue: String(endYear), partialStart: startContext.partial }
  );
}

function ensureResultRange(portfolio) {
  const options = snapshotRangeOptions(portfolio);
  if (!options.annual.length && !options.rangeStartYears.length) {
    state.resultRange = { mode: "year", from: "", to: "" };
    return state.resultRange;
  }

  let mode = ["year", "range"].includes(state.resultRange?.mode) ? state.resultRange.mode : "year";
  if (mode === "year" && !options.annual.length) mode = "range";
  if (mode === "range" && !options.rangeStartYears.length) mode = "year";

  let period = null;
  if (mode === "year") {
    period = options.annual.find((item) => item.year === state.resultRange?.year) || options.annual.at(-1);
  } else {
    const startYear = options.rangeStartYears.includes(Number(state.resultRange?.startYear))
      ? Number(state.resultRange.startYear)
      : options.rangeStartYears[0];
    period = rangePeriodForYears(options, startYear, state.resultRange?.endValue || "latest");
  }
  state.resultRange = period;
  return state.resultRange;
}

function portfolioForResultRange(portfolio) {
  const range = ensureResultRange(portfolio);
  const startBound = { date: range.from, timing: range.fromTiming || "end_day" };
  const endBound = { date: range.to, timing: range.toTiming || "end_day" };
  return {
    ...portfolio,
    benchmarks: ALL_BENCHMARK_IDS,
    benchmark_start: range.benchmarkStart,
    benchmark_end: range.benchmarkEnd,
    snapshots: snapshotOptions(portfolio).filter((snapshot) => snapshotCompare(snapshot, startBound) >= 0 && snapshotCompare(snapshot, endBound) <= 0)
  };
}

function currentResultKey(portfolio) {
  const range = ensureResultRange(portfolio);
  return `${portfolio.id}:${portfolio.updated_at}:${range.id}`;
}

function queueResultCalculation(portfolio) {
  const key = currentResultKey(portfolio);
  state.calculating = true;
  state.result = null;
  state.resultKey = key;
  queueMicrotask(async () => {
    try {
      const current = activePortfolio();
      if (!current) throw new Error("No hay una cartera activa.");
      state.result = await calculatePortfolio(portfolioForResultRange(current));
      state.calculating = false;
      state.notice = null;
      track("results_calculated", {
        source_id: current.source_type || "unknown",
        xirr_ars: state.result?.xirr?.ARS?.period ?? null,
        xirr_usd: state.result?.xirr?.USD?.period ?? null,
        snapshot_count: (current.snapshots || []).length,
        movement_count: (current.movements || []).length
      });
      render();
    } catch (error) {
      state.result = null;
      state.resultKey = "";
      state.calculating = false;
      setNotice("error", error.message || "No se pudo calcular rendimiento.");
      render();
    }
  });
}

function renderFinal() {
  const portfolio = activePortfolio();
  if (!portfolio) return renderStart();
  const snapshots = snapshotOptions(portfolio);
  if (snapshots.length < 2) {
    renderLayout(`
      <div class="panel">
        <div class="panel-head"><div><h2 class="panel-title">Resultados</h2><p class="panel-subtitle">Necesitás al menos dos snapshots con valor para calcular rendimiento.</p></div></div>
        <div class="actions">
          <button class="btn btn-secondary" data-action="back">${icon("arrow-left", 16)}Volver</button>
          <button class="btn btn-primary" data-action="snapshots">Cargar snapshots${icon("arrow-right", 16)}</button>
        </div>
      </div>
    `, {
      afterRender() {
        $("[data-action='back']").addEventListener("click", () => {
          state.screen = "start";
          render();
        });
        $("[data-action='snapshots']").addEventListener("click", () => {
          state.screen = "snapshots";
          render();
        });
      }
    });
    return;
  }
  const range = ensureResultRange(portfolio);
  if (!range?.id) {
    renderLayout(`
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Resultados</h2>
            <p class="panel-subtitle">Para filtrar por año o rango de años necesitás snapshots de inicio/cierre de año.</p>
          </div>
        </div>
        <div class="notice warn">${icon("calendar-clock", 18)}<span>Usá un snapshot de cierre del 31/12 o uno de inicio del 01/01. Un cierre del 31/12 sirve como inicio del año siguiente.</span></div>
        <div class="actions">
          <button class="btn btn-secondary" data-action="back">${icon("arrow-left", 16)}Volver</button>
          <button class="btn btn-primary" data-action="snapshots">Cargar snapshots${icon("arrow-right", 16)}</button>
        </div>
      </div>
    `, {
      afterRender() {
        $("[data-action='back']").addEventListener("click", () => {
          state.screen = "start";
          render();
        });
        $("[data-action='snapshots']").addEventListener("click", () => {
          state.screen = "snapshots";
          render();
        });
      }
    });
    return;
  }
  const key = currentResultKey(portfolio);
  if (!state.calculating && (!state.result || state.resultKey !== key)) {
    queueResultCalculation(portfolio);
  }
  if (state.calculating) {
    renderLayout(`
      <div class="panel">
        <div class="panel-head"><div><h2 class="panel-title">Calculando resultados</h2><p class="panel-subtitle">Leyendo benchmarks y tipos de cambio desde SQLite.</p></div></div>
        <div class="notice">${icon("loader-circle", 18)}<span>Esto tarda unos segundos.</span></div>
      </div>
    `);
    return;
  }
  if (!state.result) {
    renderLayout(`
      <div class="panel">
        <div class="panel-head"><div><h2 class="panel-title">Resultados</h2><p class="panel-subtitle">Calculá el rendimiento para ver los resultados.</p></div></div>
        <div class="actions actions-right"><button class="btn btn-primary" data-action="calc">Calcular resultados${icon("arrow-right", 16)}</button></div>
      </div>
    `, {
      afterRender() {
        $("[data-action='calc']").addEventListener("click", () => {
          invalidateResults();
          render();
        });
      }
    });
    return;
  }

  const dbDate = fmtDbGeneratedAt(state.result.db_generated_at);
  renderLayout(`
    <div class="panel wide-panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">Resultados de ${escapeHtml(portfolio.portfolio_name)}</h2>
          <p class="panel-subtitle">XIRR, Modified Dietz y todos los benchmarks calculados del lado frontend.</p>
        </div>
        ${dbDate ? `<span class="db-freshness">${icon("database", 13)}Datos al ${escapeHtml(dbDate)}</span>` : ""}
      </div>
      ${rangeControls(portfolio)}
      <div class="result-grid">
        ${resultCard("ARS", state.result.results.ARS, state.result.xirr.ARS, state.result)}
        ${resultCard("USD", state.result.results.USD, state.result.xirr.USD, state.result)}
      </div>
      ${benchmarkAlerts(state.result)}
      ${state.result.warnings.map((warning) => `<div class="notice warn">${icon("triangle-alert", 18)}<span>${escapeHtml(warning)}</span></div>`).join("")}
      <div class="table-wrap" style="margin-top:22px">
        <table class="table">
          <thead><tr><th>Benchmark</th><th>Moneda</th><th class="num">Cartera XIRR</th><th class="num">Benchmark</th><th class="num">Diferencia ${ppHelp()}</th></tr></thead>
          <tbody>
            ${state.result.benchmarks.map((item) => {
              const portfolioReturn = state.result.xirr[item.group]?.period ?? null;
              const diff = portfolioReturn !== null && item.return !== null ? portfolioReturn - item.return : null;
              return `<tr><td><strong>${escapeHtml(item.label)}</strong></td><td>${item.group}</td><td class="num ${toneClass(portfolioReturn)}">${fmtPct(portfolioReturn)}</td><td class="num ${toneClass(item.return)}">${fmtPct(item.return)}</td><td class="num ${toneClass(diff)}">${fmtPp(diff)}</td></tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      <div class="actions">
        <button class="btn btn-secondary" data-action="back">${icon("arrow-left", 16)}Snapshots</button>
        <button class="btn btn-secondary" data-action="backup">${icon("archive", 16)}Backup JSON</button>
      </div>
      ${calculationExplanation(state.result)}
      <button class="btn btn-ghost db-explorer-btn" data-action="open-db-explorer">
        ${icon("database", 15)}Explorar base de datos de mercado
      </button>
    </div>
  `, {
    afterRender() {
      bindRangeControls();
      $("[data-action='back']").addEventListener("click", () => {
        state.screen = "snapshots";
        render();
      });
      $("[data-action='backup']").addEventListener("click", () => {
        track("backup_exported", { portfolio_count: 1 });
        downloadJson(backupPortfolios([portfolio]), `cartera-v4-${todayIso()}.json`);
      });
      $("[data-action='open-db-explorer']").addEventListener("click", () => {
        state.screen = "db-explorer";
        state.notice = null;
        render();
      });
    }
  });
}

function rangeControls(portfolio) {
  const range = ensureResultRange(portfolio);
  const options = snapshotRangeOptions(portfolio);
  const annualOptions = options.annual.map((period) => `<option value="${period.year}" ${period.year === range.year ? "selected" : ""}>${escapeHtml(period.label)}</option>`).join("");
  const startYear = range.startYear || options.rangeStartYears[0] || "";
  const endOptions = startYear ? rangeEndOptionsForStart(options, Number(startYear)) : [];
  const rangeEndOptions = endOptions.map((item) => `<option value="${escapeHtml(item.value)}" ${item.value === String(range.endValue || "") ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
  const rangeStartOptions = options.rangeStartYears.map((year) => `<option value="${year}" ${year === Number(startYear) ? "selected" : ""}>${year}</option>`).join("");
  return `
    <div class="range-panel" data-range-mode="${escapeHtml(range.mode)}" data-range-from="${escapeHtml(range.from)}" data-range-to="${escapeHtml(range.to)}">
      <div>
        <div class="metric-label">Rango de cálculo</div>
        <p class="muted">Filtrá por año calendario o rango de años. El benchmark termina en la fecha efectiva del último snapshot del período y los benchmarks mensuales se cortan en el último mes publicado.</p>
        <div class="segment-control" role="tablist" aria-label="Modo de rango">
          <button type="button" class="${range.mode === "year" ? "active" : ""}" data-range-mode-option="year" ${options.annual.length ? "" : "disabled"}>Anual</button>
          <button type="button" class="${range.mode === "range" ? "active" : ""}" data-range-mode-option="range" ${options.rangeStartYears.length ? "" : "disabled"}>Rango</button>
        </div>
      </div>
      <div class="range-fields ${range.mode === "range" ? "range-years" : ""}">
        ${range.mode === "year" ? `
          <label class="field full">
            <span class="label">Año</span>
            <select class="select" id="rangeYear">${annualOptions}</select>
            <span class="field-hint">${escapeHtml(range.detail || "")}</span>
          </label>
        ` : ""}
        ${range.mode === "range" ? `
          <label class="field">
            <span class="label">Desde</span>
            <select class="select" id="rangeStartYear">${rangeStartOptions}</select>
          </label>
          <label class="field">
            <span class="label">Hasta</span>
            <select class="select" id="rangeEndYear">${rangeEndOptions}</select>
          </label>
          <span class="field-hint full">${escapeHtml(range.detail || "")}</span>
        ` : ""}
      </div>
    </div>
  `;
}

function bindRangeControls() {
  const portfolio = activePortfolio();
  if (!portfolio) return;
  const options = snapshotRangeOptions(portfolio);

  document.querySelectorAll("[data-range-mode-option]").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.rangeModeOption;
      if (mode === "year") state.resultRange = { mode, year: options.annual.at(-1)?.year };
      if (mode === "range") state.resultRange = { mode, startYear: options.rangeStartYears[0], endValue: "latest" };
      invalidateResults();
      render();
    });
  });

  $("#rangeYear")?.addEventListener("change", (event) => {
    state.resultRange = { mode: "year", year: Number(event.target.value) };
    invalidateResults();
    render();
  });

  $("#rangeStartYear")?.addEventListener("change", (event) => {
    state.resultRange = { mode: "range", startYear: Number(event.target.value), endValue: "latest" };
    invalidateResults();
    render();
  });

  $("#rangeEndYear")?.addEventListener("change", (event) => {
    state.resultRange = { mode: "range", startYear: Number($("#rangeStartYear").value), endValue: event.target.value };
    invalidateResults();
    render();
  });
}

function ppHelp() {
  return `
    <span class="pp-help" tabindex="0" title="pp significa puntos porcentuales. Ejemplo: si tu cartera rindió 10% y el benchmark 7%, la diferencia es +3 pp.">
      ${icon("info", 13)} pp
    </span>
  `;
}

function benchmarkComparisons(result, group) {
  return result.benchmarks
    .filter((item) => item.group === group)
    .map((item) => {
      const portfolioReturn = result.xirr[item.group]?.period ?? null;
      const diff = portfolioReturn !== null && item.return !== null ? portfolioReturn - item.return : null;
      return { ...item, portfolioReturn, diff };
    });
}

function benchmarkChips(allResult, group) {
  const rows = benchmarkComparisons(allResult, group);
  if (!rows.length) return "";
  return `
    <div class="benchmark-chip-section">
      <div class="metric-label">Rendimiento contra ${ppHelp()}</div>
      <div class="benchmark-chip-list">
        ${rows.map((item) => `
          <span class="benchmark-chip ${item.diff === null ? "neutral" : Number(item.diff) >= 0 ? "win" : "loss"}" title="La diferencia está expresada en puntos porcentuales frente al benchmark.">
            ${escapeHtml(item.label)} ${fmtPp(item.diff)}
          </span>
        `).join("")}
      </div>
    </div>
  `;
}

function benchmarkAlerts(result) {
  const rows = result.benchmarks.map((item) => {
    const portfolioReturn = result.xirr[item.group]?.period ?? null;
    const diff = portfolioReturn !== null && item.return !== null ? portfolioReturn - item.return : null;
    return { ...item, diff };
  }).filter((item) => item.diff !== null && Number.isFinite(Number(item.diff)));
  if (!rows.length) return "";
  return `
    <div class="benchmark-alert-grid">
      ${rows.map((item) => {
        const won = item.diff >= 0;
        return `
          <div class="benchmark-alert ${won ? "win" : "loss"}">
            ${icon(won ? "trending-up" : "trending-down", 18)}
            <span>${won ? "Le has ganado al" : "Has perdido contra el"} <strong>${escapeHtml(item.label)}</strong> por <strong>${fmtPp(item.diff)}</strong>.</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function calculationExplanation(result) {
  return `
    <details class="calculation-explanation">
      <summary class="calculation-summary">
        <span class="calculation-summary-icon">${icon("chevron-down", 18)}</span>
        <div>
          <h3>Cómo se llegó a cada valor</h3>
          <p>Los importes están expresados en la moneda de cada bloque. Cuando una foto o movimiento está en otra moneda, se convierte con el Dólar MEP del día cargado en SQLite.</p>
        </div>
        <span class="calculation-summary-action">Ver detalle</span>
      </summary>
      <div class="calculation-body">
        <div class="calculation-currency-grid">
          ${currencyCalculationExplanation("ARS", result.results.ARS, result.xirr.ARS)}
          ${currencyCalculationExplanation("USD", result.results.USD, result.xirr.USD)}
        </div>
        ${benchmarkCalculationExplanation(result)}
      </div>
    </details>
  `;
}

function currencyCalculationExplanation(currency, result, xirr) {
  if (!result) {
    return `
      <div class="calc-block">
        <h4>${currencyTitle(currency)}</h4>
        <p class="muted">No hay datos suficientes para calcular valores en esta moneda.</p>
      </div>
    `;
  }

  const netCf = result.net_cf ?? result.aportes - result.retiros;
  const gain = result.ganancia_neta ?? result.emv - result.bmv - netCf;

  return `
    <div class="calc-block">
      <h4>${currencyTitle(currency)}</h4>
      <div class="calc-value-list">
        ${calcValue("Valor inicial", fmtMoney(result.bmv, currency), `Snapshot de ${fmtDate(result.bmv_date)} (${timingLabel(result.bmv_timing)}).`)}
        ${calcValue("Valor final", fmtMoney(result.emv, currency), `Snapshot de ${fmtDate(result.emv_date)} (${timingLabel(result.emv_timing)}).`)}
        ${calcValue("Aportes", fmtMoney(result.aportes, currency), "Suma de movimientos tipo ingreso dentro del rango efectivo.")}
        ${calcValue("Retiros", fmtMoney(result.retiros, currency), "Suma de movimientos tipo retiro dentro del rango efectivo.")}
        ${calcValue("Flujo neto", fmtMoney(netCf, currency), "Aportes menos retiros.")}
        ${calcValue("Ganancia neta", fmtMoney(gain, currency), `Valor final - valor inicial - flujo neto.`)}
      </div>
      ${modifiedDietzExplanation(currency, result)}
      ${xirrCalculationExplanation(currency, xirr)}
    </div>
  `;
}

function calcValue(label, value, detail) {
  return `
    <div class="calc-value">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </div>
  `;
}

function modifiedDietzExplanation(currency, result) {
  const periods = result.sub_periods || [];
  if (!periods.length) return "";

  if (periods.length === 1) {
    const period = periods[0];
    return `
      <div class="calc-formula">
        <strong>Modified Dietz</strong>
        <span>Capital base = valor inicial + flujos ponderados por días = ${fmtMoney(period.capital_base, currency)}.</span>
        <span>Rendimiento = ganancia neta / capital base = ${fmtMoney(period.ganancia_neta, currency)} / ${fmtMoney(period.capital_base, currency)} = ${fmtPct(period.rendimiento)}.</span>
      </div>
    `;
  }

  return `
    <div class="calc-formula">
      <strong>Modified Dietz encadenado</strong>
      <span>Se calcula cada tramo entre snapshots y se encadena: ${periods.map((period) => `(1 + ${fmtPct(period.rendimiento, false)})`).join(" x ")} - 1 = ${fmtPct(result.rendimiento)}.</span>
    </div>
    <div class="calc-table-wrap">
      <table class="calc-table">
        <thead><tr><th>Tramo</th><th class="num">Ganancia</th><th class="num">Capital base</th><th class="num">Dietz</th></tr></thead>
        <tbody>
          ${periods.map((period) => `
            <tr>
              <td>${fmtDate(period.bmv_date)} - ${fmtDate(period.emv_date)}</td>
              <td class="num ${toneClass(period.ganancia_neta)}">${fmtMoney(period.ganancia_neta, currency)}</td>
              <td class="num">${fmtMoney(period.capital_base, currency)}</td>
              <td class="num ${toneClass(period.rendimiento)}">${fmtPct(period.rendimiento)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function xirrCalculationExplanation(currency, xirr) {
  const flows = xirr?.cashflows || [];
  if (!flows.length) {
    return `
      <div class="calc-formula">
        <strong>XIRR</strong>
        <span>No se pudo calcular porque los flujos no tienen al menos una entrada y una salida.</span>
      </div>
    `;
  }

  const days = daysBetween(flows[0].date, flows[flows.length - 1].date);
  return `
    <div class="calc-formula">
      <strong>XIRR</strong>
      <span>Anualizado: tasa que hace que el valor presente neto de los flujos sea 0 = ${fmtPct(xirr.annual)}.</span>
      <span>Período: (1 + anualizado) ^ (${days} / 365) - 1 = ${fmtPct(xirr.period)}.</span>
      <details>
        <summary>Flujos usados (${flows.length})</summary>
        <div class="calc-flow-list">
          ${flows.map((flow, index) => `
            <div class="calc-flow">
              <div class="calc-flow-main">
                <span>${fmtDate(flow.date)} · ${cashflowLabel(flow, index, flows.length)}</span>
                ${cashflowConversionDetail(flow)}
              </div>
              <strong class="${toneClass(flow.amount)}">${fmtSignedMoney(flow.amount, currency)}</strong>
            </div>
          `).join("")}
        </div>
      </details>
    </div>
  `;
}

function benchmarkCalculationExplanation(result) {
  if (!result.benchmarks.length) return "";
  return `
    <div class="calc-block calc-block-wide">
      <h4>Benchmarks y diferencias</h4>
      <p class="muted">Cada benchmark se calcula para el mismo rango efectivo del resultado. Primero se obtiene el rendimiento propio del benchmark y después se compara contra el XIRR del período de la cartera en la misma moneda.</p>
      <div class="calc-table-wrap">
        <table class="calc-table benchmark-calc-table">
          <thead><tr><th>Benchmark</th><th class="num">Resultado benchmark</th><th>Cómo se llega</th><th class="num">Diferencia</th></tr></thead>
          <tbody>
            ${result.benchmarks.map((item) => {
              const portfolioReturn = result.xirr[item.group]?.period ?? null;
              const diff = portfolioReturn !== null && item.return !== null ? portfolioReturn - item.return : null;
              const differenceFormula = diff !== null ? `${fmtPct(portfolioReturn)} - ${fmtPct(item.return)} = ${fmtPp(diff)}` : "N/D";
              return `
                <tr>
                  <td>
                    <strong>${escapeHtml(item.label)}</strong>
                    <small>${escapeHtml(item.group)} · ${escapeHtml(benchmarkSourceLabel(item))}</small>
                  </td>
                  <td class="num ${toneClass(item.return)}">${fmtPct(item.return)}</td>
                  <td>${benchmarkResultBreakdown(item)}</td>
                  <td class="num ${toneClass(diff)}">${escapeHtml(differenceFormula)}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function benchmarkResultBreakdown(item) {
  if (item.return === null || item.return === undefined || !Number.isFinite(Number(item.return))) {
    return `<span class="muted">Sin datos suficientes para el rango seleccionado.</span>`;
  }

  const detail = item.detail || {};
  if (detail.method === "exchange_rates") {
    return `
      <div class="benchmark-method">
        <span>Rango usado: ${fmtDate(detail.start)} - ${fmtDate(detail.end)}.</span>
        <span>Tipo de cambio inicial: ${fmtRate(detail.start_rate)}. Tipo de cambio final: ${fmtRate(detail.end_rate)}.</span>
        <span>Resultado = tipo de cambio final / tipo de cambio inicial - 1 = ${fmtRate(detail.end_rate)} / ${fmtRate(detail.start_rate)} - 1 = ${fmtPct(item.return)}.</span>
      </div>
    `;
  }

  if (detail.method === "spy_cashflow") {
    return spyCashflowBreakdown(item, detail);
  }

  const periods = detail.periods || [];
  const methodText = detail.method === "tna_prorated"
    ? "Se toma la TNA mensual publicada, se prorratea por los días activos del mes y se acumula multiplicando cada factor."
    : "Se toma el rendimiento mensual publicado, se pondera por los días activos del mes y se acumula multiplicando cada factor.";

  return `
    <div class="benchmark-method">
      <span>Rango usado: ${fmtDate(detail.start)} - ${fmtDate(detail.end)}.</span>
      <span>${escapeHtml(methodText)}</span>
      <span>Factor acumulado = ${fmtFactor(detail.factor)}. Resultado = factor acumulado - 1 = ${fmtPct(item.return)}.</span>
      ${periods.length ? `
        <details class="benchmark-detail">
          <summary>Ver meses usados (${periods.length})</summary>
          <div class="calc-table-wrap compact">
            <table class="calc-table benchmark-period-table">
              <thead><tr><th>Mes</th><th>Dato publicado</th><th>Días</th><th class="num">Tramo</th></tr></thead>
              <tbody>
                ${periods.map((period) => benchmarkPeriodRow(detail.method, period)).join("")}
              </tbody>
            </table>
          </div>
        </details>
      ` : ""}
    </div>
  `;
}

function spyCashflowBreakdown(item, detail) {
  const steps = detail.steps || [];
  const movSteps = steps.filter((s) => s.type === "ingreso" || s.type === "retiro");
  const initialStep = steps.find((s) => s.type === "inicial");
  const finalStep = steps.find((s) => s.type === "final");

  const stepRows = steps.map((step) => {
    const isInitial = step.type === "inicial";
    const isFinal = step.type === "final";
    const typeLabel = isInitial ? "Inicio" : isFinal ? "Cierre" : step.type === "ingreso" ? "Ingreso" : "Retiro";
    const deltaSign = step.shares_delta >= 0 ? "+" : "";
    const sharesCell = isFinal
      ? `<td class="num">${fmtDecimal(step.shares_running, 4, 6)}</td>`
      : `<td class="num ${step.shares_delta >= 0 ? "pos" : "neg"}">${deltaSign}${fmtDecimal(step.shares_delta, 4, 6)}</td>`;
    const amountCell = isFinal
      ? `<td class="num">${fmtMoney(step.amount_usd, "USD")}</td>`
      : `<td class="num">${fmtMoney(step.amount_usd, "USD")}${step.rate ? `<small>TC ${fmtRate(step.rate)}</small>` : ""}</td>`;
    return `
      <tr>
        <td>${fmtDate(step.date)} <small>${escapeHtml(typeLabel)}</small></td>
        <td class="num">USD ${fmtDecimal(step.price, 2, 2)}</td>
        ${amountCell}
        ${sharesCell}
        <td class="num">${fmtDecimal(step.shares_running, 4, 6)}</td>
      </tr>
    `;
  }).join("");

  return `
    <div class="benchmark-method">
      <span>Simula comprar y vender SPY con exactamente los mismos movimientos de tu cartera, al precio del día de cada operación.</span>
      <span>
        Inicio ${fmtDate(detail.bmv_date)}: USD ${fmtDecimal(detail.initial_shares, 4, 6)} acciones
        (${fmtMoney(initialStep?.amount_usd, "USD")} ÷ USD ${fmtDecimal(detail.price_start, 2, 2)}).
        ${movSteps.length ? `${movSteps.length} movimiento(s) intermedio(s).` : "Sin movimientos intermedios."}
      </span>
      <span>
        Cierre ${fmtDate(detail.emv_date)}: ${fmtDecimal(detail.final_shares, 4, 6)} acciones × USD ${fmtDecimal(detail.price_end, 2, 2)} = ${fmtMoney(detail.emv_spy, "USD")}.
      </span>
      <span>XIRR = ${fmtPct(detail.xirr_annual)} anual → (1 + ${fmtPct(detail.xirr_annual, false)}) ^ (${detail.xirr_days} / 365) - 1 = ${fmtPct(item.return)} en el período.</span>
      <details class="benchmark-detail">
        <summary>Ver tabla de operaciones (${steps.length})</summary>
        <div class="calc-table-wrap compact">
          <table class="calc-table benchmark-period-table">
            <thead>
              <tr>
                <th>Fecha / Tipo</th>
                <th class="num">Precio SPY</th>
                <th class="num">Monto USD</th>
                <th class="num">Acciones Δ / total</th>
                <th class="num">Acciones acum.</th>
              </tr>
            </thead>
            <tbody>${stepRows}</tbody>
          </table>
        </div>
      </details>
    </div>
  `;
}

function benchmarkPeriodRow(method, period) {
  const month = fmtMonth(period.month);
  if (method === "tna_prorated") {
    return `
      <tr>
        <td>${escapeHtml(month)}</td>
        <td>TNA ${fmtPct(period.tna, false)}</td>
        <td>${Number(period.active_days)} / ${Number(period.year_days || 365)}</td>
        <td class="num">${fmtPct(period.tna, false)} x ${Number(period.active_days)} / ${Number(period.year_days || 365)} = ${fmtPct(period.period_return)}</td>
      </tr>
    `;
  }

  return `
    <tr>
      <td>${escapeHtml(month)}</td>
      <td>${fmtPct(period.monthly_return, false)}</td>
      <td>${Number(period.active_days)} / ${Number(period.month_days)}</td>
      <td class="num">(1 + ${fmtPct(period.monthly_return, false)}) ^ ${fmtDecimal(period.month_weight, 2, 4)} - 1 = ${fmtPct(period.period_return)}</td>
    </tr>
  `;
}

function currencyTitle(currency) {
  return currency === "ARS" ? "Pesos - ARS" : "Dólares - USD MEP";
}

function timingLabel(timing) {
  return timing === "start_day" ? "inicio del día" : "cierre del día";
}

function cashflowLabel(flow, index, total) {
  if (index === 0) return "Valor inicial";
  if (index === total - 1) return "Valor final";
  return Number(flow.amount) < 0 ? "Aporte" : "Retiro";
}

function cashflowConversionDetail(flow) {
  const conversion = flow.conversion || {};
  if (!conversion.converted || !Number.isFinite(Number(conversion.rate))) return "";
  const original = fmtMoney(conversion.source_amount, conversion.source_currency);
  const tc = fmtRate(conversion.rate);
  return `<small>Original: ${escapeHtml(original)} · TC: ${escapeHtml(tc)} por 1 USD</small>`;
}

function fmtSignedMoney(value, currency) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "N/D";
  const sign = amount >= 0 ? "+" : "-";
  return `${sign}${fmtMoney(Math.abs(amount), currency)}`;
}

function fmtDecimal(value, minimumFractionDigits = 2, maximumFractionDigits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "N/D";
  return Number(value).toLocaleString("es-AR", { minimumFractionDigits, maximumFractionDigits });
}

function fmtFactor(value) {
  return fmtDecimal(value, 4, 6);
}

function fmtRate(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "N/D";
  return `$ ${Number(value).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtMonth(monthIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monthIso || "")) return monthIso || "";
  const [year, month] = monthIso.split("-");
  return `${month}/${year}`;
}

function fmtDbGeneratedAt(isoString) {
  if (!isoString) return null;
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleDateString("es-AR", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  } catch {
    return null;
  }
}

function benchmarkSourceLabel(item) {
  if (item.id === "dolar_mep" && item.source === "exchange_rates") return "Variación del tipo de cambio MEP diario";
  if (item.id === "plazo_fijo") return "TNA mensual prorrateada por días";
  if (item.source === "daily_prices") return "Simulación con precios diarios de SPY";
  return "Rendimiento mensual ponderado por días activos";
}

function resultCard(currency, result, xirr, allResult) {
  if (!result) {
    return `<div class="result-card"><h3>${currency}</h3><p class="muted">Sin datos suficientes.</p></div>`;
  }
  return `
    <div class="result-card">
      <h3>${currency === "ARS" ? "Pesos - ARS" : "Dólares - USD MEP"}</h3>
      <div class="metric-grid" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-top:18px">
        <div><div class="metric-label">XIRR período</div><div class="metric-value ${toneClass(xirr.period)}">${fmtPct(xirr.period)}</div><p class="muted">Anualizado ${fmtPct(xirr.annual)}</p></div>
        <div><div class="metric-label">Modified Dietz</div><div class="metric-value ${toneClass(result.rendimiento)}">${fmtPct(result.rendimiento)}</div><p class="muted">${result.is_chained ? "Encadenado" : "Un tramo"}</p></div>
        <div><div class="metric-label">Valor inicial</div><div class="metric-value">${fmtMoney(result.bmv, currency)}</div><p class="muted">${fmtDate(result.bmv_date)}</p></div>
        <div><div class="metric-label">Valor final</div><div class="metric-value">${fmtMoney(result.emv, currency)}</div><p class="muted">${fmtDate(result.emv_date)}</p></div>
        <div><div class="metric-label">Aportes</div><div class="metric-value pos">${fmtMoney(result.aportes, currency)}</div></div>
        <div><div class="metric-label">Retiros</div><div class="metric-value neg">${fmtMoney(result.retiros, currency)}</div></div>
      </div>
      ${benchmarkChips(allResult, currency)}
    </div>
  `;
}

// ── DB Explorer ───────────────────────────────────────────────────────────────

const DB_TABLES = {
  exchange_rates: { label: "Tipos de cambio", iconName: "dollar-sign",  query: "SELECT * FROM exchange_rates ORDER BY date DESC LIMIT 500",                       count: "SELECT COUNT(*) AS n FROM exchange_rates" },
  benchmarks:     { label: "Benchmarks",      iconName: "bar-chart-3",  query: "SELECT * FROM benchmarks ORDER BY month DESC LIMIT 200",                          count: "SELECT COUNT(*) AS n FROM benchmarks" },
  market_daily:   { label: "Datos diarios",   iconName: "trending-up",  query: "SELECT * FROM market_daily ORDER BY date DESC, symbol ASC LIMIT 500",             count: "SELECT COUNT(*) AS n FROM market_daily" },
  meta:           { label: "Meta",            iconName: "info",         query: "SELECT * FROM meta",                                                               count: "SELECT COUNT(*) AS n FROM meta" },
};

function fmtDbCell(col, value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    const pctCols = ["plazo_fijo_tna", "inflacion_ar", "inflacion_us", "uva", "dolar_mep", "spy", "tlt", "ief"];
    if (pctCols.includes(col)) return value.toFixed(4) + " %";
    return value.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  return String(value);
}

function isNumericCol(col) {
  return ["ars_per_usd", "compra", "venta", "valor", "plazo_fijo_tna", "inflacion_ar",
          "inflacion_us", "uva", "dolar_mep", "spy", "tlt", "ief"].includes(col);
}

function renderDbExplorer() {
  if (!state.db && !state.dbLoading) {
    state.dbLoading = true;
    loadMarketDb()
      .then((db) => { state.db = db; state.dbLoading = false; render(); })
      .catch((e) => {
        state.dbLoading = false;
        setNotice("error", "No se pudo cargar la base de datos: " + e.message);
        state.screen = "final";
        render();
      });
  }

  if (state.dbLoading || !state.db) {
    renderLayout(`
      <div class="panel">
        <div class="panel-head"><div>
          <h2 class="panel-title">Explorador de datos</h2>
          <p class="panel-subtitle">Leyendo SQLite...</p>
        </div></div>
        <div class="notice">${icon("loader-circle", 18)}<span>Cargando base de datos de mercado.</span></div>
      </div>
    `);
    return;
  }

  const db   = state.db;
  const tkey = state.dbTable in DB_TABLES ? state.dbTable : "exchange_rates";
  const cfg  = DB_TABLES[tkey];

  const rows  = queryMarketRows(db, cfg.query);
  const total = (queryMarketRows(db, cfg.count)[0]?.n ?? 0);
  const cols  = rows.length ? Object.keys(rows[0]) : [];

  renderLayout(`
    <div class="panel wide-panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">Explorador de datos</h2>
          <p class="panel-subtitle">Tablas del SQLite cargado en el browser. Solo lectura.</p>
        </div>
        ${state.result?.db_generated_at ? `<span class="db-freshness">${icon("database", 13)}Datos al ${escapeHtml(fmtDbGeneratedAt(state.result.db_generated_at) || "")}</span>` : ""}
      </div>

      <div class="segment-control db-table-tabs" role="tablist" aria-label="Tabla">
        ${Object.entries(DB_TABLES).map(([key, t]) => `
          <button type="button" class="${tkey === key ? "active" : ""}" data-db-table="${key}" role="tab">
            ${icon(t.iconName, 14)}${escapeHtml(t.label)}
          </button>
        `).join("")}
      </div>

      <p class="db-table-meta muted">
        ${total} fila${total !== 1 ? "s" : ""} en total${rows.length < total ? ` · mostrando las ${rows.length} más recientes` : ""}
      </p>

      ${rows.length ? `
        <div class="table-wrap">
          <table class="table db-explorer-table">
            <thead>
              <tr>${cols.map((c) => `<th class="${isNumericCol(c) ? "num" : ""}">${escapeHtml(c)}</th>`).join("")}</tr>
            </thead>
            <tbody>
              ${rows.map((row) => `
                <tr>${cols.map((c) => `<td class="${isNumericCol(c) ? "num" : ""}">${escapeHtml(fmtDbCell(c, row[c]))}</td>`).join("")}</tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : `<p class="muted">Sin datos en esta tabla.</p>`}

      <div class="actions" style="margin-top:28px">
        <button class="btn btn-secondary" data-action="back-to-results">${icon("arrow-left", 16)}Volver a resultados</button>
      </div>
    </div>
  `, {
    afterRender() {
      document.querySelectorAll("[data-db-table]").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.dbTable = btn.dataset.dbTable;
          render();
        });
      });
      $("[data-action='back-to-results']").addEventListener("click", () => {
        state.screen = "final";
        render();
      });
    }
  });
}

function render() {
  track("screen_view", { screen_name: state.screen });
  if (state.screen === "start") return renderStart();
  if (state.screen === "open-existing") return renderOpenExisting();
  if (state.screen === "new-basic") return renderNewBasic();
  if (state.screen === "source") return renderSource();
  if (state.screen === "import-summary") return renderImportSummary();
  if (state.screen === "import") return renderImport();
  if (state.draft && ["movements", "snapshots", "final"].includes(state.screen)) {
    state.screen = "source";
    setNotice("warn", "Primero importá los movimientos para crear la cartera. Después vas a poder editar movimientos, cargar snapshots y ver resultados.");
    return renderSource();
  }
  if (state.screen === "movements") return renderMovements();
  if (state.screen === "snapshots") return renderSnapshots();
  if (state.screen === "final") return renderFinal();
  if (state.screen === "db-explorer") return renderDbExplorer();
}

function renderBoot() {
  app.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">Cargando importadores</h2>
          <p class="panel-subtitle">Detectando plugins disponibles en la carpeta plugins.</p>
        </div>
      </div>
      <div class="notice">${icon("loader-circle", 18)}<span>Esto tarda unos segundos.</span></div>
    </div>
  `;
  refreshIcons();
}

async function boot() {
  renderBoot();
  await loadBrokerPlugins();
  render();
}

boot();
