/** script.hash.js: hash routes are pages; replaceState and hashchange count as navigation. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./harness";

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("hash build", () => {
  it("is the hash variant and marks bodies with trackHash", () => {
    expect(__DG_HASH__).toBe(true);
    const t = setup({ url: "https://www.example.com/#/home" });
    expect(t.last()).toMatchObject({ href: "https://www.example.com/#/home", trackHash: true });
    expect(t.cookie("datagoat_visitor_id")).toBeDefined();
  });

  it("tracks hash changes", () => {
    const t = setup({ url: "https://www.example.com/#home" });
    t.win.location.hash = "#about";
    t.win.dispatchEvent(new t.win.HashChangeEvent("hashchange"));
    vi.advanceTimersByTime(100);
    expect(t.bodies().map((b) => b.href)).toEqual([
      "https://www.example.com/#home",
      "https://www.example.com/#about",
    ]);
  });

  it("tracks pushState and replaceState that change the pathname or hash", () => {
    const t = setup({ url: "https://www.example.com/" });
    t.win.history.pushState({}, "", "/#/a");
    vi.advanceTimersByTime(100);
    t.win.history.replaceState({}, "", "/#/b");
    vi.advanceTimersByTime(100);
    t.win.history.replaceState({}, "", "/#/b?same=1");
    vi.advanceTimersByTime(100);
    expect(t.bodies().map((b) => b.href)).toEqual([
      "https://www.example.com/",
      "https://www.example.com/#/a",
      "https://www.example.com/#/b",
      "https://www.example.com/#/b?same=1",
    ]);
  });

  it("does not count query-only changes", () => {
    const t = setup({ url: "https://www.example.com/#/a" });
    t.win.history.replaceState({}, "", "/?q=1#/a");
    vi.advanceTimersByTime(100);
    expect(t.sent).toHaveLength(1);
  });
});
