import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LogoMark } from "../components/Logo";

const root = join(__dirname, "../../..");
const file = (p: string) => readFileSync(join(root, p), "utf8");
const pathsOf = (svg: string) => [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
const barsOf = (svg: string) =>
  [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)].map((m) =>
    m.slice(1).map(Number),
  );

describe("logo", () => {
  it("draws the same mark as the static brand files", () => {
    const { container, rerender } = render(<LogoMark />);
    const tile = container.innerHTML;
    rerender(<LogoMark variant="plain" />);
    const plain = container.innerHTML;
    for (const [html, svg] of [
      [tile, file("static/brand/logo-mark.svg")],
      [plain, file("static/brand/logo.svg")],
      [tile, file("static/favicon.svg")],
    ] as const) {
      expect(pathsOf(html)).toEqual(pathsOf(svg));
      expect(barsOf(html)).toEqual(barsOf(svg));
    }
    expect(tile).toContain('fill="#e16540"');
    expect(plain).not.toMatch(/<rect width="64"/);
  });

  it("is an uneven chart, not a signal icon: a short bar, a tall bar, then the horn peak", () => {
    const [short, tall] = barsOf(file("static/brand/logo-mark.svg"));
    expect(short?.[3]).toBeLessThan(tall?.[3] ?? 0);
    // The horn bar's tip (y 15) is the highest point; the tall middle bar (y 17) sits just below it.
    expect(tall?.[1]).toBe(17);
    expect(pathsOf(file("static/brand/logo-mark.svg"))[0]).toMatch(/58 15/);
  });
});
