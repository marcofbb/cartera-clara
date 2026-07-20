import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
const requiredFiles = [
  "index.html",
  "styles.css",
  "js/app.js",
  "plugins/manifest.json",
  "data/cartera_v4.sqlite"
];
const forbiddenPatterns = [
  /^build_sqlite\.php$/i,
  /\.php$/i,
  /^\.env(?:\.|$)/i,
  /\.(?:sql|dump)(?:\.gz)?$/i,
  /\.(?:sqlite|db)(?:-journal|-wal|-shm)$/i
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    if (entry.isFile()) return [fullPath];
    return [];
  });
}

if (!existsSync(dist)) {
  fail("No existe dist/. Ejecuta npm run build antes de verificar.");
}

for (const file of requiredFiles) {
  const fullPath = join(dist, file);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    fail(`Falta el archivo publico requerido: dist/${file}`);
  }
}

const forbidden = walk(dist)
  .map((file) => relative(dist, file).replaceAll("\\", "/"))
  .filter((file) => forbiddenPatterns.some((pattern) => pattern.test(file.split("/").pop() || "")));

if (forbidden.length > 0) {
  fail(`El build contiene archivos que no deben publicarse: ${forbidden.join(", ")}`);
}

console.log("Artefacto publico verificado.");
