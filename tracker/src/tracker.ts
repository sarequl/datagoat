/**
 * DataGoat tracker. Original code, MIT licensed.
 *
 * Its own names: `datagoat_*` cookies, `window.datagoat(...)`, `_dg_*` cross-domain parameters.
 * It also accepts DataFast's script tag (plan §3): the same attributes, `window.datafast(...)`
 * (always an alias), goal and scroll attributes, request body and payment success pages, and it
 * reads existing `datafast_*` cookies so returning visitors keep their id. With
 * `data-compat="datafast"` (sites switching from DataFast) it also writes the `datafast_*` cookies,
 * so checkout code that reads `datafast_visitor_id` keeps working.
 *
 * Three builds from this file (tracker/build.mjs sets __DG_COOKIELESS__ and __DG_HASH__):
 * - `default`    → script.js: first-party cookies.
 * - `cookieless` → script.cookieless.js: no cookies; sessionStorage only; the server derives the
 *                  visitor from a daily salt and returns it.
 * - `hash`       → script.hash.js: like default, and `#hash` routes count as pages.
 *
 * DataGoat extensions (all opt-in or invisible to DataFast users):
 * `datagoat("consent", true|false)`, `data-require-consent`, `data-track-engagement`, Paddle
 * success pages, sendBeacon/fetch transport, `SameSite=Lax` and `Secure` cookies.
 */
import { clean, goalName, type Params, params } from "./validate";

/** Build-time constants (tracker/build.mjs), so each build drops the other builds' code. */
declare const __DG_COOKIELESS__: boolean;
declare const __DG_HASH__: boolean;

/** Cookie names are `datagoat_<key>`; DataFast's `datafast_<key>` are read too (see top). */
const DG = "datagoat_";
const DF = "datafast_";
const VID = "visitor_id";
const SID = "session_id";
const VFS = "visitor_first_seen_at";
const VSN = "visitor_session_count";
const CONSENT = `${DG}consent`;
const PV_STATE = `${DG}pageview_state`;
/** Cross-domain link parameters: written as `_dg_*`, read as `_dg_*` or DataFast's `_df_*`. */
const XD = ["vid", "sid", "vfs", "vsn"];
const XD_PARAMS = [...XD.map((k) => `_dg_${k}`), ...XD.map((k) => `_df_${k}`)];
const CLICK_IDS = [
  "gclid",
  "gclsrc",
  "wbraid",
  "gbraid",
  "li_fat_id",
  "fbclid",
  "msclkid",
  "ttclid",
  "twclid",
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOT_UA =
  /headlesschrome|phantomjs|selenium|webdriver|puppeteer|playwright|python|curl|wget|java\/|go-http|node\.js|axios|postman/i;
const BOT_GLOBALS = [
  "callPhantom",
  "_phantom",
  "__nightmare",
  "__webdriver_evaluate",
  "__selenium_evaluate",
  "__webdriver_script_function",
  "__webdriver_unwrapped",
  "__fxdriver_evaluate",
  "__driver_evaluate",
  "_Selenium_IDE_Recorder",
  "_selenium",
  "calledSelenium",
  "$cdc_asdjflasutopfhvcZLmcfl_",
];

export type Api = ((command?: unknown, options?: unknown) => void) & {
  q?: ArrayLike<unknown>[];
  visitorId?: string;
  dg?: 1;
};

type TrackerWindow = Window & { datafast?: Api; datagoat?: Api } & Record<string, unknown>;
type Body = Record<string, unknown>;
type Ids = { visitorId?: string; sessionId?: string; compat?: string };

/** UUID v4 from getRandomValues (randomUUID needs a secure context; plain-http sites have none). */
export function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] as number) & 15) | 64;
  b[8] = ((b[8] as number) & 63) | 128;
  const x = Array.from(b, (v) => (v + 256).toString(16).slice(1)).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export function isLocalHost(host: string): boolean {
  return /^(localhost|127(\.\d+){3}|\[?::1\]?|0\.0\.0\.0)$|\.local(host)?$/.test(host);
}

