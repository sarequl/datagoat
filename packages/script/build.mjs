// Build the served tracker and the npm bundles.
//
//   node build.mjs
//
// Outputs (committed so the Worker can serve them):
//   dist/t.js          IIFE, minified — served at GET /t.js
//   dist/datagoat.js   ESM — npm import
//   dist/datagoat.cjs  CJS — npm require
//   dist/checkout.js   IIFE — standalone checkout helpers
//
// esbuild bundles and minifies; terser then runs a second, more aggressive
// pass on the IIFE builds (the served t.js must stay under 5 KB gzipped).

import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';
import { minify } from 'terser';
import { VERSION } from './src/core.js';

const root = dirname(fileURLToPath(import.meta.url));
const MAX_GZIP = 5120; // 5 KB acceptance budget for the served file

const builds = [
  { entry: 'src/t.js', outfile: 'dist/t.js', format: 'iife', globalName: 'DataGoat', tight: true },
  { entry: 'src/index.js', outfile: 'dist/datagoat.js', format: 'esm' },
  { entry: 'src/index.js', outfile: 'dist/datagoat.cjs', format: 'cjs' },
  { entry: 'src/checkout.js', outfile: 'dist/checkout.js', format: 'iife', globalName: 'DataGoatCheckout', tight: true },
];

const TERSER_COMPRESS = {
  passes: 10,
  unsafe: true,
  unsafe_arrows: true,
  unsafe_methods: true,
  keep_fargs: false,
  reduce_vars: true,
  side_effects: true,
  toplevel: true,
  typeofs: true,
  booleans_as_integers: true,
  evaluate: true,
  join_vars: true,
  collapse_vars: true,
  dead_code: true,
  conditionals: true,
  comparisons: true,
  hoist_funs: true,
  hoist_vars: true,
  if_return: true,
  sequences: true,
  unused: true,
  pure_getters: true,
};

mkdirSync(join(root, 'dist'), { recursive: true });

let overBudget = false;

for (const build of builds) {
  const result = await esbuild.build({
    entryPoints: [join(root, build.entry)],
    outfile: join(root, build.outfile),
    bundle: true,
    minify: true,
    target: 'es2017',
    format: build.format,
    globalName: build.globalName,
    legalComments: 'none',
    logLevel: 'warning',
    write: false,
  });

  let code = result.outputFiles[0].text;

  if (build.tight) {
    const out = await minify(code, {
      compress: TERSER_COMPRESS,
      mangle: { toplevel: true },
      format: { comments: false },
    });
    code = out.code;
  }

  const banner = `/*! DataGoat v${VERSION} | MIT */\n`;
  code = banner + code;
  writeFileSync(join(root, build.outfile), code);

  const raw = Buffer.from(code);
  const gzipped = gzipSync(raw).length;
  console.log(`${build.outfile}: ${raw.length} B raw, ${gzipped} B gzip`);

  if (basename(build.outfile) === 't.js' && gzipped > MAX_GZIP) {
    console.error(`t.js is ${gzipped} B gzipped, over the ${MAX_GZIP} B budget`);
    overBudget = true;
  }
}

if (overBudget) process.exit(1);
