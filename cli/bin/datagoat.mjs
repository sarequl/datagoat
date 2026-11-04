#!/usr/bin/env node
// Launcher for the bundled CLI (dist/datagoat.mjs, built by `npm run build:cli`).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bundle = new URL("../dist/datagoat.mjs", import.meta.url);
if (!existsSync(fileURLToPath(bundle))) {
  console.error("datagoat: the CLI is not built. Run `npm run build:cli` in the repository.");
  process.exit(1);
}
const { run } = await import(bundle.href);
await run();
