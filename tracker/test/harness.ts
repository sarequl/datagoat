/**
 * A fresh happy-dom window per test with the tracker's script tag, a recording transport
 * (sendBeacon, fetch) and a controllable IntersectionObserver. `navigator.webdriver` is true in
 * happy-dom, so the harness turns it off like a real browser unless a test asks otherwise.
 */
import { Window } from "happy-dom";
import { vi } from "vitest";
import { type Api, init } from "../src/tracker";

/**
 * happy-dom's Window and the DOM lib's Window are different types; tests use the window
 * loosely, the way page scripts do.
 */
// biome-ignore lint/suspicious/noExplicitAny: test windows are used like untyped page globals
export type TestWindow = any;

export interface Sent {
  transport: "beacon" | "fetch" | "xhr";
  url: string;
  body: Record<string, unknown>;
  init?: RequestInit;
}

export interface Harness {
  win: TestWindow;
  w: TestWindow;
  api: Api;
  sent: Sent[];
  bodies: () => Record<string, unknown>[];
  types: () => string[];
  last: () => Record<string, unknown>;
  observers: FakeObserver[];
  cookie: (name: string) => string | undefined;
  console: {
    log: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  flush: () => Promise<void>;
}

export class FakeObserver {
  elements: Element[] = [];
  disconnected = false;
  constructor(
    public callback: (entries: Partial<IntersectionObserverEntry>[]) => void,
    public options: IntersectionObserverInit,
  ) {}
  observe(el: Element) {
    this.elements.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  /** Simulate the element's visible ratio changing. */
  ratio(intersectionRatio: number) {
    this.callback([
      { isIntersecting: intersectionRatio > 0, intersectionRatio, target: this.elements[0] },
    ]);
  }
}

export interface SetupOptions {
  url?: string;
  attrs?: Record<string, string>;
  /** Extra markup for the body. */
  html?: string;
  /** Runs before the tracker initialises (cookies, storage, queue, globals). */
  before?: (w: TestWindow) => void;
  /** Response JSON for fetch/XHR (cookieless ids). */
  response?: Record<string, unknown>;
  beacon?: boolean;
  fetch?: boolean;
  webdriver?: boolean;
  userAgent?: string;
  /** Don't call init (tests that need to set things up after the window exists). */
  manual?: boolean;
  src?: string;
}

export function setup(options: SetupOptions = {}): Harness {
  const win = new Window({
    url: options.url ?? "https://www.example.com/",
    settings: {
      navigator: {
        userAgent:
          options.userAgent ??
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      },
    },
  });
  const w: TestWindow = win;
  const sent: Sent[] = [];
  const nav = win.navigator as unknown as Record<string, unknown>;
  Object.defineProperty(nav, "webdriver", {
    value: options.webdriver ?? false,
    configurable: true,
  });
  Object.defineProperty(nav, "sendBeacon", {
    configurable: true,
    value:
      options.beacon === false
        ? undefined
        : (url: string, data: string) => {
            sent.push({ transport: "beacon", url, body: JSON.parse(data) });
            return true;
          },
  });
  w.fetch =
    options.fetch === false
      ? undefined
      : vi.fn(async (url: string, init: RequestInit) => {
          sent.push({ transport: "fetch", url, body: JSON.parse(String(init.body)), init });
          return { ok: true, json: async () => options.response ?? {} };
        });
  const observers: FakeObserver[] = [];
  w.IntersectionObserver = class extends FakeObserver {
    constructor(cb: FakeObserver["callback"], opts: IntersectionObserverInit) {
      super(cb, opts);
      observers.push(this);
    }
  };
  const fakeConsole = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  vi.spyOn(console, "log").mockImplementation(fakeConsole.log);
  vi.spyOn(console, "warn").mockImplementation(fakeConsole.warn);
  vi.spyOn(console, "error").mockImplementation(fakeConsole.error);

  const d = win.document;
  if (options.html) d.body.innerHTML = options.html;
  const script = d.createElement("script");
  for (const [k, v] of Object.entries({
    "data-website-id": "dfid_test",
    "data-domain": "example.com",
    ...options.attrs,
  })) {
    script.setAttribute(k, v);
  }
  if (options.src) script.setAttribute("src", options.src);
  d.head.appendChild(script);
  options.before?.(w);

  const harness: Harness = {
    win,
    w,
    api: undefined as unknown as Api,
    sent,
    bodies: () => sent.map((s) => s.body),
    types: () => sent.map((s) => String(s.body.type)),
    last: () => sent[sent.length - 1]?.body ?? {},
    observers,
    cookie: (name) => {
      const m = d.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
      return m ? decodeURIComponent(m[1] as string) : undefined;
    },
    console: fakeConsole,
    flush: async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
  if (!options.manual) harness.api = init(w as never) as Api;
  return harness;
}

/** The DataFast queue snippet from its docs, run before the script loads. */
export function queueSnippet(w: Record<string, unknown>) {
  const fn = (...args: unknown[]) => {
    const self = w.datafast as { q?: unknown[] };
    self.q = self.q || [];
    self.q.push(args);
  };
  w.datafast = w.datafast || fn;
}
