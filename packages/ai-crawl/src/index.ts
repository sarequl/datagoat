/**
 * @datagoat/ai-crawl — server-side AI crawler tracking for DataGoat.
 *
 * Reports requests from AI assistants, search crawlers and training crawlers to your DataGoat
 * install (`POST <apiUrl>/api/ai-crawls`), the same wire format as DataFast's
 * `@datafast/ai-crawl`. The package only pre-filters cheaply (method, static assets, a user-agent
 * hint list); DataGoat classifies the crawler and verifies its IP on the server.
 *
 * Tracking is best-effort and never delays or fails your response: the report runs in
 * `waitUntil` when the runtime provides one, with a short timeout, and every error is swallowed.
 *
 *   // Cloudflare Workers
 *   export default { fetch: withAICrawlerTracking(handler, { websiteId: "dfid_…", apiUrl: "https://analytics.example.com" }) };
 *
 *   // Next.js proxy.ts / middleware.ts
 *   trackAICrawlerRequest(request, event, { websiteId, apiUrl });
 *
 *   // Express
 *   app.use(createExpressAICrawlerMiddleware({ websiteId, apiUrl }));
 *
 * Runs on any runtime with the Fetch API (Workers, Vercel/Next.js edge and Node 18+, Deno, Bun).
 */

export interface AICrawlOptions {
  /** Your public tracking id (`data-website-id`, e.g. `dfid_…`). */
  websiteId: string;
  /** Origin of your DataGoat install, e.g. `https://analytics.example.com`. */
  apiUrl: string;
  /** Optional `dfbot_` token (keep it in a server-side secret). */
  authToken?: string;
  /** Public origin to report when the runtime sees an internal host (Docker, Cloud Run…). */
  publicOrigin?: string;
  /** Keep the query string in the reported URL (off by default: it may carry personal data). */
  includeQuery?: boolean;
  disableAnswerFetch?: boolean;
  disableSearchCrawlers?: boolean;
  disableTrainingCrawlers?: boolean;
  disableOtherCrawlers?: boolean;
  /** Abort the report after this many milliseconds (default 1500). */
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
  /** Read the client IP yourself when you know which proxy header is trustworthy. */
  getIp?: (request: Request) => string | null | undefined;
  /** Log failures with console.warn. */
  debug?: boolean;
}

export interface WaitUntilContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export type CrawlerCategory = "answer_fetch" | "search_index" | "training" | "other";

const CATEGORY_HINTS: Array<[CrawlerCategory, string[]]> = [
  [
    "answer_fetch",
    [
      "chatgpt-user",
      "claude-user",
      "perplexity-user",
      "meta-externalfetcher",
      "duckassistbot",
      "mistralai-user",
      "google-agent",
      "google-notebooklm",
      "cohere-ai",
    ],
  ],
  [
    "training",
    [
      "gptbot",
      "claudebot",
      "claude-web",
      "anthropic-ai",
      "ccbot",
      "bytespider",
      "google-cloudvertexbot",
      "googleother",
      "applebot",
      "meta-externalagent",
      "amazonbot",
      "diffbot",
      "omgili",
      "timpibot",
      "imagesiftbot",
      "ai2bot",
      "cohere-training-data-crawler",
    ],
  ],
  [
    "search_index",
    [
      "oai-searchbot",
      "claude-searchbot",
      "perplexitybot",
      "googlebot",
      "google-inspectiontool",
      "bingbot",
      "duckduckbot",
      "youbot",
      "yandexbot",
      "baiduspider",
      "petalbot",
      "bravebot",
      "meta-webindexer",
    ],
  ],
];

const GENERIC_HINTS = [
  "bot",
  "crawler",
  "spider",
  "facebookexternalhit",
  "chatgpt",
  "claude",
  "perplexity",
];

