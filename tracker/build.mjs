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

// Defines are substituted before minification, so `if (__DG_HASH__)` branches of the other
// builds are removed entirely (a `const` alias would survive as a variable).
for (const { file, variant } of VARIANTS) {
  await build({
    entryPoints: [join(root, "tracker", "src", "script.ts")],
    outfile: join(outdir, file),
    bundle: true,
    minify: true,
    format: "iife",
    // ES2020 (optional chaining, ??): every browser DataFast's own script supports.
    target: ["es2020"],
    platform: "browser",
    legalComments: "none",
    define: {
      __DG_COOKIELESS__: String(variant === "cookieless"),
      __DG_HASH__: String(variant === "hash"),
    },
    banner: { js: "/*! DataGoat tracker | MIT */" },
  });
  console.log(`built public/js/${file}`);
}
