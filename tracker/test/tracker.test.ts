/**
 * script.js (default build): every DataFast-compatible behaviour plus DataGoat's extensions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLocalHost, uuid } from "../src/tracker";
import { queueSnippet, setup } from "./harness";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("script tag attributes", () => {
  it("sends DataFast's body for the first pageview", () => {
    const t = setup({ url: "https://www.example.com/pricing?utm_source=x&gclid=g1&fbclid=f1" });
    expect(t.types()).toEqual(["pageview"]);
    const body = t.last();
    expect(Object.keys(body)).toEqual([
      "websiteId",
      "domain",
      "href",
      "referrer",
      "viewport",
      "visitorId",
      "sessionId",
      "visitorFirstSeenAt",
      "visitorSessionNumber",
      "adClickIds",
      "language",
      "timezone",
      "screenWidth",
      "screenHeight",
      "type",
    ]);
    expect(body).toMatchObject({
      websiteId: "dfid_test",
      domain: "example.com",
      href: "https://www.example.com/pricing?utm_source=x&gclid=g1&fbclid=f1",
      referrer: null,
      viewport: { width: 1024, height: 768 },
      visitorSessionNumber: 1,
      adClickIds: { gclid: "g1", fbclid: "f1" },
      language: "en-US",
      type: "pageview",
    });
    expect(body.visitorId).toMatch(UUID);
    expect(body.sessionId).toMatch(/^s[0-9a-f-]{36}$/);
    expect(Date.parse(String(body.visitorFirstSeenAt))).not.toBeNaN();
    expect(body).not.toHaveProperty("cookieless");
    expect(body).not.toHaveProperty("trackHash");
  });

  it("omits adClickIds when the URL has none, and sends the referrer", () => {
    const t = setup({
      before: (w) =>
        Object.defineProperty(w.document, "referrer", { value: "https://news.ycombinator.com/" }),
    });
    expect(t.last()).not.toHaveProperty("adClickIds");
    expect(t.last().referrer).toBe("https://news.ycombinator.com/");
  });

  it("defaults domain to the page hostname when data-domain is missing", () => {
    const t = setup({ url: "https://shop.example.org/", attrs: { "data-domain": "" } });
    expect(t.last().domain).toBe("shop.example.org");
  });

  it("posts to /api/events on the origin the script was loaded from", () => {
    const t = setup({ src: "https://analytics.example.net/js/script.js" });
    expect(t.sent[0]?.url).toBe("https://analytics.example.net/api/events");
  });

  it("posts to /api/events on the page origin for a proxied script", () => {
    const t = setup({ src: "/js/script.js" });
    expect(t.sent[0]?.url).toBe("https://www.example.com/api/events");
  });

  it("data-api-url accepts a full URL or a path relative to the page", () => {
    expect(
      setup({ attrs: { "data-api-url": "https://a.example.com/api/events" } }).sent[0]?.url,
    ).toBe("https://a.example.com/api/events");
    expect(
      setup({
        src: "https://cdn.example.net/js/script.js",
        attrs: { "data-api-url": "/custom-events" },
      }).sent[0]?.url,
    ).toBe("https://www.example.com/custom-events");
  });

  it("data-website-id is required", () => {
    const t = setup({ attrs: { "data-website-id": "" } });
    expect(t.sent).toEqual([]);
    expect(t.console.warn).toHaveBeenCalledWith(
      "DataGoat: Tracking disabled - missing data-website-id",
    );
  });

  it("data-disable-console silences every message", () => {
    const t = setup({ url: "http://localhost:3000/", attrs: { "data-disable-console": "true" } });
    t.api("signup");
    expect(t.console.warn).not.toHaveBeenCalled();
    expect(t.console.log).not.toHaveBeenCalled();
  });

  it("data-debug logs each send", () => {
    const t = setup({ attrs: { "data-debug": "true" } });
    expect(t.console.log).toHaveBeenCalledWith("DataGoat: sending pageview");
  });
});

describe("where tracking is off", () => {
  it.each([
    ["localhost", "http://localhost:3000/"],
    ["127.0.0.1", "http://127.0.0.1:8080/"],
    ["127.x", "http://127.1.2.3/"],
    ["::1", "http://[::1]:3000/"],
    [".local", "http://mac.local/"],
    [".localhost", "http://app.localhost/"],
  ])("%s without data-allow-localhost", (_label, url) => {
    const t = setup({ url });
    expect(t.sent).toEqual([]);
    expect(t.console.warn).toHaveBeenCalledWith("DataGoat: Tracking disabled - localhost");
    // window.datafast still exists and logs what it ignored.
    t.api("signup");
    expect(t.console.log).toHaveBeenCalledWith(
      "DataGoat: Event 'signup' ignored - Tracking disabled - localhost",
    );
  });

  it("localhost with data-allow-localhost=true", () => {
    const t = setup({ url: "http://localhost:3000/", attrs: { "data-allow-localhost": "true" } });
    expect(t.types()).toEqual(["pageview"]);
    // No domain attribute on localhost cookies.
    expect(t.cookie("datagoat_visitor_id")).toMatch(UUID);
  });

  it("file: pages only with data-allow-file-protocol=true", () => {
    expect(setup({ url: "file:///Users/me/index.html" }).sent).toEqual([]);
    const t = setup({
      url: "file:///Users/me/index.html",
      attrs: { "data-allow-file-protocol": "true" },
    });
    expect(t.types()).toEqual(["pageview"]);
  });

  it("inside an iframe unless data-debug=true", () => {
    const parent = {};
    const t = setup({ before: (w) => Object.defineProperty(w, "parent", { value: parent }) });
    expect(t.sent).toEqual([]);
    expect(t.console.warn).toHaveBeenCalledWith("DataGoat: Tracking disabled - inside an iframe");
    const dbg = setup({
      attrs: { "data-debug": "true" },
      before: (w) => Object.defineProperty(w, "parent", { value: parent }),
    });
    expect(dbg.types()).toEqual(["pageview"]);
  });

  it.each(["datagoat_ignore", "datafast_ignore"])("when localStorage.%s is 'true'", (key) => {
    const t = setup({ before: (w) => w.localStorage.setItem(key, "true") });
    expect(t.sent).toEqual([]);
    expect(t.console.warn).toHaveBeenCalledWith(
      "DataGoat: Tracking disabled - datagoat_ignore is set",
    );
  });

  it.each([
    ["navigator.webdriver", { webdriver: true }],
    ["a HeadlessChrome UA", { userAgent: "Mozilla/5.0 HeadlessChrome/120.0" }],
    ["a puppeteer UA", { userAgent: "Mozilla/5.0 Puppeteer" }],
    ["a python UA", { userAgent: "python-requests/2.31" }],
    ["a short UA", { userAgent: "abc" }],
    ["window.callPhantom", { before: (w: Record<string, unknown>) => (w.callPhantom = () => {}) }],
    ["window.__nightmare", { before: (w: Record<string, unknown>) => (w.__nightmare = {}) }],
    ["a Selenium global", { before: (w: Record<string, unknown>) => (w._selenium = {}) }],
    [
      "ChromeDriver's $cdc_ marker",
      { before: (w: Record<string, unknown>) => (w.$cdc_asdjflasutopfhvcZLmcfl_ = {}) },
    ],
    [
      "a webdriver attribute on <html>",
      {
        before: (w: { document: Document }) =>
          w.document.documentElement.setAttribute("webdriver", "true"),
      },
    ],
  ])("for bots: %s", (_label, options) => {
    const t = setup(options as never);
    expect(t.sent).toEqual([]);
    expect(t.console.warn).toHaveBeenCalledWith("DataGoat: Tracking disabled - bot detected");
  });

  it("re-checks for bots before every send", () => {
    const t = setup();
    (t.w as Record<string, unknown>).__selenium_evaluate = () => {};
    t.api("signup");
    expect(t.types()).toEqual(["pageview"]);
    expect(t.console.log).toHaveBeenCalledWith("DataGoat: Event 'signup' ignored - bot detected");
  });
});

describe("cookies", () => {
  it("writes the four datagoat_ cookies with SameSite=Lax and Secure on https", () => {
    const writes: string[] = [];
    const t = setup({ before: (w) => captureCookieWrites(w, writes) });
    const body = t.last();
    expect(t.cookie("datagoat_visitor_id")).toBe(body.visitorId);
    expect(t.cookie("datagoat_session_id")).toBe(body.sessionId);
    expect(t.cookie("datagoat_visitor_first_seen_at")).toBe(body.visitorFirstSeenAt);
    expect(t.cookie("datagoat_visitor_session_count")).toBe("1");
    const visitor = writes.find((c) => c.startsWith("datagoat_visitor_id="));
    expect(visitor).toMatch(/; path=\/; domain=\.example\.com; SameSite=Lax; Secure$/);
    const days = (Date.parse(visitor?.match(/expires=([^;]+)/)?.[1] ?? "") - Date.now()) / 864e5;
    expect(Math.round(days)).toBe(365);
    const sessionCookie = writes.find((c) => c.startsWith("datagoat_session_id="));
    const minutes =
      (Date.parse(sessionCookie?.match(/expires=([^;]+)/)?.[1] ?? "") - Date.now()) / 6e4;
    expect(Math.round(minutes)).toBe(30);
  });

  it("omits Secure on http and uses the hostname when it is outside data-domain", () => {
    const writes: string[] = [];
    setup({
      url: "http://shop.other.org/",
      before: (w) => captureCookieWrites(w, writes),
      attrs: { "data-allowed-hostnames": "shop.other.org" },
    });
    expect(writes.find((c) => c.startsWith("datagoat_visitor_id="))).toMatch(
      /; domain=\.shop\.other\.org; SameSite=Lax$/,
    );
  });

  it("keeps the visitor and session across page loads and counts new sessions", () => {
    const first = setup();
    const cookies = first.win.document.cookie;
    const second = setup({
      url: "https://www.example.com/next",
      before: (w) => restore(w, cookies),
    });
    expect(second.last().visitorId).toBe(first.last().visitorId);
    expect(second.last().sessionId).toBe(first.last().sessionId);
    expect(second.last().visitorSessionNumber).toBe(1);
    // Session expired (cookie gone): a new session, number 2, same visitor.
    const withoutSession = cookies
      .split("; ")
      .filter((c: string) => !c.startsWith("datagoat_session_id="))
      .join("; ");
    const third = setup({
      url: "https://www.example.com/later",
      before: (w) => restore(w, withoutSession),
    });
    expect(third.last().visitorId).toBe(first.last().visitorId);
    expect(third.last().sessionId).not.toBe(first.last().sessionId);
    expect(third.last().visitorSessionNumber).toBe(2);
    expect(third.last().visitorFirstSeenAt).toBe(first.last().visitorFirstSeenAt);
  });

  it("reuses DataFast's existing cookies (switching from DataFast keeps visitors)", () => {
    const t = setup({
      before: (w) =>
        restore(
          w,
          "datafast_visitor_id=72de85b4-8d8a-48d6-a920-c50470a86a1a; datafast_session_id=s3457d400-1b6c-4565-b487-f1cf45306cc1; datafast_visitor_first_seen_at=2026-11-04T17%3A26%3A33.885Z; datafast_visitor_session_count=4",
        ),
    });
    expect(t.last()).toMatchObject({
      visitorId: "72de85b4-8d8a-48d6-a920-c50470a86a1a",
      sessionId: "s3457d400-1b6c-4565-b487-f1cf45306cc1",
      visitorFirstSeenAt: "2026-11-04T17:26:33.885Z",
      visitorSessionNumber: 4,
    });
  });

  it("moves a DataFast visitor onto datagoat_ cookies, and writes datafast_ ones only in compat mode", () => {
    const legacy = "datafast_visitor_id=72de85b4-8d8a-48d6-a920-c50470a86a1a";
    const plain = setup({ before: (w) => restore(w, legacy) });
    expect(plain.cookie("datagoat_visitor_id")).toBe("72de85b4-8d8a-48d6-a920-c50470a86a1a");
    const fresh = setup();
    expect(fresh.cookie("datagoat_visitor_id")).toMatch(UUID);
    expect(fresh.cookie("datafast_visitor_id")).toBeUndefined();
    // data-compat="datafast": checkout code reading datafast_visitor_id keeps working.
    const compat = setup({ attrs: { "data-compat": "datafast" } });
    const id = compat.last().visitorId;
    for (const prefix of ["datagoat_", "datafast_"]) {
      expect(compat.cookie(`${prefix}visitor_id`)).toBe(id);
      expect(compat.cookie(`${prefix}session_id`)).toBe(compat.last().sessionId);
    }
  });

  it("adopts DataFast's _df_ cross-domain parameters too", () => {
    const vid = "0d6b2c1e-8a8e-4f5b-9b0a-6c8d1e2f3a4b";
    const t = setup({ url: `https://www.example.com/?_df_vid=${vid}&_df_sid=s${vid}` });
    expect(t.cookie("datagoat_visitor_id")).toBe(vid);
    expect(t.win.location.search).toBe("");
  });

  it("consent(false) also deletes DataFast's cookies", () => {
    const t = setup({ attrs: { "data-compat": "datafast" } });
    expect(t.cookie("datafast_visitor_id")).toBeDefined();
    t.api("consent", false);
    expect(t.cookie("datafast_visitor_id")).toBeUndefined();
    expect(t.cookie("datagoat_visitor_id")).toBeUndefined();
  });

  it("exposes the visitor id on window.datafast and window.datagoat", () => {
    const t = setup();
    expect(t.w.datafast).toBe(t.w.datagoat);
    expect((t.w.datafast as { visitorId?: string }).visitorId).toBe(t.last().visitorId);
  });
});

/** Put cookies back as the tracker wrote them (domain cookies on .example.com). */
function restore(w: { document: Document }, cookies: string) {
  for (const c of cookies.split("; ").filter(Boolean))
    w.document.cookie = `${c}; path=/; domain=.example.com`;
}