export function init(w: TrackerWindow): Api | undefined {
  if (w.datafast?.dg) return w.datafast;
  const d = w.document;
  const n = w.navigator;
  const l = w.location;
  const h = w.history;
  const script = (d.currentScript ||
    d.querySelector("script[data-website-id]")) as HTMLScriptElement | null;
  const attr = (name: string) => script?.getAttribute(`data-${name}`) ?? null;
  const flag = (name: string) => attr(name) === "true";

  const websiteId = attr("website-id");
  const domainAttr = attr("domain") || l.hostname;
  const norm = (host: string) => host.toLowerCase().replace(/^www\./, "");
  const root = norm(domainAttr);
  const allowed = __DG_COOKIELESS__
    ? []
    : (attr("allowed-hostnames") || "")
        .split(",")
        .map((s) => norm(s.trim()))
        .filter(Boolean);
  const debug = flag("debug");
  const quiet = flag("disable-console");
  const host = norm(l.hostname);

  const log = (message: string, level: "log" | "warn" | "error" = "log") => {
    if (!quiet) console[level](`DataGoat: ${message}`);
  };

  let endpoint = "";
  const base = script?.src || l.href;
  try {
    const custom = attr("api-url");
    endpoint = new URL(custom || "/api/events", custom ? l.href : base).href;
  } catch {
    endpoint = new URL("/api/events", base).href;
  }

  // ---- storage --------------------------------------------------------------------------------
  const storage = (kind: "localStorage" | "sessionStorage"): Storage | null => {
    try {
      return w[kind];
    } catch {
      return null;
    }
  };
  const session = storage("sessionStorage");
  const sget = (key: string): string | null => {
    try {
      return session?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const sset = (key: string, value: string) => {
    try {
      session?.setItem(key, value);
    } catch {
      // storage full or blocked
    }
  };

  const within = (hostname: string, domain = root) =>
    hostname === domain || hostname.endsWith(`.${domain}`);
  const cookieDomain =
    isLocalHost(host) || /^[\d.]+$|:/.test(host) ? "" : within(host) ? root : host;
  const getCookie = (key: string): string | null => {
    const m = d.cookie.match(new RegExp(`(?:^|; )${key}=([^;]*)`));
    if (!m) return null;
    try {
      return decodeURIComponent(m[1] as string);
    } catch {
      return null;
    }
  };
  const setCookie = (key: string, value: string, days: number) => {
    d.cookie = `${key}=${encodeURIComponent(value)}; expires=${new Date(Date.now() + days * 864e5).toUTCString()}; path=/${
      cookieDomain ? `; domain=.${cookieDomain}` : ""
    }; SameSite=Lax${l.protocol === "https:" ? "; Secure" : ""}`;
  };
  // Identity cookies: ours first, then DataFast's (a visitor from before the switch keeps their id).
  // DataFast compatibility: from data-compat="datafast", or learned from the server (which turns it
  // on for a site once any browser reports DataFast's cookie) and remembered in localStorage.
  const COMPAT_KEY = `${DG}compat`;
  const remembered = () => {
    try {
      return w.localStorage.getItem(COMPAT_KEY) === "datafast";
    } catch {
      return false;
    }
  };
  let compat = !__DG_COOKIELESS__ && (attr("compat") === "datafast" || remembered());
  /** The browser had DataFast's cookie before we touched anything: the site came from DataFast. */
  const fromDatafast = !__DG_COOKIELESS__ && !compat && getCookie(`${DF}visitor_id`) !== null;
  /** Ask the server about compatibility once per tab session (or while DataFast's cookie is here). */
  const CHECKED_KEY = `${DG}compat_checked`;
  const shouldAsk = () => !compat && (fromDatafast || !sget(CHECKED_KEY));
  const getId = (key: string) => getCookie(DG + key) || getCookie(DF + key);
  const setId = (key: string, value: string, days: number) => {
    setCookie(DG + key, value, days);
    if (compat) setCookie(DF + key, value, days);
  };

  // Consent: cookies only when not required, or after datagoat("consent", true).
  let cookies = false;
  if (!__DG_COOKIELESS__) {
    const consent = getCookie(CONSENT);
    cookies = consent === "1" || (consent !== "0" && !flag("require-consent"));
  }

  // ---- gating ---------------------------------------------------------------------------------
  const isBot = (): boolean => {
    const ua = n.userAgent || "";
    if (n.webdriver === true || ua.length < 5 || BOT_UA.test(ua)) return true;
    for (const g of BOT_GLOBALS) if (g in w || g in d) return true;
    const html = d.documentElement;
    return ["webdriver", "selenium", "driver"].some((a) => html.hasAttribute(a));
  };
  let disabled = "";
  let ignored = false;
  try {
    const local = storage("localStorage");
    ignored = [DG, DF].some((p) => local?.getItem(`${p}ignore`) === "true");
  } catch {
    // blocked storage: not ignored
  }
  if (!websiteId) disabled = "missing data-website-id";
  else if (ignored) disabled = "datagoat_ignore is set";
  else if (isBot()) disabled = "bot detected";
  else if (l.protocol === "file:" && !flag("allow-file-protocol")) disabled = "file protocol";
  else if (isLocalHost(host) && !flag("allow-localhost")) disabled = "localhost";
  else if (w !== w.parent && !debug) disabled = "inside an iframe";

  // ---- identity -------------------------------------------------------------------------------
  const memory: Ids = {};
  const exposed = (id: string | undefined) => {
    if (id) api.visitorId = id;
  };

  const cookieIds = () => {
    let visitorId = getId(VID) || memory.visitorId;
    if (!visitorId) {
      visitorId = uuid();
      setId(VFS, new Date().toISOString(), 365);
      setId(VSN, "0", 365);
    }
    let sessionId = getId(SID) || memory.sessionId;
    if (!sessionId) {
      sessionId = `s${uuid()}`;
      setId(VSN, String(Math.min((Number(getId(VSN)) || 0) + 1, 1e6)), 365);
    }
    memory.visitorId = visitorId;
    memory.sessionId = sessionId;
    setId(VID, visitorId, 365);
    setId(SID, sessionId, 1 / 48); // 30 minutes, sliding
    exposed(visitorId);
    return {
      visitorId,
      sessionId,
      visitorFirstSeenAt: getId(VFS) || new Date().toISOString(),
      visitorSessionNumber: Number(getId(VSN)) || 1,
    };
  };

  /** Cookieless ids: the server's, from the last response, kept for this tab only. */
  const tabIds = () => {
    let sessionId = sget(DG + SID);
    if (!sessionId) {
      sessionId = `s${uuid()}`;
      sset(DG + SID, sessionId);
    }
    return { visitorId: sget(DG + VID) || uuid(), sessionId };
  };

  const learn = (res: Ids) => {
    if (res.visitorId) sset(DG + VID, res.visitorId);
    if (res.sessionId) sset(DG + SID, res.sessionId);
    exposed(res.visitorId);
  };

  /** The server says this site runs in DataFast compatibility: mirror our ids into datafast_*. */
  const adoptCompat = (res: Ids) => {
    if (res.compat !== "datafast" || compat) return;
    compat = true;
    try {
      w.localStorage.setItem(COMPAT_KEY, "datafast");
    } catch {
      // storage blocked: the next pageview asks again
    }
    for (const [key, days] of [
      [VID, 365],
      [SID, 1 / 48],
      [VFS, 365],
      [VSN, 365],
    ] as const) {
      const value = getCookie(DG + key);
      if (value) setCookie(DF + key, value, days);
    }
  };

  // ---- transport ------------------------------------------------------------------------------
  const send = (body: Body, onResponse?: (res: Ids) => void) => {
    const data = JSON.stringify(body);
    if (debug) log(`sending ${body.type}`);
    if (!onResponse && n.sendBeacon) {
      try {
        if (n.sendBeacon(endpoint, data)) return;
      } catch {
        // fall through
      }
    }
    if (w.fetch) {
      w.fetch(endpoint, {
        method: "POST",
        body: data,
        keepalive: true,
        headers: { "Content-Type": "text/plain" },
      })
        .then((r) => (r.ok && onResponse ? r.json() : null))
        .then((res) => res && onResponse?.(res))
        .catch(() => {});
      return;
    }
    const x = new XMLHttpRequest();
    x.open("POST", endpoint, true);
    x.setRequestHeader("Content-Type", "text/plain");
    x.onload = () => {
      try {
        if (x.status === 200 && onResponse) onResponse(JSON.parse(x.responseText));
      } catch {
        // ignore
      }
    };
    x.send(data);
  };

  const timezone = () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  };

  const track = (type: string, extraData?: Body) => {
    const what = type === "custom" ? `Event '${extraData?.eventName}'` : `Event '${type}'`;
    if (disabled) return log(`${what} ignored - Tracking disabled - ${disabled}`);
    if (isBot()) return log(`${what} ignored - bot detected`);
    const cookieless = __DG_COOKIELESS__ || !cookies;
    const body: Body = {
      websiteId,
      domain: domainAttr,
      href: l.href,
      referrer: d.referrer || null,
      viewport: { width: w.innerWidth, height: w.innerHeight },
      ...(cookieless ? tabIds() : cookieIds()),
    };
    const query = new URLSearchParams(l.search);
    const clickIds: Record<string, string> = {};
    for (const key of CLICK_IDS) {
      const v = query.get(key);
      if (v) clickIds[key] = v;
    }
    if (Object.keys(clickIds).length) body.adClickIds = clickIds;
    body.language = n.language;
    body.timezone = timezone();
    body.screenWidth = w.screen.width;
    body.screenHeight = w.screen.height;
    body.type = type;
    if (__DG_HASH__) body.trackHash = true;
    if (cookieless) body.cookieless = true;
    if (extraData) body.extraData = extraData;
    if (fromDatafast) body.datafastCookie = true;
    // Pageviews read the reply until compatibility is known; other events stay fire-and-forget.
    const ask = !cookieless && type === "pageview" && shouldAsk();
    if (ask) sset(CHECKED_KEY, "1");
    send(body, cookieless ? learn : ask ? adoptCompat : undefined);
  };

  // ---- events ---------------------------------------------------------------------------------
  const goal = (name: unknown, input?: unknown) => {
    const eventName = goalName(name);
    if (!eventName) return log(`Invalid goal name "${String(name)}"`, "error");
    const p = params(input);
    if (typeof p === "string") return log(`Goal '${eventName}' rejected: ${p}`, "error");
    track("custom", { eventName, ...p });
  };

  const identify = (input: unknown) => {
    const p = (input || {}) as Record<string, unknown>;
    if (!p.user_id) return log("identify requires user_id", "warn");
    const extra: Body = { user_id: String(p.user_id), name: p.name || "", image: p.image || "" };
    for (const key in p) if (!(key in extra)) extra[key] = p[key];
    track("identify", extra);
  };

  const sentKey = (provider: string, id: string) => `${DG}${provider}_payment_sent_${id}`;
  const payment = (provider: string, key: string, id: string) => {
    if (!disabled && sget(sentKey(provider, id))) return log("Payment already sent");
    if (!disabled) sset(sentKey(provider, id), "true");
    track("payment", { [key]: id });
  };

  /** Stripe, Polar, Lemon Squeezy and Paddle success-page references in the URL. */
  const detectPayments = () => {
    if (flag("disable-payments")) return;
    const q = new URLSearchParams(l.search);
    const stripe = q.get("session_id");
    const polar = q.get("checkout_id");
    const lemon = q.get("order_id");
    const paddle = q.get("paddle_transaction_id") || q.get("transaction_id");
    if (stripe?.startsWith("cs_")) payment("stripe", "stripe_session_id", stripe);
    if (polar) payment("polar", "polar_checkout_id", polar);
    if (lemon) payment("lemonsqueezy", "lemonsqueezy_order_id", lemon);
    if (paddle?.startsWith("txn_")) payment("paddle", "paddle_transaction_id", paddle);
  };

  const consent = (granted: unknown) => {
    if (__DG_COOKIELESS__) return;
    if (granted === true) {
      setCookie(CONSENT, "1", 365);
      if (!cookies) {
        // Continue the visitor and session the server already knows (cookieless until now).
        const visitorId = sget(DG + VID);
        const sessionId = sget(DG + SID);
        if (visitorId && UUID_RE.test(visitorId)) {
          memory.visitorId = visitorId;
          setId(VID, visitorId, 365);
          setId(VFS, new Date().toISOString(), 365);
          setId(VSN, "1", 365);
          if (sessionId) {
            memory.sessionId = sessionId;
            setId(SID, sessionId, 1 / 48);
          }
        }
      }
      cookies = true;
    } else if (granted === false) {
      for (const key of [VID, SID, VFS, VSN]) for (const p of [DG, DF]) setCookie(p + key, "", -1);
      setCookie(CONSENT, "0", 365);
      memory.visitorId = memory.sessionId = undefined;
      cookies = false;
    } else log("consent expects true or false", "warn");
  };

  const api: Api = (command, options) => {
    if (typeof command !== "string" || !command) return log("Missing event name", "warn");
    if (command === "consent") return consent(options);
    if (command === "identify") return identify(options);
    if (command === "payment") {
      const email = (options as { email?: unknown } | undefined)?.email;
      if (!email) return log("payment requires email", "warn");
      return track("payment", { email: String(email) });
    }
    goal(command, options);
  };
  api.dg = 1;

  const queued = [
    ...(w.datafast?.q || []),
    ...(w.datagoat !== w.datafast ? w.datagoat?.q || [] : []),
  ];
  w.datafast = w.datagoat = api;
  const run = (args: ArrayLike<unknown>) => api(args[0], args[1]);
  const isConsent = (args: ArrayLike<unknown>) => args[0] === "consent";

  if (disabled) {
    log(`Tracking disabled - ${disabled}`, "warn");
    queued.forEach(run);
    return api;
  }

  // ---- pageviews ------------------------------------------------------------------------------
  const pageview = () => {
    const now = Date.now();
    const href = l.href;
    let last: { time?: number; url?: string } | null = null;
    try {
      last = JSON.parse(sget(PV_STATE) || "null");
    } catch {
      // corrupt state
    }
    if (last && last.url === href && now - (last.time || 0) < 6e4) {
      log("Pageview ignored - throttled (same URL within 1 minute)");
    } else {
      sset(PV_STATE, JSON.stringify({ time: now, url: href }));
      track("pageview");
    }
    detectPayments();
    scanScroll();
  };

  // ---- scroll goals ---------------------------------------------------------------------------
  const observed = new WeakSet<Element>();
  const scrollPercent = () => {
    const el = d.documentElement;
    const total = Math.max(el.scrollHeight, d.body?.scrollHeight || 0);
    return total ? Math.min(100, Math.round(((w.scrollY + w.innerHeight) / total) * 100)) : 0;
  };
  const prefixed = (el: Element, prefix: string, skip: string[] = []) => {
    const out: Params = {};
    for (const a of Array.from(el.attributes)) {
      const key = a.name.slice(prefix.length);
      if (a.name.startsWith(prefix) && key && !skip.includes(key)) {
        out[key.replace(/-/g, "_")] = a.value;
      }
    }
    return out;
  };
  const scanScroll = () => {
    const IO = w.IntersectionObserver as typeof IntersectionObserver | undefined;
    if (!IO) return;
    for (const el of Array.from(d.querySelectorAll("[data-fast-scroll]"))) {
      if (observed.has(el)) continue;
      observed.add(el);
      const t = Number.parseFloat(el.getAttribute("data-fast-scroll-threshold") || "");
      const threshold = t >= 0 && t <= 1 ? t : 0.5;
      const delay = Math.max(
        0,
        Number.parseInt(el.getAttribute("data-fast-scroll-delay") || "", 10) || 0,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const io = new IO(
        (entries) => {
          const e = entries[entries.length - 1];
          if (e?.isIntersecting && e.intersectionRatio >= threshold) {
            timer ??= setTimeout(() => {
              io.disconnect();
              goal(el.getAttribute("data-fast-scroll"), {
                scroll_percentage: scrollPercent(),
                threshold,
                delay,
                ...prefixed(el, "data-fast-scroll-", ["threshold", "delay"]),
              });
            }, delay);
          } else {
            clearTimeout(timer);
            timer = undefined;
          }
        },
        { threshold },
      );
      io.observe(el);
    }
  };

  // ---- clicks: declarative goals, outbound links, cross-domain linking -----------------------
  const decorate = (a: HTMLAnchorElement, url: URL) => {
    if (__DG_COOKIELESS__ || !cookies) return;
    const target = norm(url.hostname);
    const ours = within(target) || allowed.some((x) => within(target, x));
    if (!ours || target === host || (within(target) && within(host))) return;
    const ids = cookieIds();
    const values = [ids.visitorId, ids.sessionId, ids.visitorFirstSeenAt, ids.visitorSessionNumber];
    for (let i = 0; i < 4; i++) url.searchParams.set(XD_PARAMS[i] as string, String(values[i]));
    a.href = url.href;
  };

  const onClick = (e: Event) => {
    const target = e.target as Element | null;
    if (!target?.closest) return;
    if (e.type === "click") {
      const g = target.closest("[data-fast-goal]");
      if (g) goal(g.getAttribute("data-fast-goal"), prefixed(g, "data-fast-goal-"));
    }
    const a = target.closest("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    let url: URL;
    try {
      url = new URL(a.href, l.href);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol)) return;
    const to = norm(url.hostname);
    const opens = e.type === "click" || (e.type === "auxclick" && (e as MouseEvent).button === 1);
    if (opens && to !== host && !(within(to) && within(host))) {
      const link = new URL(url.href);
      for (const k of XD_PARAMS) link.searchParams.delete(k);
      track("external_link", { url: link.href, text: clean(a.textContent || "") });
    }
    decorate(a, url);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const target = e.target as Element | null;
    // Native controls turn Enter/Space into a click, which is tracked already.
    if (!target?.closest || /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(target.tagName))
      return;
    const g = target.closest("[data-fast-goal]");
    if (g) goal(g.getAttribute("data-fast-goal"), prefixed(g, "data-fast-goal-"));
  };

  // ---- engagement (opt-in) --------------------------------------------------------------------
  const engagement = () => {
    let active = 0;
    let mark = Date.now();
    let depth = 0;
    const tick = () => {
      const now = Date.now();
      if (d.visibilityState === "visible") active += Math.min(now - mark, 3e4);
      mark = now;
    };
    const onScroll = () => {
      tick();
      depth = Math.max(depth, scrollPercent());
    };
    for (const type of ["pointerdown", "keydown", "mousemove", "touchstart"]) {
      w.addEventListener(type, tick, { passive: true });
    }
    w.addEventListener("scroll", onScroll, { passive: true });
    d.addEventListener("visibilitychange", () => {
      if (d.visibilityState === "visible") {
        mark = Date.now();
        return;
      }
      active += Math.min(Date.now() - mark, 3e4);
      if (active > 0 || depth > 0) {
        track("engagement", { active_ms: Math.round(active), max_scroll: depth });
      }
      active = 0;
    });
  };

  // ---- start ----------------------------------------------------------------------------------
  const start = () => {
    queued.filter(isConsent).forEach(run);

    if (!__DG_COOKIELESS__) {
      // Cross-domain arrival: adopt the ids from the link, then clean the address bar.
      const q = new URLSearchParams(l.search);
      const pre = q.has("_dg_vid") ? "_dg_" : "_df_";
      const vid = q.get(`${pre}vid`);
      if (vid !== null) {
        const sid = q.get(`${pre}sid`);
        if (cookies && UUID_RE.test(vid)) {
          setId(VID, vid, 365);
          if (sid && /^s[0-9a-f-]{36}$/i.test(sid)) setId(SID, sid, 1 / 48);
          const fs = q.get(`${pre}vfs`);
          if (fs && !Number.isNaN(Date.parse(fs))) setId(VFS, fs, 365);
          const sn = Number(q.get(`${pre}vsn`));
          if (sn >= 1) setId(VSN, String(Math.min(sn, 1e6)), 365);
        }
        for (const k of XD_PARAMS) q.delete(k);
        const search = q.toString();
        try {
          h.replaceState(h.state, "", `${l.pathname}${search ? `?${search}` : ""}${l.hash}`);
        } catch {
          // sandboxed
        }
      }
    }

    pageview();
    queued.filter((args) => !isConsent(args)).forEach(run);

    for (const type of ["click", "auxclick", "mousedown"]) d.addEventListener(type, onClick, true);
    d.addEventListener("keydown", onKey, true);
    if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", scanScroll);
    if (flag("track-engagement")) engagement();

    // SPA navigation: pathname changes (and hash changes for the hash build), 100 ms debounce.
    const key = () => (__DG_HASH__ ? l.pathname + l.hash : l.pathname);
    let current = key();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const navigate = () => {
      if (key() === current) return;
      current = key();
      clearTimeout(timer);
      timer = setTimeout(pageview, 100);
    };
    const wrap = (method: "pushState" | "replaceState") => {
      const original = h[method];
      h[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        original.apply(this, args);
        navigate();
      };
    };
    wrap("pushState");
    w.addEventListener("popstate", navigate);
    if (__DG_HASH__) {
      wrap("replaceState");
      w.addEventListener("hashchange", navigate);
    }
  };

  // Prerendered pages start counting only once the visitor actually sees them.
  if ((d as Document & { prerendering?: boolean }).prerendering) {
    d.addEventListener("prerenderingchange", start, { once: true });
  } else start();
  return api;
}
