import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, extname, join, normalize, relative } from "node:path";

const appRoot = new URL("./", import.meta.url).pathname;
const root = join(appRoot, "dist");
const pluginRoot = join(appRoot, "plugins");
const port = Number(process.env.PORT || 3003);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".sqlite": "application/octet-stream",
  ".wasm": "application/wasm"
};

function isInsideRoot(file) {
  const path = relative(root, file);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/plugins/manifest.json") {
    const plugins = existsSync(pluginRoot)
      ? readdirSync(pluginRoot).filter((file) => /^[a-z0-9_.-]+\.js$/i.test(file)).sort()
      : [];
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ plugins }));
    return;
  }

  if (url.pathname.startsWith("/plugins/")) {
    const fileName = basename(decodeURIComponent(url.pathname));
    const pluginFile = join(pluginRoot, fileName);
    if (/^[a-z0-9_.-]+\.js$/i.test(fileName) && existsSync(pluginFile)) {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      createReadStream(pluginFile).pipe(res);
      return;
    }
  }

  const safePath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, safePath === "/" ? "index.html" : safePath);

  if (!isInsideRoot(file)) {
    notFound(res);
    return;
  }

  if (!existsSync(file)) {
    if (extname(safePath)) {
      notFound(res);
      return;
    }
    file = join(root, "index.html");
  }

  if (statSync(file).isDirectory()) {
    file = join(file, "index.html");
  }

  if (!isInsideRoot(file) || !existsSync(file)) {
    notFound(res);
    return;
  }

  res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => {
  console.log(`v4 static server: http://127.0.0.1:${port}/`);
});