/** Record every `document.cookie = ...` write. */
function captureCookieWrites(w: { document: Document }, writes: string[]) {
  const d = w.document;
  let proto: object | null = d;
  let desc: PropertyDescriptor | undefined;
  while (proto && !desc) {
    desc = Object.getOwnPropertyDescriptor(proto, "cookie");
    if (!desc) proto = Object.getPrototypeOf(proto);
  }
  Object.defineProperty(d, "cookie", {
    configurable: true,
    get: () => desc?.get?.call(d),
    set: (v: string) => {
      writes.push(v);
      desc?.set?.call(d, v);
    },
  });
}

describe("pageview dedup and SPA navigation", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));

  it("ignores a second pageview of the same URL within 60 seconds (survives reloads)", () => {
    const first = setup();
    const state = first.win.sessionStorage.getItem("datagoat_pageview_state");
    expect(JSON.parse(state ?? "{}")).toMatchObject({ url: "https://www.example.com/" });
    const reload = setup({
      before: (w) => w.sessionStorage.setItem("datagoat_pageview_state", state ?? ""),
    });
    expect(reload.sent).toEqual([]);
    expect(reload.console.log).toHaveBeenCalledWith(
      "DataGoat: Pageview ignored - throttled (same URL within 1 minute)",
    );
    const old = JSON.stringify({ time: Date.now() - 61_000, url: "https://www.example.com/" });
    expect(
      setup({ before: (w) => w.sessionStorage.setItem("datagoat_pageview_state", old) }).types(),
    ).toEqual(["pageview"]);
  });

  it("tracks pushState and popstate when the pathname changes, after 100 ms", () => {
    const t = setup();
    t.win.history.pushState({}, "", "/a");
    expect(t.types()).toEqual(["pageview"]);
    vi.advanceTimersByTime(100);
    expect(t.bodies().map((b) => b.href)).toEqual([
      "https://www.example.com/",
      "https://www.example.com/a",
    ]);
    // Query-only and hash-only changes are not pageviews in this build.
    t.win.history.pushState({}, "", "/a?tab=2");
    t.win.history.pushState({}, "", "/a?tab=2#x");
    vi.advanceTimersByTime(200);
    expect(t.sent).toHaveLength(2);
    // replaceState is not hooked in the default build.
    t.win.history.replaceState({}, "", "/replaced");
    vi.advanceTimersByTime(200);
    expect(t.sent).toHaveLength(2);
    t.win.history.pushState({}, "", "/b");
    vi.advanceTimersByTime(100);
    t.win.history.back();
    t.win.dispatchEvent(new t.win.PopStateEvent("popstate"));
    vi.advanceTimersByTime(100);
    expect(t.sent.length).toBeGreaterThanOrEqual(3);
  });

  it("debounces rapid navigations into one pageview", () => {
    const t = setup();
    t.win.history.pushState({}, "", "/1");
    t.win.history.pushState({}, "", "/2");
    t.win.history.pushState({}, "", "/3");
    vi.advanceTimersByTime(100);
    expect(t.bodies().map((b) => b.href)).toEqual([
      "https://www.example.com/",
      "https://www.example.com/3",
    ]);
  });

  it("keeps the original pushState behaviour", () => {
    const t = setup();
    t.win.history.pushState({ x: 1 }, "", "/kept");
    expect(t.win.location.pathname).toBe("/kept");
    expect(t.win.history.state).toEqual({ x: 1 });
  });
});

