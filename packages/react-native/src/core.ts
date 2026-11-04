/**
 * Platform-independent core of @datagoat/react-native. It speaks the collector's documented
 * request body (plan §3.4) to `POST /api/events`, with DataFast's identity semantics:
 *
 * - visitor id: UUID v4, created once and stored (AsyncStorage on devices);
 * - session id: `s` + UUID v4, new after 30 minutes without activity;
 * - first-seen time and session number, like the web tracker's cookies.
 *
 * Screens are pageviews with `href` = `datafast://<platform>/<Screen>` (DataFast's format, so
 * dashboards, filters and funnels treat app screens the same way). Events are written to a
 * persistent queue first and sent in order; network errors and 5xx/429 answers keep them for the
 * next flush, so nothing is lost offline. Other 4xx answers drop the event (it would never pass).
 *
 * The collector timestamps an event when it arrives, so events sent after a long offline period
 * are recorded at delivery time (the body has no client timestamp field).
 */

export const SDK_VERSION = "0.1.0";
export const SESSION_TIMEOUT_MS = 30 * 60_000;
const KEY_VISITOR = "datagoat:visitor";
const KEY_SESSION = "datagoat:session";
const KEY_QUEUE = "datagoat:queue";

export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface PlatformInfo {
  /** "ios", "android" (or "web", "macos", "windows"). */
  os: string;
  osVersion?: string;
  /** e.g. "iPhone16,1", "Pixel 9". */
  model?: string;
  screen: { width: number; height: number };
  window?: { width: number; height: number };
  /** BCP 47, e.g. "en-US". */
  locale?: string;
  /** IANA, e.g. "Europe/Berlin". */
  timeZone?: string;
}

export interface NetworkAdapter {
  isOnline(): Promise<boolean> | boolean;
  /** Call `onOnline` when connectivity comes back; returns an unsubscribe function. */
  subscribe?(onOnline: () => void): () => void;
}

export interface DataGoatConfig {
  /** The website's tracking id: use the same one as your website to link web and app visitors. */
  websiteId: string;
  /** The website's domain as configured in DataGoat (e.g. "example.com"). */
  domain: string;
  /** Origin of your DataGoat collector, e.g. https://a.example.com. */
  host: string;
  /** Full collector URL; default `<host>/api/events`. */
  apiUrl?: string;
  /** Scheme of screen URLs. Default "datafast" (`datafast://ios/HomeScreen`). */
  screenScheme?: string;
  /** Send at least every N ms while the app is open. Default 5000. */
  flushInterval?: number;
  /** Send as soon as this many events are queued. Default 10. */
  flushAt?: number;
  /** Oldest events are dropped beyond this many. Default 500. */
  maxStoredEvents?: number;
  /** Do not send anything (e.g. in development or before consent). */
  disabled?: boolean;
  debug?: boolean;
}

export interface Adapters {
  storage: StorageLike;
  platform: PlatformInfo;
  network?: NetworkAdapter;
  fetch?: typeof fetch;
  now?: () => number;
  uuid?: () => string;
  /** Override the User-Agent header (native platforms only). */
  userAgent?: string;
}

export type Params = Record<string, string | number | boolean | null | undefined>;

export interface EventBody {
  websiteId: string;
  domain: string;
  href: string;
  referrer: null;
  viewport: { width: number; height: number };
  visitorId: string;
  sessionId: string;
  visitorFirstSeenAt: string;
  visitorSessionNumber: number;
  language: string;
  timezone: string;
  screenWidth: number;
  screenHeight: number;
  type: "pageview" | "custom" | "identify";
  extraData?: Record<string, string>;
}

interface QueueItem {
  body: EventBody;
  attempts: number;
}

interface VisitorState {
  id: string;
  firstSeenAt: string;
  sessionCount: number;
}

interface SessionState {
  id: string;
  lastActivity: number;
}

const GOAL_RE = /^[a-z0-9_:-]{1,64}$/;
const PARAM_RE = /^[a-z0-9_-]{1,64}$/;

function defaultUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // RFC 4122 v4 from Math.random (React Native without a crypto polyfill).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** A browser-like User-Agent so the collector classifies the device and OS (and not as a bot). */
export function mobileUserAgent(p: PlatformInfo): string | undefined {
  const version = (p.osVersion ?? "").replace(/\./g, "_");
  if (p.os === "ios") {
    const device = /ipad/i.test(p.model ?? "") ? "iPad; CPU OS" : "iPhone; CPU iPhone OS";
    return `Mozilla/5.0 (${device} ${version || "18_0"} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 DataGoatReactNative/${SDK_VERSION}`;
  }
  if (p.os === "android") {
    const model = (p.model ?? "Mobile").replace(/[;()]/g, "");
    return `Mozilla/5.0 (Linux; Android ${p.osVersion ?? "15"}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 DataGoatReactNative/${SDK_VERSION}`;
  }
  return undefined;
}

