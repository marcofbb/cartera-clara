# Plugins de importacion

Los plugins permiten importar movimientos desde formatos especificos de brokers sin tocar el flujo principal de la aplicacion.

## Ubicacion y carga

Los plugins viven en `plugins/` y deben ser archivos `.js`.

Durante `npm run build`, `build.mjs`:

- Copia `plugins/` a `dist/plugins/`.
- Genera `dist/plugins/manifest.json`.
- Incluye en el manifiesto solo archivos cuyo nombre matchee `^[a-z0-9_.-]+\.js$`.

En runtime, la app lee `plugins/manifest.json`, carga cada script y espera que el script se registre en `window.CarteraV4Plugins`.

## Contrato minimo

Un plugin debe registrar un objeto con `id`, datos de UI y una funcion `parse`.

```js
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

  async function parseMiBroker(file, options = {}) {
    return {
      rows: [
        { date: "2026-01-10", tipo: "ingreso", moneda: "ARS", monto: 100000 },
        { date: "2026-02-15", tipo: "retiro", moneda: "USD", monto: 500 }
      ],
      errors: [],
      warnings: [],
      report: {},
      meta: {
        broker: "Mi Broker",
        fileName: file.name,
        accountId: options.account_id || ""
      }
    };
  }

  registry.register({
    id: "mi_broker_movimientos",
    name: "Mi Broker Movimientos",
    label: "Mi Broker",
    broker: "Mi Broker",
    description: "Exportacion de movimientos Mi Broker.",
    cardDescription: "Importa el archivo exportado desde Mi Broker.",
    logoText: "MB",
    accept: ".xlsx",
    importTitle: "Exportar movimientos desde Mi Broker",
    importSteps: [
      "Ingresa a Mi Broker.",
      "Abre la seccion de movimientos.",
      "Selecciona el rango completo.",
      "Exporta el archivo.",
      "Vuelve a Cartera Clara y subilo."
    ],
    parse: parseMiBroker
  });
})(window);
```

## Campos del plugin

Campos principales:

- `id`: identificador unico. Debe ser estable porque se guarda en las carteras.
- `name`: nombre interno o largo.
- `label`: texto corto visible.
- `broker`: nombre del broker usado como metadata.
- `description`: descripcion general.
- `cardDescription`: texto de la tarjeta de importacion.
- `logoText`: texto fallback del logo.
- `logoClass`: clase CSS opcional para estilos especificos.
- `accept`: extensiones o MIME types aceptados por el input de archivo. Por defecto `.xlsx`.
- `importTitle`: titulo de la pantalla de instrucciones.
- `importSteps`: pasos que ve el usuario para exportar el archivo desde el broker.
- `accountField`: campo extra opcional para pedir una cuenta, comitente u otro dato.
- `snapshotGuide`: guia opcional para explicar como obtener snapshots en ese broker.
- `parse(file, options)`: funcion obligatoria que devuelve los movimientos parseados.

## Resultado de parse

`parse` puede ser asincrona y debe devolver:

```js
{
  rows: [
    {
      date: "2026-01-10",
      tipo: "ingreso",
      moneda: "ARS",
      monto: 100000
    }
  ],
  errors: [],
  warnings: [],
  report: {},
  meta: {
    broker: "Mi Broker",
    fileName: "movimientos.xlsx",
    accountId: ""
  }
}
```

Cada fila de `rows` acepta estos nombres:

- Fecha: `date` o `fecha`, en formato `YYYY-MM-DD`.
- Tipo: `tipo` o `type`, con valor `ingreso` o `retiro`.
- Moneda: `moneda` o `currency`, con valor `ARS` o `USD`.
- Monto: `monto` o `amount`, numero positivo.

La aplicacion normaliza y filtra las filas con `cleanMovements`. Cualquier campo extra queda fuera de la cartera guardada, pero puede usarse en `report` para diagnostico.

`errors` no aborta automaticamente la importacion si hay filas validas; se muestra como advertencia. Para abortar por completo, `parse` debe lanzar un `Error`.

## Reglas de clasificacion

El plugin debe importar solo flujos externos:

- Depositos.
- Aportes.
- Retiros.
- Extracciones.
- Transferencias externas que cambien el capital de la cartera.

Debe omitir operaciones internas:

- Compras y ventas.
- Rentas, dividendos, amortizaciones e intereses.
- Comisiones.
- Conversiones MEP.
- Cauciones.
- Canjes.
- Ajustes.

Si una fila es dudosa, conviene no importarla y reportarla en `warnings` o `report.review`.

## accountField

Si el broker necesita un dato adicional, el plugin puede declarar un campo:

```js
accountField: {
  id: "accountId",
  optionKey: "account_id",
  label: "ID de cuenta",
  placeholder: "Opcional",
  hint: "Se intenta detectar desde el nombre del archivo.",
  fileNamePattern: "broker-(\\d+)",
  fileNameGroup: 1
}
```

La app renderiza el input y llama:

```js
plugin.parse(file, { account_id: "..." });
```

`fileNamePattern` y `fileNameGroup` sirven para autocompletar el campo desde el nombre del archivo.

## snapshotGuide

Cada plugin puede personalizar la ayuda para cargar snapshots:

```js
snapshotGuide: {
  title: "Como obtener snapshots en Mi Broker",
  intro: "Usa el valor total de la cartera.",
  steps: [
    "Abre la cuenta que estas midiendo.",
    "Busca el valor total consolidado.",
    "Copia valor y moneda.",
    "Define si corresponde a inicio o cierre del dia."
  ],
  note: "No mezcles valores parciales con valores consolidados."
}
```

## Dependencias disponibles

Los plugins corren en el navegador. Actualmente la pagina carga:

- `JSZip`, disponible como `window.JSZip`.
- `lucide`, usado por la UI principal.
- `sql.js`, usado por los calculos.

Los plugins existentes leen XLSX como ZIP, parsean `xl/worksheets/sheet1.xml` y `xl/sharedStrings.xml` con `DOMParser`.

## Checklist para agregar un plugin

1. Crear `plugins/nombre_broker_movimientos.js`.
2. Registrar el plugin con un `id` unico y estable.
3. Implementar `parse(file, options)`.
4. Asegurar que las filas devueltas sean movimientos externos validos.
5. Agregar `importSteps` y, si corresponde, `snapshotGuide`.
6. Ejecutar `npm run build`.
7. Ejecutar `npm run verify:public`.
8. Probar una importacion real en el navegador.

