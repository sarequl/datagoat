/**
 * @datagoat/sdk: typed ESM wrapper around the DataGoat tracker's public API.
 *
 * `init()` adds the tracker `<script>` with the documented data-* attributes (plan §3.1) and a
 * pre-load queue at `window.datafast.q`, exactly like a hand-written script tag. Every other call
 * goes through `window.datafast(...)` (plan §3.3), so the SDK works the same with the DataGoat
 * tracker and with DataFast's script, and calls made before the script loads are queued.
 * Pageviews, SPA route changes, outbound clicks and cross-domain links are the tracker's job.
 *
 * All functions are safe to import during server rendering: without `window` they do nothing.
 */
import {
  FIRST_SEEN_COOKIE,
  IGNORE_KEY,
  parseCookieHeader,
  SESSION_COOKIE,
  SESSION_COUNT_COOKIE,
  VISITOR_COOKIE,
} from "./cookies.js";
import {
  type GoalParams,
  isSessionId,
  isVisitorId,
  normalizeGoalName,
  normalizeParams,
} from "./rules.js";

export type { GoalParams, ParamValue } from "./rules.js";
export { isSessionId, isVisitorId, normalizeGoalName, normalizeParams } from "./rules.js";

export type TrackerVariant = "default" | "cookieless" | "hash";

export interface DataGoatOptions {
  /** `data-website-id`: the website's tracking id from DataGoat (e.g. `dfid_...`). */
  websiteId: string;
  /** `data-domain`: your root domain. Default: the page's hostname without `www.`. */
  domain?: string;
  /**
   * Origin of your DataGoat collector, e.g. `https://a.example.com`. Default: the page's own
   * origin, for setups that proxy `/js/script.js` and `/api/events` through your site.
   */
  host?: string;
  /** Full tracker URL; overrides `host` and `variant`. */
  scriptUrl?: string;
  /** `data-api-url`. Default: `<host>/api/events` when `host` is set, otherwise the tracker's default. */
  apiUrl?: string;
  /** `script.js`, `script.cookieless.js` or `script.hash.js`. Default `default`. */
  variant?: TrackerVariant;
  /** `data-allowed-hostnames`: other domains for cross-domain linking. */
  allowedHostnames?: string[];
  allowLocalhost?: boolean;
  allowFileProtocol?: boolean;
  debug?: boolean;
  disableConsole?: boolean;
  disablePayments?: boolean;
  /** CSP nonce for the injected script. */
  nonce?: string;
}

export interface IdentifyProfile {
  name?: string;
  image?: string;
  [key: string]: string | number | boolean | null | undefined;
}

export interface TrackingParams {
  _df_vid?: string;
  _df_sid?: string;
}

/** The tracker's global function (`window.datafast`, aliased `window.datagoat`). */
export type TrackerFunction = ((...args: unknown[]) => void) & {
  q?: unknown[][];
  /** Set by the cookieless tracker. */
  visitorId?: string;
};

type TrackerWindow = Window & { datafast?: TrackerFunction; datagoat?: TrackerFunction };

const SCRIPT_FILES: Record<TrackerVariant, string> = {
  default: "script.js",
  cookieless: "script.cookieless.js",
  hash: "script.hash.js",
};

function win(): TrackerWindow | null {
  return typeof window === "undefined" ? null : (window as TrackerWindow);
}

let debugEnabled = false;
function warn(message: string): void {
  if (debugEnabled && typeof console !== "undefined") console.warn(`[datagoat] ${message}`);
}

/** Install the documented pre-load queue so calls made before the script loads are kept. */
export function installQueue(): TrackerFunction | null {
  const w = win();
  if (!w) return null;
  if (w.datafast) return w.datafast;
  const queue = ((...args: unknown[]) => {
    queue.q = queue.q ?? [];
    queue.q.push(args);
  }) as TrackerFunction;
  queue.q = [];
  w.datafast = queue;
  return queue;
}