/** Cheap local guess of the crawler category; null for anything that does not look like a bot. */
export function crawlerCategory(userAgent: string | null | undefined): CrawlerCategory | null {
  const ua = (userAgent ?? "").toLowerCase();
  if (ua.length < 3) return null;
  for (const [category, hints] of CATEGORY_HINTS)
    if (hints.some((h) => ua.includes(h))) return category;
  return GENERIC_HINTS.some((h) => ua.includes(h)) ? "other" : null;
}

const STATIC_EXTENSIONS = new Set([
  "css",
  "js",
  "mjs",
  "map",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "ico",
  "webp",
  "avif",
  "bmp",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp4",
  "webm",
  "mp3",
  "wav",
  "ogg",
  "zip",
  "gz",
  "wasm",
]);
const INTERNAL_PREFIXES = [
  "/_next/",
  "/__",
  "/static/",
  "/assets/",
  "/api/",
  "/cdn-cgi/",
  "/_vercel/",
];

/** Crawler-facing discovery files are always kept (robots.txt, llms.txt, sitemaps, markdown). */
export function isTrackablePath(pathname: string): boolean {
  const path = pathname.toLowerCase();
  if (path === "/favicon.ico") return false;
  if (INTERNAL_PREFIXES.some((p) => path.startsWith(p))) return false;
  const last = path.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0) return true;
  return !STATIC_EXTENSIONS.has(last.slice(dot + 1));
}

function categoryDisabled(category: CrawlerCategory, o: AICrawlOptions): boolean {
  return (
    (category === "answer_fetch" && o.disableAnswerFetch === true) ||
    (category === "search_index" && o.disableSearchCrawlers === true) ||
    (category === "training" && o.disableTrainingCrawlers === true) ||
    (category === "other" && o.disableOtherCrawlers === true)
  );
}

function clientIp(request: Request, o: AICrawlOptions): string | null {
  if (o.getIp) return o.getIp(request) ?? null;
  const h = request.headers;
  // cf-connecting-ip is set by Cloudflare and cannot be forged by the client on Workers;
  // x-vercel-forwarded-for / x-real-ip / x-forwarded-for are only as trustworthy as your proxy.
  const value =
    h.get("cf-connecting-ip") ??
    h.get("x-vercel-forwarded-for") ??
    h.get("x-real-ip") ??
    h.get("x-forwarded-for")?.split(",")[0];
  return value?.trim() || null;
}

export interface CrawlReport {
  websiteId: string;
  domain: string;
  href: string;
  ai: { userAgent: string; ip: string | null; statusCode?: number; source: "server_middleware" };
}

/** Build the report for a request, or null when it should not be sent. */
export function buildReport(
  input: {
    method: string;
    url: string;
    userAgent: string | null;
    ip: string | null;
    statusCode?: number | null;
  },
  options: AICrawlOptions,
): CrawlReport | null {
  if (!options.websiteId || !options.apiUrl) return null;
  const method = input.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  const category = crawlerCategory(input.userAgent);
  if (!category || categoryDisabled(category, options)) return null;
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return null;
  }
  if (!isTrackablePath(url.pathname)) return null;
  if (options.publicOrigin) {
    const pub = new URL(options.publicOrigin);
    url.protocol = pub.protocol;
    url.hostname = pub.hostname;
    url.port = pub.port;
  }
  const href = `${url.origin}${url.pathname}${options.includeQuery ? url.search : ""}`;
  const report: CrawlReport = {
    websiteId: options.websiteId,
    domain: url.hostname,
    href,
    ai: { userAgent: input.userAgent ?? "", ip: input.ip, source: "server_middleware" },
  };
  if (input.statusCode && input.statusCode >= 100 && input.statusCode <= 599)
    report.ai.statusCode = input.statusCode;
  return report;
}