describe("window.datafast(...)", () => {
  it("sends goals as custom events with eventName and parameters", () => {
    const t = setup();
    t.api("initiate_checkout", { plan: "pro", price: 49, trial: true, empty: null });
    expect(t.last()).toMatchObject({
      type: "custom",
      extraData: { eventName: "initiate_checkout", plan: "pro", price: 49, trial: true },
    });
  });

  it("normalises goal names and rejects invalid ones", () => {
    const t = setup();
    t.api("Sign Up");
    expect(t.last().extraData).toEqual({ eventName: "sign_up" });
    t.api("bad name!");
    t.api("x".repeat(65));
    expect(t.sent).toHaveLength(2);
    expect(t.console.error).toHaveBeenCalledWith('DataGoat: Invalid goal name "bad name!"');
  });

  it("rejects the whole goal for more than 10 parameters or a bad parameter name", () => {
    const t = setup();
    t.api("g", Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`p${i}`, i])));
    t.api("g", { "bad key": 1 });
    t.api("g", { ["k".repeat(65)]: 1 });
    expect(t.sent).toHaveLength(1);
    t.api("g", { ["k".repeat(64)]: 1 });
    expect(t.sent).toHaveLength(2);
  });

  it("sanitises parameter values and caps them at 255 characters", () => {
    const t = setup();
    t.api("g", { a: "<script>alert('x')</script>", b: "javascript:void(0)", c: "y".repeat(300) });
    expect(t.last().extraData).toEqual({
      eventName: "g",
      a: "scriptalert(x)/script",
      b: "void(0)",
      c: "y".repeat(255),
    });
  });

  it("identify sends user_id, name and image like DataFast", () => {
    const t = setup();
    t.api("identify", { user_id: "u1" });
    expect(t.last()).toMatchObject({
      type: "identify",
      extraData: { user_id: "u1", name: "", image: "" },
    });
    t.api("identify", { user_id: 42, name: "Jane", image: "https://x/y.png", plan: "pro" });
    expect(t.last().extraData).toEqual({
      user_id: "42",
      name: "Jane",
      image: "https://x/y.png",
      plan: "pro",
    });
    t.api("identify", { name: "no id" });
    expect(t.sent).toHaveLength(3);
    expect(t.console.warn).toHaveBeenCalledWith("DataGoat: identify requires user_id");
  });

  it("payment sends the email; without an email it warns", () => {
    const t = setup();
    t.api("payment", { email: "buyer@example.com" });
    expect(t.last()).toMatchObject({ type: "payment", extraData: { email: "buyer@example.com" } });
    t.api("payment", {});
    expect(t.sent).toHaveLength(2);
    expect(t.console.warn).toHaveBeenCalledWith("DataGoat: payment requires email");
  });

  it("drains DataFast's pre-load queue after the first pageview, in order", () => {
    const t = setup({
      before: (w) => {
        queueSnippet(w);
        const df = w.datafast as (...a: unknown[]) => void;
        df("signup", { plan: "pro" });
        df("identify", { user_id: "u1" });
      },
    });
    expect(t.types()).toEqual(["pageview", "custom", "identify"]);
    expect(t.w.datafast).not.toBeUndefined();
    // Calls after load go straight out.
    (t.w.datafast as (...a: unknown[]) => void)("later");
    expect(t.types()).toEqual(["pageview", "custom", "identify", "custom"]);
  });

  it("drains a window.datagoat queue too and does not initialise twice", async () => {
    const t = setup({
      before: (w) => {
        w.datagoat = Object.assign(() => {}, { q: [["from_datagoat"]] });
      },
    });
    expect(t.types()).toEqual(["pageview", "custom"]);
    const { init } = await import("../src/tracker");
    expect(init(t.w as never)).toBe(t.api);
    expect(t.sent).toHaveLength(2);
  });

  it("ignores a missing event name", () => {
    const t = setup();
    t.api();
    expect(t.console.warn).toHaveBeenCalledWith("DataGoat: Missing event name");
  });
});