function call(...args: unknown[]): boolean {
  const fn = installQueue();
  if (!fn) return false;
  fn(...args);
  return true;
}

/** Build the tracker `<script>` attributes for `options` (also used by the React/Next helpers). */
export function scriptAttributes(options: DataGoatOptions): Record<string, string> {
  if (!options.websiteId) throw new Error("@datagoat/sdk: websiteId is required");
  const host = options.host?.replace(/\/+$/, "") ?? "";
  const attrs: Record<string, string> = {
    src: options.scriptUrl ?? `${host}/js/${SCRIPT_FILES[options.variant ?? "default"]}`,
    "data-website-id": options.websiteId,
  };
  if (options.domain) attrs["data-domain"] = options.domain;
  const apiUrl = options.apiUrl ?? (host ? `${host}/api/events` : undefined);
  if (apiUrl) attrs["data-api-url"] = apiUrl;
  if (options.allowedHostnames?.length) {
    attrs["data-allowed-hostnames"] = options.allowedHostnames.join(",");
  }
  if (options.allowLocalhost) attrs["data-allow-localhost"] = "true";
  if (options.allowFileProtocol) attrs["data-allow-file-protocol"] = "true";
  if (options.debug) attrs["data-debug"] = "true";
  if (options.disableConsole) attrs["data-disable-console"] = "true";
  if (options.disablePayments) attrs["data-disable-payments"] = "true";
  return attrs;
}

export interface DataGoatClient {
  readonly websiteId: string;
  /** Resolves when the tracker script has loaded (rejects if it fails to load). */
  readonly ready: Promise<void>;
  track(goal: string, params?: GoalParams): boolean;
  identify(userId: string, profile?: IdentifyProfile): boolean;
  payment(email: string): boolean;
  consent(granted: boolean): boolean;
  getVisitorId(): string | null;
  getSessionId(): string | null;
  getTrackingParams(): TrackingParams;
  buildCrossDomainUrl(url: string): string;
  optOut(): void;
  optIn(): void;
}

let client: DataGoatClient | null = null;

/** Send a custom goal: `window.datafast(goal, params)`. Returns false when it was rejected. */
export function track(goal: string, params?: GoalParams): boolean {
  const name = normalizeGoalName(goal);
  if (!name.ok) {
    warn(name.error);
    return false;
  }
  const props = normalizeParams(params);
  if (!props.ok) {
    warn(props.error);
    return false;
  }
  return Object.keys(props.value).length ? call(name.value, props.value) : call(name.value);
}

/** Link this visitor to your user: `window.datafast("identify", {user_id, ...})`. */
export function identify(userId: string, profile: IdentifyProfile = {}): boolean {
  const id = String(userId ?? "").trim();
  if (!id || id.length > 255) {
    warn("identify() needs a user id of 1 to 255 characters");
    return false;
  }
  const extra: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(profile)) {
    if (v !== undefined && v !== null && k !== "user_id") extra[k] = v;
  }
  return call("identify", { ...extra, user_id: id });
}

/** Report a payment by customer email (success pages): `window.datafast("payment", {email})`. */
export function payment(email: string): boolean {
  if (!email?.includes("@")) {
    warn("payment() needs the customer's email");
    return false;
  }
  return call("payment", { email: email.trim() });
}

/** Consent mode (DataGoat extension): `true` switches to cookies, `false` deletes them. */
export function consent(granted: boolean): boolean {
  return call("consent", granted === true);
}

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  return parseCookieHeader(document.cookie)[name];
}

/** The visitor id: the `datafast_visitor_id` cookie, or the cookieless tracker's id. */
export function getVisitorId(): string | null {
  const fromCookie = readCookie(VISITOR_COOKIE);
  if (isVisitorId(fromCookie)) return fromCookie;
  const w = win();
  const cookieless = w?.datafast?.visitorId ?? w?.datagoat?.visitorId;
  return typeof cookieless === "string" && cookieless ? cookieless : null;
}

