#!/usr/bin/env node
// Bundles the CLI (TypeScript, no runtime dependencies) into dist/datagoat.mjs for Node 20+.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

await build({
  entryPoints: [join(here, "src", "entry.ts")],
  outfile: join(here, "dist", "datagoat.mjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  define: { __CLI_VERSION__: JSON.stringify(version) },
  legalComments: "none",
  logLevel: "warning",
});
console.log(`built cli/dist/datagoat.mjs (datagoat ${version})`);