/** POST a report. Resolves to true when DataGoat accepted it; never rejects. */
export async function sendReport(report: CrawlReport, options: AICrawlOptions): Promise<boolean> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.authToken) headers.authorization = `Bearer ${options.authToken}`;
  try {
    const res = await doFetch(`${options.apiUrl.replace(/\/+$/, "")}/api/ai-crawls`, {
      method: "POST",
      headers,
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(options.timeoutMs ?? 1500),
    });
    await res.body?.cancel();
    if (!res.ok && options.debug) console.warn(`[ai-crawl] DataGoat answered ${res.status}`);
    return res.ok;
  } catch (err) {
    if (options.debug) console.warn("[ai-crawl] report failed", err);
    return false;
  }
}

function schedule(
  promise: Promise<boolean>,
  context: WaitUntilContext | null | undefined,
): Promise<boolean> {
  try {
    context?.waitUntil?.(promise);
  } catch {
    // Some runtimes throw when waitUntil is called outside a request; the promise still runs.
  }
  return promise;
}

const SKIPPED = Promise.resolve(false);

/** Request-only tracking (middleware that runs before the response exists). Do not await it. */
export function trackAICrawlerRequest(
  request: Request,
  context: WaitUntilContext | null | undefined,
  options: AICrawlOptions,
): Promise<boolean> {
  return trackAICrawlerResponse(request, null, context, options);
}

/** Response-aware tracking: also reports the status code. Do not await it. */
export function trackAICrawlerResponse(
  request: Request,
  response: Pick<Response, "status"> | null,
  context: WaitUntilContext | null | undefined,
  options: AICrawlOptions,
): Promise<boolean> {
  try {
    const report = buildReport(
      {
        method: request.method,
        url: request.url,
        userAgent: request.headers.get("user-agent"),
        ip: clientIp(request, options),
        statusCode: response?.status ?? null,
      },
      options,
    );
    if (!report) return SKIPPED;
    return schedule(sendReport(report, options), context);
  } catch {
    return SKIPPED;
  }
}

type FetchHandler<Env, Ctx> = (
  request: Request,
  env: Env,
  ctx: Ctx,
) => Response | Promise<Response>;

/** Cloudflare Workers: wrap your fetch handler; reports after your response is ready. */
export function withAICrawlerTracking<
  Env = unknown,
  Ctx extends WaitUntilContext = WaitUntilContext,
>(handler: FetchHandler<Env, Ctx>, options: AICrawlOptions): FetchHandler<Env, Ctx> {
  return async (request, env, ctx) => {
    const response = await handler(request, env, ctx);
    trackAICrawlerResponse(request, response, ctx, options);
    return response;
  };
}

/** Minimal shapes of Express's req/res so the package needs no Express types. */
export interface ExpressLikeRequest {
  method: string;
  originalUrl?: string;
  url: string;
  protocol?: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}
export interface ExpressLikeResponse {
  statusCode: number;
  once?(event: "finish", listener: () => void): unknown;
  on(event: "finish", listener: () => void): unknown;
}

function header(req: ExpressLikeRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Express / Connect middleware: calls next() at once and reports after the response is sent. */
export function createExpressAICrawlerMiddleware(options: AICrawlOptions) {
  return (req: ExpressLikeRequest, res: ExpressLikeResponse, next: () => void): void => {
    next();
    try {
      const host = header(req, "x-forwarded-host") ?? header(req, "host");
      if (!host) return;
      const proto = (header(req, "x-forwarded-proto") ?? req.protocol ?? "https")
        .split(",")[0]
        ?.trim();
      const url = `${proto}://${host}${req.originalUrl ?? req.url}`;
      const userAgent = header(req, "user-agent") ?? null;
      if (!crawlerCategory(userAgent)) return;
      const listen = (res.once ?? res.on).bind(res);
      listen("finish", () => {
        const report = buildReport(
          { method: req.method, url, userAgent, ip: req.ip ?? null, statusCode: res.statusCode },
          options,
        );
        if (report) void sendReport(report, options);
      });
    } catch {
      // never break the app
    }
  };
}