export function getSessionId(): string | null {
  const value = readCookie(SESSION_COOKIE);
  return isSessionId(value) ? value : null;
}

/** Cross-domain parameters (`_df_vid`, `_df_sid`, `_df_vfs`, `_df_vsn`) for a link to another of your domains. */
export function getTrackingParams(): TrackingParams & { _df_vfs?: string; _df_vsn?: string } {
  const out: TrackingParams & { _df_vfs?: string; _df_vsn?: string } = {};
  const vid = getVisitorId();
  const sid = getSessionId();
  if (vid) out._df_vid = vid;
  if (sid) out._df_sid = sid;
  const vfs = readCookie(FIRST_SEEN_COOKIE);
  const vsn = readCookie(SESSION_COUNT_COOKIE);
  if (vid && vfs) out._df_vfs = vfs;
  if (vid && vsn && /^\d+$/.test(vsn)) out._df_vsn = vsn;
  return out;
}

export function buildCrossDomainUrl(url: string): string {
  const base = win()?.location?.href ?? "http://localhost/";
  const target = new URL(url, base);
  for (const [k, v] of Object.entries(getTrackingParams())) {
    if (v) target.searchParams.set(k, v);
  }
  return target.toString();
}

/** Stop tracking this browser (sets `localStorage.datafast_ignore = "true"`). */
export function optOut(): void {
  try {
    win()?.localStorage.setItem(IGNORE_KEY, "true");
  } catch {
    // storage blocked: nothing to do
  }
}

export function optIn(): void {
  try {
    win()?.localStorage.removeItem(IGNORE_KEY);
  } catch {
    // storage blocked: nothing to do
  }
}

function loadScript(options: DataGoatOptions): Promise<void> {
  const w = win();
  if (!w || typeof document === "undefined") return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>("script[data-website-id]");
  if (existing) {
    const id = existing.getAttribute("data-website-id");
    if (id !== options.websiteId) {
      warn(`A tracker for ${id} is already on the page; not adding another one`);
    }
    return Promise.resolve();
  }
  const el = document.createElement("script");
  el.defer = true;
  for (const [name, value] of Object.entries(scriptAttributes(options))) {
    el.setAttribute(name, value);
  }
  if (options.nonce) el.nonce = options.nonce;
  const ready = new Promise<void>((resolve, reject) => {
    el.addEventListener("load", () => resolve());
    el.addEventListener("error", () =>
      reject(new Error(`@datagoat/sdk: could not load ${el.getAttribute("src")}`)),
    );
  });
  (document.head ?? document.documentElement).appendChild(el);
  return ready;
}

/**
 * Add the tracker to the page (once) and return the client. Safe to call during server rendering
 * (returns a client whose calls do nothing until it runs in a browser).
 */
export function init(options: DataGoatOptions): DataGoatClient {
  debugEnabled = options.debug === true;
  if (client) {
    if (client.websiteId !== options.websiteId) {
      warn(`init() already ran for ${client.websiteId}; ignoring ${options.websiteId}`);
    }
    return client;
  }
  installQueue();
  const ready = loadScript(options);
  // Callers that never await `ready` must not see an unhandled rejection.
  ready.catch((err: unknown) => warn(String((err as Error).message)));
  const created: DataGoatClient = {
    websiteId: options.websiteId,
    ready,
    track,
    identify,
    payment,
    consent,
    getVisitorId,
    getSessionId,
    getTrackingParams,
    buildCrossDomainUrl,
    optOut,
    optIn,
  };
  if (win()) client = created;
  return created;
}

/** The client created by `init()`, or null before. */
export function getClient(): DataGoatClient | null {
  return client;
}

/** Test helper: forget the singleton. */
export function _resetForTests(): void {
  client = null;
  debugEnabled = false;
}