describe("declarative goals (data-fast-goal)", () => {
  const html = `
    <button id="b" data-fast-goal="product_added" data-fast-goal-product-id="prod_123" data-fast-goal-product-name="Premium Plan" data-fast-goal-price="49"><span id="inner">Add</span></button>
    <div id="d" role="button" tabindex="0" data-fast-goal="open_menu"><span id="dspan">Menu</span></div>
    <div data-fast-goal="wrapper"><button id="nested">Go</button></div>`;

  it("tracks clicks with data-fast-goal-* parameters in snake_case", () => {
    const t = setup({ html });
    (t.win.document.getElementById("inner") as unknown as HTMLElement).click();
    expect(t.last()).toMatchObject({
      type: "custom",
      extraData: {
        eventName: "product_added",
        product_id: "prod_123",
        product_name: "Premium Plan",
        price: "49",
      },
    });
  });

  it("tracks Enter and Space on custom controls, once", () => {
    const t = setup({ html });
    const d = t.win.document;
    const key = (id: string, k: string) =>
      d
        .getElementById(id)
        ?.dispatchEvent(new t.win.KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("d", "Enter");
    key("d", " ");
    key("d", "a");
    expect(t.bodies().filter((b) => b.type === "custom")).toHaveLength(2);
    // A native button turns Enter into a click itself: the keydown is not counted twice.
    key("nested", "Enter");
    expect(t.bodies().filter((b) => b.type === "custom")).toHaveLength(2);
  });
});

describe("scroll goals (data-fast-scroll)", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  const html = `
    <section id="p" data-fast-scroll="viewed_pricing"></section>
    <section id="t" data-fast-scroll="read_testimonials" data-fast-scroll-threshold="0.7" data-fast-scroll-delay="2000" data-fast-scroll-section-name="testimonials"></section>`;

  it("fires once at 50% visibility by default with scroll_percentage, threshold and delay", () => {
    const t = setup({ html });
    const [pricing] = t.observers;
    expect(pricing?.options.threshold).toBe(0.5);
    pricing?.ratio(0.3);
    vi.advanceTimersByTime(0);
    expect(t.types()).toEqual(["pageview"]);
    pricing?.ratio(0.6);
    vi.advanceTimersByTime(0);
    expect(t.last()).toMatchObject({
      type: "custom",
      extraData: { eventName: "viewed_pricing", threshold: 0.5, delay: 0 },
    });
    expect(typeof (t.last().extraData as Record<string, unknown>).scroll_percentage).toBe("number");
    expect(pricing?.disconnected).toBe(true);
  });

  it("honours threshold, delay and data-fast-scroll-* parameters", () => {
    const t = setup({ html });
    const testimonials = t.observers[1];
    expect(testimonials?.options.threshold).toBe(0.7);
    testimonials?.ratio(0.8);
    vi.advanceTimersByTime(1999);
    expect(t.types()).toEqual(["pageview"]);
    vi.advanceTimersByTime(1);
    expect(t.last().extraData).toMatchObject({
      eventName: "read_testimonials",
      threshold: 0.7,
      delay: 2000,
      section_name: "testimonials",
    });
  });

  it("cancels the delayed goal when the element leaves before the delay", () => {
    const t = setup({ html });
    const testimonials = t.observers[1];
    testimonials?.ratio(0.9);
    vi.advanceTimersByTime(1000);
    testimonials?.ratio(0.2);
    vi.advanceTimersByTime(5000);
    expect(t.types()).toEqual(["pageview"]);
  });

  it("observes elements that appear after SPA navigation, each only once", () => {
    const t = setup({ html });
    expect(t.observers).toHaveLength(2);
    const extra = t.win.document.createElement("div");
    extra.setAttribute("data-fast-scroll", "late");
    t.win.document.body.appendChild(extra);
    t.win.history.pushState({}, "", "/next");
    vi.advanceTimersByTime(100);
    expect(t.observers).toHaveLength(3);
  });
});

