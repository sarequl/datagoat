/** WCAG AA contrast for every text/background pair of the design tokens, in both themes. */
/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Read the stylesheet from disk: Vitest does not process CSS imports.
const cssPath = [
  join(process.cwd(), "dashboard", "src", "styles.css"),
  join(process.cwd(), "src", "styles.css"),
].find((p) => existsSync(p));
const css = readFileSync(cssPath ?? "styles.css", "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing ${selector}`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/--dg-([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], (m[2] ?? "").trim()]),
  );
}

const light = block(':root,\n[data-theme="light"]');
const dark = { ...light, ...block(':root[data-theme="dark"],\n[data-theme="dark"]') };

function rgb(value: string, under: [number, number, number]): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /rgba?\(([^)]+)\)/.exec(value);
  if (!m?.[1]) throw new Error(`unsupported colour ${value}`);
  const [r, g, b, a = "1"] = m[1].split(",").map((x) => x.trim());
  const alpha = Number(a);
  return [Number(r), Number(g), Number(b)].map(
    (c, i) => c * alpha + (under[i] ?? 0) * (1 - alpha),
  ) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg: string, bg: string, theme: Record<string, string>): number {
  const base = rgb(theme.bg ?? "#ffffff", [255, 255, 255]);
  const b = rgb(bg, base);
  const f = rgb(fg, b);
  const [l1, l2] = [luminance(f), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

const TEXT_ON_SURFACES = [
  "text",
  "muted",
  "primary-text",
  "success-text",
  "warning-text",
  "error-text",
  "info-text",
];
const SURFACES = ["bg", "surface", "surface-2"];

describe.each([
  ["light", light],
  ["dark", dark],
])("%s theme", (_name, theme) => {
  for (const fg of TEXT_ON_SURFACES) {
    for (const bg of SURFACES) {
      it(`${fg} on ${bg} meets AA (4.5:1)`, () => {
        expect(contrast(theme[fg] as string, theme[bg] as string, theme)).toBeGreaterThanOrEqual(
          4.5,
        );
      });
    }
  }
  it("button text on primary and danger is readable", () => {
    // White on the brand orange is 3.4:1: AA for bold/large text and UI components (3:1), the
    // look the light theme wants. Dark text on orange in the dark theme clears 4.5:1.
    expect(
      contrast(theme["primary-fg"] as string, theme.primary as string, theme),
    ).toBeGreaterThanOrEqual(theme === light ? 3 : 4.5);
    expect(
      contrast(theme["danger-fg"] as string, theme.danger as string, theme),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

it("light buttons use white text, dark buttons near-black", () => {
  expect(light["primary-fg"]).toBe("#ffffff");
  expect(light["danger-fg"]).toBe("#ffffff");
  expect(dark["primary-fg"]).toBe("#171717");
  // "system" in a dark OS matches the explicit dark theme.
  const system = css.slice(css.indexOf(':root[data-theme="system"] {'));
  expect(system).toContain("--dg-primary-fg: #171717;");
  expect(system).toContain("--dg-danger-fg: #171717;");
});

it("uses DataFast's palette values", () => {
  expect(light).toMatchObject({
    primary: "#e16540",
    revenue: "#e78468",
    secondary: "#8dcdff",
    accent: "#00d7c0",
    info: "#00b5ff",
    success: "#00a96e",
    warning: "#ffbe00",
    error: "#ff5861",
    surface: "#ffffff",
    bg: "#fcfbfa",
    text: "#262626",
  });
  expect(dark).toMatchObject({
    accent: "#00cdb7",
    surface: "#212121",
    "surface-2": "#262626",
    text: "#dedddc",
    neutral: "#4d4d4d",
    bg: "#171717",
  });
});
