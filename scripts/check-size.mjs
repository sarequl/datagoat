#!/usr/bin/env node
// Size budgets: each tracker build (gzip) and the dashboard's initial JavaScript (gzip: the entry
// chunk plus its static imports, i.e. what index.html loads before any lazy route).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const budget = JSON.parse(readFileSync(join(root, "tracker", "size-budget.json"), "utf8"));
const gz = (path) => gzipSync(readFileSync(path), { level: 9 }).length;
let failed = false;

for (const [file, limit] of Object.entries(budget.tracker)) {
  const path = join(root, "public", "js", file);
  if (!existsSync(path)) {
    console.error(`missing ${path}; run npm run build first`);
    failed = true;
    continue;
  }
  const size = gz(path);
  const ok = size <= limit;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} tracker ${file}: ${size} B gzip (budget ${limit})`);
}

const manifestPath = join(root, "public", ".vite", "manifest.json");
if (!existsSync(manifestPath)) {
  console.error("missing public/.vite/manifest.json; run npm run build first");
  failed = true;
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = Object.values(manifest).find((c) => c.isEntry);
  const seen = new Set();
  const walk = (key) => {
    const chunk = manifest[key];
    if (!chunk || seen.has(chunk.file)) return;
    seen.add(chunk.file);
    for (const imp of chunk.imports ?? []) walk(imp);
  };
  const entryKey = Object.keys(manifest).find((k) => manifest[k] === entry);
  if (entryKey) walk(entryKey);
  const files = [...seen].filter((f) => f.endsWith(".js"));
  const total = files.reduce((sum, f) => sum + gz(join(root, "public", f)), 0);
  const limit = budget.dashboardInitialJsGzip;
  const ok = total <= limit;
  failed ||= !ok;
  console.log(
    `${ok ? "ok  " : "FAIL"} dashboard initial JS: ${total} B gzip in ${files.length} file(s) (budget ${limit})`,
  );
}

process.exitCode = failed ? 1 : 0;