describe("outbound links (external_link)", () => {
  const html = `
    <a id="ext" href="https://github.com/sarequl/datagoat">  GitHub  </a>
    <a id="sub" href="https://blog.example.com/post">Blog</a>
    <a id="same" href="/pricing">Pricing</a>
    <a id="mail" href="mailto:hi@example.com">Mail</a>`;
  const click = (t: ReturnType<typeof setup>, id: string, init: MouseEventInit = {}) => {
    const el = t.win.document.getElementById(id) as unknown as HTMLElement;
    el.addEventListener("click", (e) => e.preventDefault());
    el.dispatchEvent(
      new t.win.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        ...init,
      }) as unknown as Event,
    );
  };

  it("sends url and text for links to other sites", () => {
    const t = setup({ html });
    click(t, "ext");
    expect(t.last()).toMatchObject({
      type: "external_link",
      extraData: { url: "https://github.com/sarequl/datagoat", text: "GitHub" },
    });
  });

  it("ignores same-site, subdomain and non-http links", () => {
    const t = setup({ html });
    for (const id of ["sub", "same", "mail"]) click(t, id);
    expect(t.types()).toEqual(["pageview"]);
  });

  it("counts middle clicks but not right clicks", () => {
    const t = setup({ html });
    const el = t.win.document.getElementById("ext") as unknown as HTMLElement;
    el.dispatchEvent(
      new t.win.MouseEvent("auxclick", { bubbles: true, button: 1 }) as unknown as Event,
    );
    el.dispatchEvent(
      new t.win.MouseEvent("auxclick", { bubbles: true, button: 2 }) as unknown as Event,
    );
    expect(t.types()).toEqual(["pageview", "external_link"]);
  });
});

