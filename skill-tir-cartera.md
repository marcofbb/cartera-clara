# Skill: Análisis de TIR de Cartera de Inversión

## Objetivo
Calcular la Tasa Interna de Retorno (XIRR) de la cartera del usuario, segmentada por tipo de activo (CEDEARs, Fondos, Obligaciones Negociables), y compararla con el rendimiento del SPY en el mismo período.

---

## Instrucciones para Claude

Seguí este flujo paso a paso. No avances al siguiente paso hasta tener la información completa del anterior.

---

### PASO 1 — Movimientos de capital

Pedile al usuario que pegue o adjunte sus movimientos del broker en formato CSV:

```
fecha,tipo,moneda,monto
```

- `tipo`: solo `ingreso` (depósito/aporte) o `retiro` (extracción)
- `moneda`: `ARS` o `USD`
- `monto`: positivo, sin separadores de miles

**Reglas de clasificación:**
- Incluir: depósitos, retiros, traspasos externos
- Excluir: compras, ventas, dividendos, intereses, comisiones, conversiones MEP, cauciones

Una vez recibidos, mostrá un resumen: cantidad de movimientos, rango de fechas, total ingresado y total retirado por moneda.

---

### PASO 2 — Fechas clave para snapshots

A partir de los movimientos, determiná las fechas clave en las que necesitás fotos del portfolio:

1. **Fecha de inicio**: día anterior al primer movimiento (valor inicial = 0 si empezó de cero, o pedilo si ya tenía activos)
2. **Cierres anuales**: 31/12 de cada año con actividad
3. **Fecha actual**: hoy (valor final)

Mostrá la lista de fechas clave al usuario antes de continuar.

---

### PASO 3 — Snapshots por categoría

Para **cada fecha clave**, pedile al usuario el valor de su cartera desglosado así:

| Categoría | Valor en ARS | Valor en USD (si aplica) |
|-----------|-------------|--------------------------|
| CEDEARs | | |
| Fondos Comunes de Inversión | | |
| Obligaciones Negociables | | |
| Otros (efectivo, acciones locales, etc.) | | |
| **TOTAL** | | |

**Nota sobre moneda:**
- CEDEARs: reportar en ARS al valor de mercado (precio × cantidad)
- Fondos: reportar en ARS (valor cuotaparte × cuotapartes)
- ON: reportar en la moneda de emisión (ARS o USD)
- Para la comparación con SPY, convertir todo a USD usando el tipo de cambio MEP de cada fecha

Pedí los datos fecha por fecha para no confundir al usuario.

---

### PASO 4 — Tipo de cambio MEP

Para cada fecha clave, buscá (o pedile al usuario) el tipo de cambio **dólar MEP (CCL)** en ARS. Esto es necesario para convertir la cartera ARS a USD y comparar contra SPY.

Si podés acceder a precios históricos, buscá el MEP de cada fecha. Si no, pedile al usuario que lo informe.

---

### PASO 5 — Precio del SPY

Para cada fecha clave, obtené el precio de cierre del **SPY** (en USD). Podés buscarlo online o pedírselo al usuario. También obtené el precio actual del SPY para calcular el rendimiento del período completo.

---

### PASO 6 — Cálculo de TIR (XIRR)

#### TIR Total de la cartera

Usá el método **XIRR**: encontrá la tasa `r` tal que:

```
Σ [ flujo_i / (1 + r)^(días_i / 365) ] = 0
```

Donde:
- Los ingresos son flujos **negativos** (capital que salió del bolsillo)
- Los retiros son flujos **positivos** (capital que volvió al bolsillo)
- El valor final de la cartera es el último flujo **positivo** (aunque no haya retiro real)

Iterá con Newton-Raphson o bisección hasta convergencia (tolerancia < 0.0001%).

Mostrá el resultado como **TIR anualizada** en porcentaje.

#### TIR por categoría

Para cada categoría, construí flujos aproximados así:

- **Flujos de entrada**: prorrateá cada ingreso según el % que representaba esa categoría del total en esa fecha
- **Flujo final**: el valor actual de esa categoría
- Calculá XIRR con esos flujos

Aclarale al usuario que la TIR por categoría es una **aproximación** basada en el peso relativo de cada categoría, salvo que haya tenido flujos exclusivos por categoría.

---

### PASO 7 — Rendimiento del SPY (benchmark)

Calculá el rendimiento equivalente del SPY para el mismo período usando el método **holding period return ponderado por flujos** (igual que XIRR pero con los mismos momentos de inversión):

- Simulá que cada ingreso del usuario hubiera comprado SPY al precio de ese día
- Calculá cuántas unidades de SPY habría comprado con cada flujo (en USD)
- Calculá el valor actual de esas unidades al precio SPY de hoy
- Calculá la XIRR de esos flujos simulados

Esto da el rendimiento que **habría tenido si hubiera puesto todo en SPY**, en las mismas fechas y montos.

---

### PASO 8 — Tabla comparativa final

Presentá los resultados en esta tabla:

| | TIR Anualizada | vs SPY |
|---|---|---|
| **Cartera Total** | X.X% | +/- X.X pp |
| CEDEARs | X.X% | +/- X.X pp |
| Fondos Comunes | X.X% | +/- X.X pp |
| Obligaciones Negociables | X.X% | +/- X.X pp |
| **SPY (benchmark)** | X.X% | — |

Luego agregá una interpretación breve:
- Si la cartera superó al SPY: en cuántos puntos porcentuales y en qué categoría fue el driver
- Si no superó: cuál fue la categoría de mayor arrastre
- Si hay ON en USD: aclarar que su comparación directa con SPY no es perfecta (diferente perfil de riesgo)

---

## Notas importantes

- **Moneda base**: toda la comparación se hace en **USD** (usando MEP para convertir ARS)
- **CEDEARs vs SPY**: la comparación es directa porque los CEDEARs replican activos del exterior
- **Fondos vs SPY**: los fondos locales ARS compiten principalmente con inflación o tasa local; la comparación con SPY es orientativa
- **ON vs SPY**: las ON tienen un perfil de riesgo muy diferente (renta fija vs renta variable); comparar la TIR es útil como referencia pero no implica que SPY sea una alternativa equivalente
- Si hay períodos sin datos de snapshot, interpolá linealmente el valor de la cartera entre las fechas conocidas
