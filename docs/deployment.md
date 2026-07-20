# Deploy y seguridad de publicacion

El proyecto se publica como sitio estatico en GitHub Pages.

## Archivos relevantes

- `.github/workflows/ci.yml`: ejecuta build y verificacion en `push` a `main` y en pull requests.
- `.github/workflows/pages.yml`: construye `dist/`, sube el artefacto de Pages y despliega.
- `build.mjs`: arma `dist/` copiando `src/`, `plugins/` y `data/`.
- `scripts/verify-public-build.mjs`: valida que el artefacto publico tenga los archivos esperados y no tenga archivos privados.
- `.gitignore`: mantiene fuera `dist/`, dependencias, entornos locales, dumps y `build_sqlite.php`.

## Que se publica

Solo se publica `dist/`.

Contenido esperado:

- `index.html`
- `results.html`
- `styles.css`
- `js/`
- `plugins/`
- `plugins/manifest.json`
- `data/cartera_v4.sqlite`

No se publica:

- `build_sqlite.php`
- `.env`
- dumps SQL
- archivos temporales de SQLite
- `node_modules/`
- `dist/` commiteado

## GitHub Pages

El workflow de Pages se dispara con:

- `push` a `main`.
- Ejecucion manual con `workflow_dispatch`.

El job de build:

1. Hace checkout.
2. Configura Node.js 24.
3. Ejecuta `npm run build`.
4. Ejecuta `npm run verify:public`.
5. Configura Pages.
6. Sube `dist/` como artefacto.

El job de deploy publica el artefacto con `actions/deploy-pages`.

En GitHub, el repositorio debe tener Pages configurado con fuente `GitHub Actions`.

## Verificacion local

Antes de publicar:

```bash
npm run build
npm run verify:public
```

Para probar localmente:

```bash
npm run serve
```

Si el puerto default esta ocupado:

```bash
PORT=3077 npm run serve
```

## Control sobre build_sqlite.php

`build_sqlite.php` no debe exponerse porque es una herramienta local de generacion. Aunque no tenga credenciales hardcodeadas obligatorias, conoce la estructura de la base fuente y no pertenece al sitio publico.

Capas de proteccion:

- `.gitignore` lo ignora explicitamente.
- `build.mjs` solo copia `src/`, `plugins/` y `data/`.
- `scripts/verify-public-build.mjs` falla si encuentra archivos `.php`, `.env`, dumps o SQLite temporales en `dist/`.
- El workflow ejecuta esa verificacion antes de subir el artefacto de Pages.

## Publicar cambios

Flujo esperado:

```bash
git status
npm run build
npm run verify:public
git add .
git commit -m "Describe el cambio"
git push origin main
```

Despues del push, revisar la pestaña Actions del repositorio. Cuando el workflow `Deploy GitHub Pages` termina correctamente, GitHub muestra la URL publica del sitio en el ambiente `github-pages`.