describe("cross-domain linking", () => {
  const html = `<a id="app" href="https://myapp.io/signup?plan=pro#top">App</a><a id="other" href="https://other.dev/">Other</a>`;

  it("appends _dg_vid, _dg_sid, _dg_vfs and _dg_vsn to links to allowed hostnames", () => {
    const t = setup({ html, attrs: { "data-allowed-hostnames": "myapp.io, shop.example.net" } });
    const a = t.win.document.getElementById("app") as unknown as HTMLAnchorElement;
    a.dispatchEvent(new t.win.MouseEvent("mousedown", { bubbles: true }) as unknown as Event);
    const url = new URL(a.href);
    const body = t.last();
    expect(url.searchParams.get("_dg_vid")).toBe(body.visitorId);
    expect(url.searchParams.get("_dg_sid")).toBe(body.sessionId);
    expect(url.searchParams.get("_dg_vfs")).toBe(body.visitorFirstSeenAt);
    expect(url.searchParams.get("_dg_vsn")).toBe("1");
    expect(url.searchParams.get("plan")).toBe("pro");
    expect(url.hash).toBe("#top");
    const other = t.win.document.getElementById("other") as unknown as HTMLAnchorElement;
    other.dispatchEvent(new t.win.MouseEvent("mousedown", { bubbles: true }) as unknown as Event);
    expect(other.href).toBe("https://other.dev/");
  });

  it("decorates links back to the main domain from an allowed domain", () => {
    const t = setup({
      url: "https://myapp.io/",
      html: `<a id="home" href="https://example.com/">Home</a>`,
      attrs: { "data-allowed-hostnames": "myapp.io" },
    });
    const a = t.win.document.getElementById("home") as unknown as HTMLAnchorElement;
    a.dispatchEvent(new t.win.MouseEvent("mousedown", { bubbles: true }) as unknown as Event);
    expect(new URL(a.href).searchParams.get("_dg_vid")).toBe(t.last().visitorId);
  });

  it("adopts the ids on arrival and strips them from the address bar before the pageview", () => {
    const vid = "72de85b4-8d8a-48d6-a920-c50470a86a1a";
    const sid = "s3457d400-1b6c-4565-b487-f1cf45306cc1";
    const t = setup({
      url: `https://www.example.com/welcome?x=1&_dg_vid=${vid}&_dg_sid=${sid}&_dg_vfs=2026-11-01T10%3A00%3A00.000Z&_dg_vsn=3#h`,
    });
    expect(t.win.location.href).toBe("https://www.example.com/welcome?x=1#h");
    expect(t.last()).toMatchObject({
      href: "https://www.example.com/welcome?x=1#h",
      visitorId: vid,
      sessionId: sid,
      visitorFirstSeenAt: "2026-11-01T10:00:00.000Z",
      visitorSessionNumber: 3,
    });
    expect(t.cookie("datagoat_visitor_id")).toBe(vid);
  });

  it("ignores malformed arrival ids but still cleans the URL", () => {
    const t = setup({ url: "https://www.example.com/?_dg_vid=evil&_dg_sid=x" });
    expect(t.win.location.search).toBe("");
    expect(t.last().visitorId).not.toBe("evil");
  });
});

