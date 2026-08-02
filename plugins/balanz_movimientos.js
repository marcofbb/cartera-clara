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
    "Renta",
    "Renta y Amortización",
    "Amortización",
    "Boleto",
    "Dividendo en efectivo",
    "Intereses corridos",
    "Operación Diferida",
    "Liquidación de Operación Diferida",
    "Rescate Anticipado",
    "Cargo por Descubierto"
  ].map(normalizeText);

  const MANUAL_INTERNAL_KEYWORDS = [
    "Conversión",
    "Conversion",
    "Canje",
    "Renta",
    "Intereses",
    "Comisión",
    "Comision",
    "Cancelacion",
    "Cancelación",
    "Licitación",
    "Licitacion",
    "Ajuste",
    "N/C",
    "Pago de premio"
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
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
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

  function currency(raw) {
    const value = String(raw || "").trim();
    const n = normalizeText(value);

    if (n === "pesos" || n === "ars") {
      return "ARS";
    }
    if (n.startsWith("dolar") || n.startsWith("us dollar") || n === "usd") {
      return "USD";
    }

    return null;
  }

  function readSharedStrings(zip) {
    const entry = zip.file("xl/sharedStrings.xml");

    if (!entry) {
      return Promise.resolve([]);
    }

    return entry.async("text").then((xmlText) => {
      const doc = parseXml(xmlText);
      return getNodes(doc, "si").map((si) => getNodes(si, "t").map((t) => t.textContent || "").join(""));
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

  function formatExample(date, description, amount, curr) {
    const cleanDescription = String(description || "");
    const shortDescription = cleanDescription.length > 60
      ? `${cleanDescription.slice(0, 57)}...`
      : cleanDescription;

    return `${date || "sin fecha"} | ${shortDescription} | ${amount || "0"} ${curr || ""}`.trim();
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

  async function parseBalanzMovements(file) {
    if (!global.JSZip) {
      throw new Error("No se pudo cargar JSZip. Revisá la conexión o serví una copia local de la librería.");
    }

    if (!file) {
      throw new Error("No se recibió ningún archivo.");
    }

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

        if ((col === 4 || col === 7) && /^\d+(\.\d+)?$/.test(value) && Number(value) > 60) {
          value = excelSerialToIso(value);
        }

        cells[col] = value;
      });

      const desc = String(cells[1] || "").trim();
      const fecha = String(cells[4] || "").trim();
      const monedaRaw = String(cells[8] || "").trim();
      const montoRaw = String(cells[9] || "").trim();

      if (!desc && !montoRaw) {
        return;
      }

      let operacion = desc.toLowerCase().startsWith("cargo por descubierto")
        ? "Cargo por Descubierto"
        : desc.split("/", 1)[0].trim();
      const opN = normalizeText(operacion);
      const monto = parseNumber(montoRaw);

      if (!Number.isFinite(monto) || monto === 0) {
        addReportBucket(report.skipped, "(importe cero o inválido)", formatExample(fecha, desc, montoRaw, monedaRaw));
        return;
      }

      const startsManual = desc.toLowerCase().startsWith("movimiento manual");
      const isIngreso = opN === normalizeText("Recibo de Cobro");
      const isRetiro = opN === normalizeText("Comprobante de Pago");
      const isTraspaso = startsManual && desc.toUpperCase().includes("TRASPASO");

      if (!isIngreso && !isRetiro && !isTraspaso) {
        const isManualInternal = startsManual && MANUAL_INTERNAL_KEYWORDS.some((kw) => normalizeText(desc).includes(kw));

        if (isManualInternal || (!startsManual && INTERNAL_OPERATIONS.includes(opN))) {
          addReportBucket(
            report.skipped,
            isManualInternal ? "Movimiento Manual (interno)" : operacion || "(sin operación)",
            formatExample(fecha, desc, montoRaw, monedaRaw)
          );
        } else {
          addReviewBucket(report.review, startsManual ? "Movimiento Manual (otros)" : operacion || "(sin operación)", {
            fecha,
            desc,
            monto,
            moneda: currency(monedaRaw) || monedaRaw
          });
        }

        return;
      }

      if (!isIsoDate(fecha)) {
        errors.push(`Fila ${rowNum}: fecha inválida '${fecha}'.`);
        return;
      }

      const moneda = currency(monedaRaw);
      if (!moneda) {
        errors.push(`Fila ${rowNum}: moneda desconocida '${monedaRaw}'.`);
        return;
      }

      let tipo = "";
      let label = "";

      if (isIngreso) {
        tipo = "ingreso";
        label = "Recibo de Cobro";
      } else if (isRetiro) {
        tipo = "retiro";
        label = "Comprobante de Pago";
      } else {
        tipo = monto < 0 ? "retiro" : "ingreso";
        label = "Movimiento Manual / TRASPASO";
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
        broker: "Balanz",
        fileName: file.name,
        accountId: ""
      }
    };
  }

  registry.register({
    id: "balanz_movimientos",
    name: "Balanz Movimientos",
    label: "Balanz",
    broker: "Balanz",
    description: "Exportación de movimientos Balanz en XLSX.",
    cardDescription: "Importá el XLSX exportado desde Balanz.",
    logoText: "Balanz",
    logoClass: "balanz-logo",
    importTitle: "Descargar movimientos desde Balanz",
    importSteps: [
      "Ingresar a Actividad → Movimientos.",
      "Seleccionar la pestaña Movimientos.",
      "Elegir el período completo de la cartera (desde el primer movimiento hasta la fecha actual).",
      "Hacer clic en Descargar y exportar el archivo en XLSX.",
      "Volver al Analizador de Cartera, elegir Balanz como origen y subir el archivo descargado para importar los movimientos."
    ],
    snapshotGuide: {
      title: "Cómo obtener snapshots en Balanz",
      intro: "Para cada fecha de corte (inicio, cierres anuales y final), obtené el valor total de la cartera desde el reporte de posición consolidada.",
      steps: [
        "Ingresar a Actividad → Movimientos.",
        "Hacer clic en Reportes.",
        "Seleccionar el reporte Posición consolidada.",
        "Elegir la fecha del snapshot que se desea cargar (inicio, cierres anuales y final).",
        "Seleccionar la moneda correspondiente (Pesos o USD).",
        "Descargar el PDF del reporte.",
        "Tomar el Total que figura en la primera página del PDF.",
        "Volver al Analizador de Cartera y completar el snapshot con: fecha del reporte, moneda (ARS o USD MEP), momento (Cierre del día), valor total obtenido del PDF, y etiqueta (Inicio, Cierre 2022, Cierre 2023, Cierre 2024, Cierre 2025 o Final).",
        "Repetir el proceso para todas las fechas necesarias y luego hacer clic en Guardar y continuar para calcular los resultados."
      ],
      note: "Usá siempre el Total de la primera página del PDF y mantené el mismo criterio de moneda para todos los snapshots."
    },
    accept: ".xlsx",
    parse: parseBalanzMovements
  });
})(window);
