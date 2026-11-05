import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetForTests,
  buildCrossDomainUrl,
  consent,
  getClient,
  getSessionId,
  getTrackingParams,
  getVisitorId,
  identify,
  init,
  normalizeParams,
  optIn,
  optOut,
  payment,
  scriptAttributes,
  type TrackerFunction,
  track,
} from "../src/index";

function setCookie(value: string) {
  // biome-ignore lint/suspicious/noDocumentCookie: tests set the tracker's cookies directly
  document.cookie = value;
}

const VID = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const SID = "s0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";

type W = Window & { datafast?: TrackerFunction };
const w = () => window as W;

function clearCookies() {
  for (const c of document.cookie.split(";")) {
    const name = c.split("=")[0]?.trim();
    if (name) setCookie(`${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`);
  }
}

beforeEach(() => {
  _resetForTests();
  delete w().datafast;
  document.head.innerHTML = "";
  clearCookies();
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("init", () => {
  it("adds one tracker script with the documented attributes and a pre-load queue", () => {
    const client = init({
      websiteId: "dfid_abc",
      domain: "example.com",
      host: "https://a.example.com/",
      allowedHostnames: ["app.example.io", "shop.example.net"],
      allowLocalhost: true,
      debug: true,
      disablePayments: true,
    });
    const scripts = document.querySelectorAll("script");
    expect(scripts).toHaveLength(1);
    const s = scripts[0] as HTMLScriptElement;
    expect(s.defer).toBe(true);
    expect(s.getAttribute("src")).toBe("https://a.example.com/js/script.js");
    expect(s.getAttribute("data-website-id")).toBe("dfid_abc");
    expect(s.getAttribute("data-domain")).toBe("example.com");
    expect(s.getAttribute("data-api-url")).toBe("https://a.example.com/api/events");
    expect(s.getAttribute("data-allowed-hostnames")).toBe("app.example.io,shop.example.net");
    expect(s.getAttribute("data-allow-localhost")).toBe("true");
    expect(s.getAttribute("data-debug")).toBe("true");
    expect(s.getAttribute("data-disable-payments")).toBe("true");
    expect(typeof w().datafast).toBe("function");
    expect(w().datafast?.q).toEqual([]);
    expect(getClient()).toBe(client);
    // Second init is a no-op.
    init({ websiteId: "dfid_other" });
    expect(document.querySelectorAll("script")).toHaveLength(1);
  });

  it("uses same-origin paths without host, picks the variant file, and resolves ready on load", async () => {
    const client = init({ websiteId: "dfid_abc", variant: "cookieless", nonce: "n1" });
    const s = document.querySelector("script") as HTMLScriptElement;
    expect(s.getAttribute("src")).toBe("/js/script.cookieless.js");
    expect(s.hasAttribute("data-api-url")).toBe(false);
    expect(s.nonce).toBe("n1");
    await expect(client.ready).resolves.toBeUndefined();
  });

  it("does not add a second tracker when the page already has a script tag", () => {
    const existing = document.createElement("script");
    existing.setAttribute("data-website-id", "dfid_abc");
    document.head.appendChild(existing);
    init({ websiteId: "dfid_abc" });
    expect(document.querySelectorAll("script")).toHaveLength(1);
  });

  it("keeps an existing window.datafast (a loaded tracker or DataFast's own snippet)", () => {
    const calls: unknown[][] = [];
    const fn = ((...args: unknown[]) => calls.push(args)) as TrackerFunction;
    w().datafast = fn;
    init({ websiteId: "dfid_abc" });
    track("signup");
    expect(calls).toEqual([["signup"]]);
  });

  it("requires a website id", () => {
    expect(() => scriptAttributes({ websiteId: "" })).toThrow(/websiteId/);
  });
});

describe("calls go through window.datafast", () => {
  it("queues goals with normalised parameters before the tracker loads", () => {
    expect(
      track("Checkout_Started", { plan: "pro", "item-count": 3, empty: "", skip: undefined }),
    ).toBe(true);
    expect(track("newsletter")).toBe(true);
    expect(w().datafast?.q).toEqual([
      ["checkout_started", { plan: "pro", item_count: "3" }],
      ["newsletter"],
    ]);
  });

  it("rejects what the collector would reject", () => {
    expect(track("bad name")).toBe(false);
    expect(track("x".repeat(65))).toBe(false);
    expect(track("identify")).toBe(false);
    expect(track("payment")).toBe(false);
    expect(track("ok", { "bad key!": "v" })).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]));
    expect(track("ok", many)).toBe(false);
    expect(w().datafast?.q ?? []).toEqual([]);
    expect(normalizeParams({ long: "y".repeat(300) })).toEqual({
      ok: true,
      value: { long: "y".repeat(255) },
    });
  });

  it("identify, payment and consent use the tracker's commands", () => {
    expect(identify("user_1", { name: "Ada", image: undefined, plan: "pro", user_id: "x" })).toBe(
      true,
    );
    expect(identify("")).toBe(false);
    expect(payment("ada@example.com ")).toBe(true);
    expect(payment("nope")).toBe(false);
    expect(consent(true)).toBe(true);
    expect(w().datafast?.q).toEqual([
      ["identify", { name: "Ada", plan: "pro", user_id: "user_1" }],
      ["payment", { email: "ada@example.com" }],
      ["consent", true],
    ]);
  });
});

describe("visitor helpers", () => {
  it("reads the visitor and session cookies, ignoring malformed values", () => {
    expect(getVisitorId()).toBeNull();
    setCookie(`datafast_visitor_id=${VID}; path=/`);
    setCookie(`datafast_session_id=${SID}; path=/`);
    expect(getVisitorId()).toBe(VID);
    expect(getSessionId()).toBe(SID);
    setCookie("datafast_visitor_id=not-a-uuid; path=/");
    expect(getVisitorId()).toBeNull();
  });

  it("falls back to the cookieless tracker's visitorId", () => {
    const fn = (() => undefined) as TrackerFunction;
    fn.visitorId = "a1b2c3";
    w().datafast = fn;
    expect(getVisitorId()).toBe("a1b2c3");
  });

  it("builds cross-domain parameters and URLs", () => {
    setCookie(`datafast_visitor_id=${VID}; path=/`);
    setCookie(`datafast_session_id=${SID}; path=/`);
    setCookie("datafast_visitor_first_seen_at=2026-11-01T10:00:00.000Z; path=/");
    setCookie("datafast_visitor_session_count=4; path=/");
    expect(getTrackingParams()).toEqual({
      _dg_vid: VID,
      _dg_sid: SID,
      _dg_vfs: "2026-11-01T10:00:00.000Z",
      _dg_vsn: "4",
    });
    const url = new URL(buildCrossDomainUrl("https://app.example.io/signup?ref=x"));
    expect(url.searchParams.get("ref")).toBe("x");
    expect(url.searchParams.get("_dg_vid")).toBe(VID);
    expect(url.searchParams.get("_dg_vsn")).toBe("4");
  });

  it("opts this browser out and back in with datagoat_ignore", () => {
    optOut();
    expect(localStorage.getItem("datagoat_ignore")).toBe("true");
    optIn();
    expect(localStorage.getItem("datagoat_ignore")).toBeNull();
  });
});
