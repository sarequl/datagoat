import { describe, expect, it } from "vitest";
import { install } from "../src/script";

describe("placeholder tracker", () => {
  it("installs window.datafast and keeps the pre-load queue", () => {
    const w: { datafast?: ((...a: unknown[]) => void) & { q?: unknown[][] } } = {};
    const early = Object.assign(() => {}, { q: [["signup", { plan: "pro" }]] });
    w.datafast = early;
    const fn = install(w);
    fn("identify", { user_id: "u1" });
    expect(fn.q).toEqual([
      ["signup", { plan: "pro" }],
      ["identify", { user_id: "u1" }],
    ]);
    expect(window.datafast).toBeTypeOf("function");
  });
});