/** "Home", "Settings/Profile" → "Settings/Profile"; strips slashes and encodes each segment. */
export function screenPath(name: string): string {
  return String(name)
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

function cleanParams(params: Params | undefined): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (!params) return out;
  for (const [rawKey, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    const key = rawKey.toLowerCase().replace(/-/g, "_");
    if (!PARAM_RE.test(key)) return null;
    out[key] = String(value).slice(0, 255);
  }
  return Object.keys(out).length > 10 ? null : out;
}

export class DataGoatClient {
  readonly config: Required<
    Pick<DataGoatConfig, "flushInterval" | "flushAt" | "maxStoredEvents" | "screenScheme">
  > &
    DataGoatConfig;
  readonly ready: Promise<void>;
  private readonly adapters: Required<Pick<Adapters, "now" | "uuid">> & Adapters;
  private readonly apiUrl: string;
  private readonly userAgent: string | undefined;
  private visitor: VisitorState | null = null;
  private session: SessionState | null = null;
  private queue: QueueItem[] = [];
  private currentHref: string;
  private lastScreenAt: number | null = null;
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: Array<() => void> = [];
  private disabled: boolean;

  constructor(config: DataGoatConfig, adapters: Adapters) {
    if (!config.websiteId) throw new Error("@datagoat/react-native: websiteId is required");
    if (!config.domain) throw new Error("@datagoat/react-native: domain is required");
    if (!config.host && !config.apiUrl) {
      throw new Error("@datagoat/react-native: host (your DataGoat origin) is required");
    }
    this.config = {
      flushInterval: 5000,
      flushAt: 10,
      maxStoredEvents: 500,
      screenScheme: "datafast",
      ...config,
    };
    this.adapters = { now: () => Date.now(), uuid: defaultUuid, ...adapters };
    this.apiUrl = config.apiUrl ?? `${config.host.replace(/\/+$/, "")}/api/events`;
    this.userAgent = adapters.userAgent ?? mobileUserAgent(adapters.platform);
    this.currentHref = `${this.config.screenScheme}://${adapters.platform.os}/`;
    this.disabled = config.disabled === true;
    this.ready = this.load();
  }

  private log(...args: unknown[]): void {
    if (this.config.debug) console.log("[datagoat]", ...args);
  }

  private async readJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.adapters.storage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  private async writeJson(key: string, value: unknown): Promise<void> {
    try {
      await this.adapters.storage.setItem(key, JSON.stringify(value));
    } catch (err) {
      this.log("storage write failed", err);
    }
  }

  private async load(): Promise<void> {
    const [visitor, session, queue] = await Promise.all([
      this.readJson<VisitorState>(KEY_VISITOR),
      this.readJson<SessionState>(KEY_SESSION),
      this.readJson<QueueItem[]>(KEY_QUEUE),
    ]);
    if (visitor?.id) this.visitor = visitor;
    if (session?.id) this.session = session;
    if (Array.isArray(queue)) this.queue = queue.filter((i) => i?.body?.websiteId);
  }

  /** Start periodic flushing and the network listener. Called by the provider. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.config.flushInterval);
    const sub = this.adapters.network?.subscribe?.(() => void this.flush());
    if (sub) this.unsubscribe.push(sub);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const fn of this.unsubscribe.splice(0)) fn();
  }

  /** Stop or resume sending (e.g. tracking consent). Queued events stay queued while disabled. */
  setEnabled(enabled: boolean): void {
    this.disabled = !enabled;
    if (enabled) void this.flush();
  }

  private ensureIdentity(now: number): { visitor: VisitorState; session: SessionState } {
    if (!this.visitor) {
      this.visitor = {
        id: this.adapters.uuid(),
        firstSeenAt: new Date(now).toISOString(),
        sessionCount: 0,
      };
    }
    if (!this.session || now - this.session.lastActivity > SESSION_TIMEOUT_MS) {
      this.visitor.sessionCount += 1;
      this.session = { id: `s${this.adapters.uuid()}`, lastActivity: now };
    }
    this.session.lastActivity = now;
    return { visitor: this.visitor, session: this.session };
  }

  private buildBody(
    type: EventBody["type"],
    href: string,
    extraData?: Record<string, string>,
  ): EventBody {
    const now = this.adapters.now();
    const { visitor, session } = this.ensureIdentity(now);
    const p = this.adapters.platform;
    const win = p.window ?? p.screen;
    const body: EventBody = {
      websiteId: this.config.websiteId,
      domain: this.config.domain,
      href,
      referrer: null,
      viewport: { width: Math.round(win.width), height: Math.round(win.height) },
      visitorId: visitor.id,
      sessionId: session.id,
      visitorFirstSeenAt: visitor.firstSeenAt,
      visitorSessionNumber: visitor.sessionCount,
      language: p.locale ?? "en-US",
      timezone: p.timeZone ?? "UTC",
      screenWidth: Math.round(p.screen.width),
      screenHeight: Math.round(p.screen.height),
      type,
    };
    if (extraData) body.extraData = extraData;
    return body;
  }

  private async enqueue(body: EventBody): Promise<void> {
    this.queue.push({ body, attempts: 0 });
    const overflow = this.queue.length - this.config.maxStoredEvents;
    if (overflow > 0) this.queue.splice(0, overflow);
    await Promise.all([
      this.writeJson(KEY_QUEUE, this.queue),
      this.writeJson(KEY_VISITOR, this.visitor),
      this.writeJson(KEY_SESSION, this.session),
    ]);
    if (this.queue.length >= this.config.flushAt) await this.flush();
  }

  /** A screen view: a pageview at `datafast://<platform>/<name>`. */
  async trackScreen(name: string): Promise<void> {
    await this.ready;
    const path = screenPath(name);
    if (!path) return this.log("trackScreen() needs a screen name");
    const href = `${this.config.screenScheme}://${this.adapters.platform.os}/${path}`;
    // Like the web tracker's 60-second same-URL dedup: the same screen reported again right after
    // itself (a remount, React StrictMode's double effects) is not a new view.
    if (href === this.currentHref && this.lastScreenAt !== null) {
      if (this.adapters.now() - this.lastScreenAt < 60_000) return;
    }
    this.lastScreenAt = this.adapters.now();
    this.currentHref = href;
    await this.enqueue(this.buildBody("pageview", href));
  }

  /** A custom goal (DataFast rules: lowercase a-z 0-9 _ - :, up to 64 characters, 10 params). */
  async track(goal: string, params?: Params): Promise<boolean> {
    await this.ready;
    const name = String(goal).trim().toLowerCase();
    if (!GOAL_RE.test(name) || name === "identify") {
      this.log(`invalid goal name "${goal}"`);
      return false;
    }
    const extra = cleanParams(params);
    if (!extra) {
      this.log("invalid goal parameters (names a-z 0-9 _ -, at most 10)");
      return false;
    }
    await this.enqueue(this.buildBody("custom", this.currentHref, { eventName: name, ...extra }));
    return true;
  }

  /**
   * Link this app visitor to your user. Use the same `user_id` as `window.datafast("identify")`
   * on your website: DataGoat merges both visitor profiles into one journey.
   */
  async identify(userId: string, profile: Params = {}): Promise<boolean> {
    await this.ready;
    const id = String(userId ?? "").trim();
    if (!id || id.length > 255) return false;
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(profile)) {
      if (v !== undefined && v !== null && v !== "" && k !== "user_id") {
        extra[k] = String(v).slice(0, 255);
      }
    }
    await this.enqueue(this.buildBody("identify", this.currentHref, { ...extra, user_id: id }));
    return true;
  }

  getVisitorId(): string | null {
    return this.visitor?.id ?? null;
  }

  getSessionId(): string | null {
    return this.session?.id ?? null;
  }

  queued(): number {
    return this.queue.length;
  }

  /** Forget the visitor and session (sign-out). Already queued events are still sent. */
  async reset(): Promise<void> {
    await this.ready;
    this.visitor = null;
    this.session = null;
    await Promise.all([
      this.adapters.storage.removeItem(KEY_VISITOR).catch(() => undefined),
      this.adapters.storage.removeItem(KEY_SESSION).catch(() => undefined),
    ]);
  }

  /** Send queued events in order. Concurrent calls share one run. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    await this.ready;
    if (this.disabled || this.queue.length === 0) return;
    if (this.adapters.network && !(await this.adapters.network.isOnline())) return;
    const doFetch = this.adapters.fetch ?? fetch;
    let changed = false;
    while (this.queue.length) {
      const item = this.queue[0] as QueueItem;
      let status = 0;
      try {
        const headers: Record<string, string> = { "Content-Type": "text/plain" };
        if (this.userAgent) headers["User-Agent"] = this.userAgent;
        const res = await doFetch(this.apiUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(item.body),
        });
        status = res.status;
      } catch (err) {
        this.log("send failed, will retry", err);
      }
      if (status >= 200 && status < 300) {
        this.queue.shift();
        changed = true;
        continue;
      }
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        this.log(`event dropped: HTTP ${status}`);
        this.queue.shift();
        changed = true;
        continue;
      }
      item.attempts += 1;
      changed = true;
      break;
    }
    if (changed) await this.writeJson(KEY_QUEUE, this.queue);
  }
}

/** In-memory storage (tests, or apps that do not want persistence). */
export function createMemoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
    removeItem: async (k) => {
      data.delete(k);
    },
  };
}
