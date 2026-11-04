import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function setCookie(value: string) {
  // biome-ignore lint/suspicious/noDocumentCookie: tests set the tracker's cookies directly
  document.cookie = value;
}

// The storefront loader is a hand-written static asset (static/apps/shopify.js); run it as-is.
const CODE = readFileSync(join(__dirname, "..", "..", "static", "apps", "shopify.js"), "utf8");
const VID = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const SID = "s0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";

type Fn = ((...args: unknown[]) => void) & { q?: unknown[][] };
type W = Window & {
  datafast?: Fn;
  __datagoatShopify?: boolean;
  __datagoatNativeFetch?: typeof fetch;
};
const w = () => window as unknown as W;

let fetchMock: ReturnType<typeof vi.fn>;

function run(src: string) {
  const script = document.createElement("script");
  script.src = src;
  Object.defineProperty(document, "currentScript", { value: script, configurable: true });
  new Function(CODE)();
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  for (const c of document.cookie.split(";")) {
    const name = c.split("=")[0]?.trim();
    if (name) setCookie(`${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`);
  }
  sessionStorage.clear();
  delete w().datafast;
  delete w().__datagoatShopify;
  delete w().__datagoatNativeFetch;
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  window.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Shopify storefront loader", () => {
  it("adds the tracker from the loader's origin with the tracking id and collector URL", () => {
    run("https://dg.example.com/apps/shopify.js?id=dfid_shop&shop=goat.myshopify.com");
    const tag = document.querySelector("script[data-website-id]") as HTMLScriptElement;
    expect(tag.getAttribute("src")).toBe("https://dg.example.com/js/script.js");
    expect(tag.getAttribute("data-website-id")).toBe("dfid_shop");
    expect(tag.getAttribute("data-domain")).toBe(location.hostname.replace(/^www\./, ""));
    expect(tag.getAttribute("data-api-url")).toBe("https://dg.example.com/api/events");
    expect(typeof w().datafast).toBe("function");
    // Loading twice (theme + ScriptTag) does nothing more.
    run("https://dg.example.com/apps/shopify.js?id=dfid_shop");
    expect(document.querySelectorAll("script[data-website-id]")).toHaveLength(1);
  });

  it("honours an explicit domain and an existing tracker tag", () => {
    const existing = document.createElement("script");
    existing.setAttribute("data-website-id", "dfid_manual");
    document.head.appendChild(existing);
    run("https://dg.example.com/apps/shopify.js?id=dfid_shop&domain=shop.example.com");
    expect(document.querySelectorAll("script[data-website-id]")).toHaveLength(1);
  });

  it("copies the visitor and session into hidden cart attributes once per session", async () => {
    setCookie(`datafast_visitor_id=${VID}; path=/`);
    setCookie(`datafast_session_id=${SID}; path=/`);
    run("https://dg.example.com/apps/shopify.js?id=dfid_shop");
    await flush();
    const update = fetchMock.mock.calls.find((c) => c[0] === "/cart/update.js");
    expect(update).toBeTruthy();
    expect(JSON.parse(String((update?.[1] as RequestInit | undefined)?.body ?? "{}"))).toEqual({
      attributes: { _datafast_visitor_id: VID, _datafast_session_id: SID },
    });
    expect(sessionStorage.getItem("datagoat_cart_attributes")).toBe(`${VID}|${SID}`);
    delete w().__datagoatShopify;
    delete w().__datagoatNativeFetch;
    fetchMock.mockClear();
    run("https://dg.example.com/apps/shopify.js?id=dfid_shop");
    await flush();
    expect(fetchMock.mock.calls.some((c) => c[0] === "/cart/update.js")).toBe(false);
  });

  it("sends add_to_cart for AJAX adds (and re-syncs the cart) and initiate_checkout on checkout clicks", async () => {
    setCookie(`datafast_visitor_id=${VID}; path=/`);
    run("https://dg.example.com/apps/shopify.js?id=dfid_shop");
    await flush();
    fetchMock.mockClear();
    await window.fetch("/cart/add.js", { method: "POST", body: "id=1" });
    await flush();
    expect(w().datafast?.q).toContainEqual(["add_to_cart"]);
    expect(fetchMock.mock.calls.some((c) => c[0] === "/cart/update.js")).toBe(true);

    const button = document.createElement("button");
    button.setAttribute("name", "checkout");
    const inner = document.createElement("span");
    button.appendChild(inner);
    document.body.appendChild(button);
    inner.click();
    expect(w().datafast?.q).toContainEqual(["initiate_checkout"]);
    // Debounced: a double click is one goal. (Earlier tests in this file left listeners on the
    // shared document, so compare counts instead of expecting exactly one.)
    const count = () => w().datafast?.q?.filter((c) => c[0] === "initiate_checkout").length;
    const before = count();
    inner.click();
    expect(count()).toBe(before);
  });

  it("sends add_to_cart for classic form posts that navigate, not for prevented ones", () => {
    run("https://dg.example.com/apps/shopify.js?id=dfid_shop");
    const form = document.createElement("form");
    form.setAttribute("action", "/cart/add");
    document.body.appendChild(form);
    const prevented = new Event("submit", { bubbles: true, cancelable: true });
    form.addEventListener("submit", (e) => e.preventDefault(), { once: true });
    form.dispatchEvent(prevented);
    expect(w().datafast?.q ?? []).not.toContainEqual(["add_to_cart"]);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(w().datafast?.q).toContainEqual(["add_to_cart"]);
  });

  it("with goals=0 leaves fetch alone (the custom pixel sends the goals)", () => {
    const original = window.fetch;
    run("https://dg.example.com/apps/shopify.js?id=dfid_shop&goals=0");
    expect(window.fetch).toBe(original);
  });

  it("does nothing without an id", () => {
    run("https://dg.example.com/apps/shopify.js");
    expect(document.querySelector("script[data-website-id]")).toBeNull();
  });
});
