#!/usr/bin/env node
// Lints every PHP file of the WordPress plugin (`php -l`) and runs its behaviour tests with the
// PHP CLI. Without PHP on PATH it says so and exits 0, so `npm run check` still works on machines
// without PHP (CI installs it).
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const probe = spawnSync("php", ["-v"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  console.log("WordPress plugin: php not found on PATH, PHP lint and tests skipped.");
  process.exit(0);
}

function phpFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return phpFiles(path);
    return name.endsWith(".php") ? [path] : [];
  });
}

let failed = false;
const files = phpFiles(root);
for (const file of files) {
  const res = spawnSync("php", ["-l", file], { encoding: "utf8" });
  if (res.status !== 0) {
    failed = true;
    process.stderr.write(res.stdout + res.stderr);
  }
}
console.log(`WordPress plugin: php -l on ${files.length} files ${failed ? "FAILED" : "ok"}`);

const tests = spawnSync("php", [join(here, "run-tests.php")], { encoding: "utf8" });
process.stdout.write(tests.stdout);
process.stderr.write(tests.stderr);
if (tests.status !== 0) failed = true;

if (failed) {
  console.error(`WordPress plugin checks failed (${relative(process.cwd(), root)})`);
  process.exit(1);
}
