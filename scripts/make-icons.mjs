#!/usr/bin/env node
// Regenerates every icon from static/brand/logo-mark.svg (the single source of the app icon; the
// plain mark without the tile is static/brand/logo.svg):
// static/favicon.svg, static/favicon.ico (16/32/48), static/apple-touch-icon.png (180, square),
// static/brand/icon-192.png, icon-512.png and icon-maskable-512.png (square).
// Needs a Chromium for Playwright: `npx playwright install chromium` if it is missing.
//   node scripts/make-icons.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "static/brand/logo-mark.svg"), "utf8");
// Full-bleed version for platforms that apply their own mask (iOS, Android adaptive icons): square
// background, artwork scaled to 80% so the horn tip stays inside the masks' safe zone.
const tile = /<rect width="64" height="64" rx="[\d.]+" fill="([^"]+)"\/>/;
const fill = source.match(tile)?.[1] ?? "#e16540";
const art = source
  .replace(tile, "")
  .replace(/^[\s\S]*?<svg[^>]*>/, "")
  .replace(/<\/svg>\s*$/, "");
const square = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${fill}"/><g transform="translate(6.4 6.4) scale(0.8)">${art}</g></svg>`;

async function png(page, svg, size) {
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:transparent"><img src="${uri}" width="${size}" height="${size}" style="display:block"></body>`,
  );
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

/** An ICO file whose entries are PNG images (supported by every current browser). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size, 0);
    e.writeUInt8(size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
writeFileSync(join(root, "static/favicon.svg"), source);
const small = [];
for (const size of [16, 32, 48]) small.push({ size, data: await png(page, source, size) });
writeFileSync(join(root, "static/favicon.ico"), ico(small));
writeFileSync(join(root, "static/apple-touch-icon.png"), await png(page, square, 180));
writeFileSync(join(root, "static/brand/icon-192.png"), await png(page, source, 192));
writeFileSync(join(root, "static/brand/icon-512.png"), await png(page, source, 512));
writeFileSync(join(root, "static/brand/icon-maskable-512.png"), await png(page, square, 512));
await browser.close();
console.log("icons written to static/");
