import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL(".", import.meta.url).pathname;
const src = join(root, "src");
const dist = join(root, "dist");
const plugins = join(root, "plugins");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

cpSync(src, dist, { recursive: true });

if (existsSync(plugins)) {
  const distPlugins = join(dist, "plugins");
  cpSync(plugins, distPlugins, { recursive: true });
  const files = readdirSync(plugins)
    .filter((file) => /^[a-z0-9_.-]+\.js$/i.test(file))
    .sort();
  writeFileSync(
    join(distPlugins, "manifest.json"),
    `${JSON.stringify({ plugins: files }, null, 2)}\n`
  );
}

if (existsSync(join(root, "data"))) {
  cpSync(join(root, "data"), join(dist, "data"), { recursive: true });
}

console.log("v4 build completo: dist/");