describe("payment success pages", () => {
  it.each([
    [
      "Stripe",
      "?session_id=cs_test_a1b2c3",
      { stripe_session_id: "cs_test_a1b2c3" },
      "datagoat_stripe_payment_sent_cs_test_a1b2c3",
    ],
    [
      "Polar",
      "?checkout_id=9f5e3c5e",
      { polar_checkout_id: "9f5e3c5e" },
      "datagoat_polar_payment_sent_9f5e3c5e",
    ],
    [
      "Lemon Squeezy",
      "?order_id=123456",
      { lemonsqueezy_order_id: "123456" },
      "datagoat_lemonsqueezy_payment_sent_123456",
    ],
    [
      "Paddle",
      "?transaction_id=txn_01h8bxq3m4",
      { paddle_transaction_id: "txn_01h8bxq3m4" },
      "datagoat_paddle_payment_sent_txn_01h8bxq3m4",
    ],
    [
      "Paddle (explicit)",
      "?paddle_transaction_id=txn_99",
      { paddle_transaction_id: "txn_99" },
      "datagoat_paddle_payment_sent_txn_99",
    ],
  ])("%s", (_label, search, extraData, key) => {
    const t = setup({ url: `https://www.example.com/thanks${search}` });
    expect(t.types()).toEqual(["pageview", "payment"]);
    expect(t.last().extraData).toEqual(extraData);
    expect(t.win.sessionStorage.getItem(key)).toBe("true");
    // Same tab, another redirect to the same page: not sent again.
    const again = setup({
      url: `https://www.example.com/thanks${search}&again=1`,
      before: (w) => w.sessionStorage.setItem(key, "true"),
    });
    expect(again.types()).toEqual(["pageview"]);
  });

  it("ignores session_id values that are not Stripe Checkout sessions, and other transaction ids", () => {
    expect(setup({ url: "https://www.example.com/?session_id=abc" }).types()).toEqual(["pageview"]);
    expect(setup({ url: "https://www.example.com/?transaction_id=123" }).types()).toEqual([
      "pageview",
    ]);
  });

  it("data-disable-payments turns detection off but keeps datafast('payment', {email})", () => {
    const t = setup({
      url: "https://www.example.com/?session_id=cs_test_1",
      attrs: { "data-disable-payments": "true" },
    });
    expect(t.types()).toEqual(["pageview"]);
    t.api("payment", { email: "a@b.co" });
    expect(t.types()).toEqual(["pageview", "payment"]);
  });
});

describe("transport", () => {
  it("uses sendBeacon with the JSON body (sent as text/plain, no preflight)", () => {
    const t = setup();
    expect(t.sent[0]?.transport).toBe("beacon");
  });

  it("falls back to fetch with keepalive and a text/plain body", () => {
    const t = setup({ beacon: false });
    expect(t.sent[0]?.transport).toBe("fetch");
    expect(t.sent[0]?.init).toMatchObject({
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "text/plain" },
    });
  });

  it("falls back to fetch when sendBeacon refuses the payload", () => {
    const t = setup({
      before: (w) =>
        Object.defineProperty(w.navigator, "sendBeacon", {
          value: () => false,
          configurable: true,
        }),
    });
    expect(t.sent.map((s) => s.transport)).toEqual(["fetch"]);
  });

  it("falls back to XMLHttpRequest last", () => {
    const opened: string[] = [];
    const t = setup({
      beacon: false,
      fetch: false,
      before: (w) => {
        w.XMLHttpRequest = class {
          headers: Record<string, string> = {};
          open(method: string, url: string) {
            opened.push(`${method} ${url}`);
          }
          setRequestHeader(k: string, v: string) {
            this.headers[k] = v;
          }
          send(body: string) {
            opened.push(`${this.headers["Content-Type"]} ${JSON.parse(body).type}`);
          }
        };
        (globalThis as Record<string, unknown>).XMLHttpRequest = w.XMLHttpRequest;
      },
    });
    expect(t.sent).toEqual([]);
    expect(opened).toEqual(["POST https://www.example.com/api/events", "text/plain pageview"]);
  });
});

