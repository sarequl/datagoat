#!/usr/bin/env node
// Prepares public/ for a build: removes previous build output (keeping public/README.md) and
// copies static/* (e.g. _headers, robots.txt) into public/. Run by `npm run build`.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(root, "public");
const keep = new Set(["README.md"]);

mkdirSync(pub, { recursive: true });
for (const entry of readdirSync(pub)) {
  if (!keep.has(entry)) rmSync(join(pub, entry), { recursive: true, force: true });
}
const staticDir = join(root, "static");
if (existsSync(staticDir)) cpSync(staticDir, pub, { recursive: true });
console.log("public/ cleaned; static/ copied");
