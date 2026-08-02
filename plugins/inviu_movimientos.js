(function (global) {
  "use strict";

  const registry = global.CarteraV4Plugins = global.CarteraV4Plugins || {
    items: {},
    register(plugin) {
      this.items[plugin.id] = plugin;
    },
    get(id) {
      return this.items[id] || null;
    }
  };

  const INTERNAL_OPERATIONS = [
    "Compra",
    "Venta",
    "Vencimiento",
    "Renta",
    "Amortización",
    "Suscripción",
    "Rescate",
    "Remuneración",
    "Dividendo",
    "Ingreso dividendo",
    "Caución colocadora",
    "Caución tomadora",
    "Caución",
    "Boleto",
    "Cierre colocadora",
    "Cierre tomadora"
  ].map(normalizeText);

  function normalizeText(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ñ/g, "n");
  }

  function getNodes(parent, name) {
    return Array.from(parent.getElementsByTagNameNS("*", name));
  }

  function firstNode(parent, name) {
    return getNodes(parent, name)[0] || null;
  }

  function parseXml(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    const err = firstNode(doc, "parsererror");

    if (err) {
      throw new Error("No se pudo leer el XML interno del XLSX.");
    }

    return doc;
  }

  function columnIndex(cellRef) {
    const letters = String(cellRef || "").toUpperCase().match(/^[A-Z]+/);
    let idx = 0;

    for (const ch of letters ? letters[0] : "") {
      idx = idx * 26 + ch.charCodeAt(0) - 64;
    }

    return idx;
  }

  function excelSerialToIso(value) {
    const n = Number(value);

    if (!Number.isFinite(n) || n <= 60) {
      return String(value || "").trim();
    }

    const ms = Math.round((n - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }

  function parseNumber(raw) {
    let s = String(raw || "").trim();

    if (s === "") {
      return NaN;
    }

    s = s.replace(/\s/g, "");
    const hasComma = s.includes(",");
    const hasDot = s.includes(".");

    if (hasComma && hasDot) {
      const lastComma = s.lastIndexOf(",");
      const lastDot = s.lastIndexOf(".");

      if (lastComma > lastDot) {
        s = s.replace(/\./g, "").replace(",", ".");
      } else {
        s = s.replace(/,/g, "");
      }
    } else if (hasComma) {
      s = s.replace(",", ".");
    }

    return Number(s);
  }

  function isIsoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }

    const date = new Date(`${value}T00:00:00Z`);
    return date.toISOString().slice(0, 10) === value;
  }

  function readSharedStrings(zip) {
    const entry = zip.file("xl/sharedStrings.xml");

    if (!entry) {
      return Promise.resolve([]);
    }

    return entry.async("text").then((xmlText) => {
      const doc = parseXml(xmlText);

      return getNodes(doc, "si").map((si) => {
        return getNodes(si, "t").map((t) => t.textContent || "").join("");
      });
    });
  }

  function cellValue(cell, sharedStrings) {
    const type = cell.getAttribute("t") || "";
    const raw = firstNode(cell, "v");

    if (type === "inlineStr") {
      const inline = firstNode(cell, "is");
      return inline ? getNodes(inline, "t").map((t) => t.textContent || "").join("") : "";
    }

    const value = raw ? raw.textContent || "" : "";

    if (type === "s") {
      const idx = Number(value);
      return Number.isInteger(idx) && sharedStrings[idx] !== undefined ? sharedStrings[idx] : value;
    }

    return value;
  }

  function addReportBucket(bucket, key, example) {
    if (!bucket[key]) {
      bucket[key] = {
        count: 0,
        example
      };
    }

    bucket[key].count += 1;
  }

  function addReviewBucket(bucket, key, row) {
    if (!bucket[key]) {
      bucket[key] = {
        count: 0,
        rows: []
      };
    }

    bucket[key].count += 1;

    if (bucket[key].rows.length < 20) {
      bucket[key].rows.push(row);
    }
  }

  function formatExample(date, description, amount, currency) {
    const cleanDescription = String(description || "");
    const shortDescription = cleanDescription.length > 60
      ? `${cleanDescription.slice(0, 57)}...`
      : cleanDescription;

    return `${date || "sin fecha"} | ${shortDescription} | ${amount || "0"} ${currency || ""}`.trim();
  }

  function buildWarnings(report) {
    const warnings = [];

    for (const tipo of ["ingreso", "retiro"]) {
      const entries = Object.entries(report.matched[tipo] || {});

      if (entries.length === 0) {
        continue;
      }

      const label = tipo === "ingreso" ? "INGRESO" : "RETIRO";
      const parts = entries.map(([name, data]) => `${name} (${data.count}) - ej: ${data.example}`);
      warnings.push(`IMPORTADO como ${label}: ${parts.join(" | ")}`);
    }

    const reviewEntries = Object.entries(report.review || {});
    if (reviewEntries.length > 0) {
      const count = reviewEntries.reduce((acc, [, data]) => acc + data.count, 0);
      warnings.push(`PARA REVISAR (${count} filas no importadas, podrían ser depósitos o retiros).`);
    }

    const skippedEntries = Object.entries(report.skipped || {});
    if (skippedEntries.length > 0) {
      const count = skippedEntries.reduce((acc, [, data]) => acc + data.count, 0);
      warnings.push(`OMITIDOS (${count} filas, son flujos internos del portfolio).`);
    }

    return warnings;
  }

  function accountIdFromFile(fileName) {
    const match = String(fileName || "").match(/inviu-movimientos-(\d+)/i);
    return match ? match[1] : "";
  }

  async function parseInviuMovements(file, params) {
    if (!global.JSZip) {
      throw new Error("No se pudo cargar JSZip. Revisá la conexión o serví una copia local de la librería.");
    }

    if (!file) {
      throw new Error("No se recibió ningún archivo.");
    }

    const accountId = String((params && params.account_id) || accountIdFromFile(file.name) || "").trim();
    const zip = await global.JSZip.loadAsync(await file.arrayBuffer());
    const sheetEntry = zip.file("xl/worksheets/sheet1.xml");

    if (!sheetEntry) {
      throw new Error("No se encontró xl/worksheets/sheet1.xml dentro del XLSX.");
    }

    const sharedStrings = await readSharedStrings(zip);
    const sheetDoc = parseXml(await sheetEntry.async("text"));
    const rows = [];
    const errors = [];
    const report = {
      matched: {
        ingreso: {},
        retiro: {}
      },
      review: {},
      skipped: {}
    };

    getNodes(sheetDoc, "row").forEach((rowNode, index) => {
      const rowNum = index + 1;

      if (rowNum === 1) {
        return;
      }

      const cells = {};
      getNodes(rowNode, "c").forEach((cell) => {
        const col = columnIndex(cell.getAttribute("r"));
        let value = cellValue(cell, sharedStrings);

        if ((col === 2 || col === 3) && /^\d+(\.\d+)?$/.test(value) && Number(value) > 60) {
          value = excelSerialToIso(value);
        }

        cells[col] = value;
      });

      const operacion = String(cells[1] || "").trim();
      const fecha = String(cells[2] || "").trim();
      const desc = String(cells[4] || "").trim();
      const montoRaw = String(cells[5] || "").trim();
      const moneda = String(cells[8] || "").trim().toUpperCase();

      if (!operacion && !fecha && !desc && !montoRaw) {
        return;
      }

      const opN = normalizeText(operacion);
      const startsManual = desc.toLowerCase().startsWith("movimiento manual");
      const hasTraspaso = desc.toUpperCase().includes("TRASPASO");
      const isDeposito = opN === "deposito";
      const isRetiro = opN === "retiro";
      const isTraspaso = hasTraspaso && (opN === "otros" || startsManual);

      if (!isDeposito && !isRetiro && !isTraspaso) {
        const isManualRendimiento = startsManual && desc.toLowerCase().includes("rendimiento");
        const skipKey = isManualRendimiento ? "Movimiento Manual (rendimiento)" : operacion || "(sin operación)";

        if (isManualRendimiento || (!startsManual && INTERNAL_OPERATIONS.includes(opN))) {
          addReportBucket(report.skipped, skipKey, formatExample(fecha, desc, montoRaw, moneda));
        } else {
          const reviewKey = startsManual ? "Movimiento Manual (otros)" : operacion || "(sin operación)";
          addReviewBucket(report.review, reviewKey, {
            fecha,
            desc,
            monto: parseNumber(montoRaw),
            moneda
          });
        }

        return;
      }

      if (!isIsoDate(fecha)) {
        errors.push(`Fila ${rowNum}: fecha inválida '${fecha}'.`);
        return;
      }

      if (!["ARS", "USD"].includes(moneda)) {
        errors.push(`Fila ${rowNum}: moneda desconocida '${moneda}'.`);
        return;
      }

      const monto = parseNumber(montoRaw);

      if (!Number.isFinite(monto) || monto === 0) {
        addReportBucket(report.skipped, "(monto cero o inválido)", formatExample(fecha, desc, montoRaw, moneda));
        return;
      }

      let tipo = null;
      let label = "";

      if (isDeposito) {
        tipo = "ingreso";
        label = "Depósito";
      } else if (isRetiro) {
        tipo = "retiro";
        label = "Retiro";
      } else {
        if (accountId && /TRASPASO\s+DE\s+(\d+)\s+A\s+(\d+)/i.test(desc)) {
          const match = desc.match(/TRASPASO\s+DE\s+(\d+)\s+A\s+(\d+)/i);

          if (match[1] === accountId) {
            tipo = "retiro";
          } else if (match[2] === accountId) {
            tipo = "ingreso";
          }
        }

        if (!tipo) {
          tipo = monto < 0 ? "retiro" : "ingreso";
        }

        label = startsManual ? "Movimiento Manual / TRASPASO" : "Otros/TRASPASO";
      }

      addReportBucket(report.matched[tipo], label, formatExample(fecha, desc, Math.abs(monto), moneda));

      rows.push({
        date: fecha,
        tipo,
        moneda,
        monto: Math.abs(monto),
        descripcion: desc,
        operacion
      });
    });

    rows.sort((a, b) => {
      if (a.date !== b.date) {
        return a.date.localeCompare(b.date);
      }

      return a.tipo.localeCompare(b.tipo);
    });

    return {
      rows,
      errors,
      warnings: buildWarnings(report),
      report,
      meta: {
        broker: "INVIU",
        fileName: file.name,
        accountId
      }
    };
  }

  registry.register({
    id: "inviu_movimientos",
    name: "INVIU Movimientos",
    label: "INVIU",
    broker: "INVIU",
    description: "Exportación de movimientos INVIU en XLSX.",
    cardDescription: "Importá el XLSX exportado desde INVIU.",
    logoText: "INVIU",
    logoClass: "inviu-logo",
    importTitle: "Exportar movimientos desde INVIU",
    importSteps: [
      "Ingresá a tu cuenta de INVIU.",
      "Abrí la sección de movimientos.",
      "Seleccioná el rango completo de fechas.",
      "Exportá en formato XLSX.",
      "Volvé a esta pantalla y subí el archivo."
    ],
    accountField: {
      id: "accountId",
      optionKey: "account_id",
      label: "ID de cuenta INVIU",
      placeholder: "Opcional, ej: 161413",
      hint: "Intentamos completarlo automáticamente desde el nombre del archivo. Ejemplo: inviu-movimientos-161413_... usa 161413. Si no se detecta, completalo manualmente.",
      fileNamePattern: "inviu-movimientos-(\\d+)",
      fileNameGroup: 1
    },
    snapshotGuide: {
      title: "Cómo obtener snapshots en INVIU",
      intro: "Para cada fecha de corte (inicio, cierres anuales y final), obtené el valor total de la cartera desde INVIU.",
      steps: [
        "En INVIU, ir a Portfolio → Reportes → Portfolio histórico.",
        "Seleccionar la fecha del snapshot que se desea cargar.",
        "Descargar el PDF (o Excel) del portfolio histórico.",
        "Tomar el valor total de la cartera que figura al final del reporte.",
        "Volver al Analizador de Cartera y completar un snapshot con: fecha del corte, moneda (ARS o USD MEP, según corresponda), momento (generalmente Cierre del día), valor total obtenido del reporte, y etiqueta (por ejemplo: Inicio, Cierre 2023, Cierre 2024, Cierre 2025, Final).",
        "Repetir el proceso para cada fecha requerida."
      ],
      note: "Usá siempre el valor total de la cartera que figura al final del reporte y mantené el mismo criterio de moneda para todos los snapshots."
    },
    accept: ".xlsx",
    parse: parseInviuMovements
  });
})(window);