describe("consent (DataGoat extension)", () => {
  it("data-require-consent: no cookies and cookieless bodies until consent", async () => {
    const t = setup({
      attrs: { "data-require-consent": "true" },
      response: {
        visitorId: "0d6b2c1e-8a8e-4f5b-9b0a-6c8d1e2f3a4b",
        sessionId: "s0d6b2c1e-8a8e-4f5b-9b0a-6c8d1e2f3a4c",
      },
    });
    expect(t.win.document.cookie).toBe("");
    expect(t.last()).toMatchObject({ cookieless: true });
    expect(t.last()).not.toHaveProperty("visitorFirstSeenAt");
    expect(t.sent[0]?.transport).toBe("fetch"); // the response carries the server ids
    await t.flush();
    expect((t.w.datafast as { visitorId?: string }).visitorId).toBe(
      "0d6b2c1e-8a8e-4f5b-9b0a-6c8d1e2f3a4b",
    );

    t.api("consent", true);
    expect(t.cookie("datagoat_consent")).toBe("1");
    // The server's ids continue as cookie ids: same visitor and session.
    expect(t.cookie("datagoat_visitor_id")).toBe("0d6b2c1e-8a8e-4f5b-9b0a-6c8d1e2f3a4b");
    expect(t.cookie("datagoat_session_id")).toBe("s0d6b2c1e-8a8e-4f5b-9b0a-6c8d1e2f3a4c");
    t.api("signup");
    expect(t.last()).toMatchObject({
      visitorId: "0d6b2c1e-8a8e-4f5b-9b0a-6c8d1e2f3a4b",
      visitorSessionNumber: 1,
    });
    expect(t.last()).not.toHaveProperty("cookieless");
  });

  it("remembers consent on the next page load", () => {
    const t = setup({
      attrs: { "data-require-consent": "true" },
      before: (w) => restore(w, "datagoat_consent=1"),
    });
    expect(t.last()).not.toHaveProperty("cookieless");
    expect(t.cookie("datagoat_visitor_id")).toMatch(UUID);
  });

  it("consent(false) deletes the cookies and switches to cookieless", () => {
    const t = setup();
    expect(t.cookie("datagoat_visitor_id")).toBeDefined();
    t.api("consent", false);
    for (const name of [
      "datagoat_visitor_id",
      "datagoat_session_id",
      "datagoat_visitor_first_seen_at",
      "datagoat_visitor_session_count",
    ]) {
      expect(t.cookie(name)).toBeUndefined();
    }
    expect(t.cookie("datagoat_consent")).toBe("0");
    t.api("after_refusal");
    expect(t.last()).toMatchObject({ cookieless: true });
    expect(t.cookie("datagoat_visitor_id")).toBeUndefined();
    // And the refusal holds on the next load, even without data-require-consent.
    const next = setup({ before: (w) => restore(w, "datagoat_consent=0") });
    expect(next.last()).toMatchObject({ cookieless: true });
  });

  it("queued consent runs before the first pageview", () => {
    const t = setup({
      attrs: { "data-require-consent": "true" },
      before: (w) => {
        queueSnippet(w);
        (w.datafast as (...a: unknown[]) => void)("consent", true);
      },
    });
    expect(t.last()).not.toHaveProperty("cookieless");
    expect(t.types()).toEqual(["pageview"]);
  });

  it("warns on anything but true or false", () => {
    const t = setup();
    t.api("consent", "yes");
    expect(t.console.warn).toHaveBeenCalledWith("DataGoat: consent expects true or false");
  });
});

describe("engagement beacon (data-track-engagement)", () => {
  it("sends active time and the deepest scroll when the page is hidden", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setup({ attrs: { "data-track-engagement": "true" } });
    const d = t.win.document;
    vi.advanceTimersByTime(5000);
    t.win.dispatchEvent(new t.win.Event("pointerdown"));
    vi.advanceTimersByTime(120_000); // idle: counts at most 30 s
    Object.defineProperty(d, "visibilityState", { value: "hidden", configurable: true });
    d.dispatchEvent(new t.win.Event("visibilitychange"));
    expect(t.last()).toMatchObject({
      type: "engagement",
      extraData: { active_ms: 35_000, max_scroll: 0 },
    });
    expect(t.sent.at(-1)?.transport).toBe("beacon");
  });

  it("is off by default", () => {
    const t = setup();
    Object.defineProperty(t.win.document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    t.win.document.dispatchEvent(new t.win.Event("visibilitychange"));
    expect(t.types()).toEqual(["pageview"]);
  });
});

describe("helpers", () => {
  it("uuid() is a v4 UUID", () => {
    for (let i = 0; i < 20; i++) expect(uuid()).toMatch(UUID);
  });
  it("isLocalHost", () => {
    expect(isLocalHost("localhost")).toBe(true);
    expect(isLocalHost("example.com")).toBe(false);
    expect(isLocalHost("localhost.example.com")).toBe(false);
  });
  it("waits for a prerendered page to be shown", () => {
    const t = setup({
      before: (w) =>
        Object.defineProperty(w.document, "prerendering", { value: true, configurable: true }),
    });
    expect(t.sent).toEqual([]);
    t.win.document.dispatchEvent(new t.win.Event("prerenderingchange"));
    expect(t.types()).toEqual(["pageview"]);
  });
});
