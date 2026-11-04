#!/usr/bin/env node
// Builds the three tracker variants from tracker/src/script.ts into public/js/ with esbuild,
// like DataFast's script.js / script.cookieless.js / script.hash.js.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, "public", "js");
mkdirSync(outdir, { recursive: true });

export const VARIANTS = [
  { file: "script.js", variant: "default" },
  { file: "script.cookieless.js", variant: "cookieless" },
  { file: "script.hash.js", variant: "hash" },
];

for (const { file, variant } of VARIANTS) {
  await build({
    entryPoints: [join(root, "tracker", "src", "script.ts")],
    outfile: join(outdir, file),
    bundle: true,
    minify: true,
    format: "iife",
    target: ["es2017"],
    platform: "browser",
    legalComments: "none",
    define: { __DG_VARIANT__: JSON.stringify(variant) },
    banner: { js: "/*! DataGoat tracker | MIT */" },
  });
  console.log(`built public/js/${file}`);
}
