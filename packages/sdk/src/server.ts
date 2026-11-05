/**
 * @datagoat/sdk/server: read the visitor from the request on your server, to attach it to a
 * checkout for revenue attribution (Stripe `metadata`, Polar `metadata`, Lemon Squeezy
 * `checkout_data.custom`), and call DataGoat's server-side API.
 *
 * Works with anything that carries cookies: a `Cookie` header string, a Fetch `Request` or
 * `Headers`, Next.js `cookies()`, Express `req` (with or without cookie-parser), or a plain object.
 */
import { legacyName, parseCookieHeader, SESSION_COOKIE, VISITOR_COOKIE } from "./cookies.js";
import { isSessionId, isVisitorId } from "./rules.js";

export { parseCookieHeader, SESSION_COOKIE, VISITOR_COOKIE } from "./cookies.js";

interface CookieStoreLike {
  get(name: string): { value: string } | string | undefined | null;
}
interface HeadersLike {
  get(name: string): string | null;
}
interface RequestLike {
  headers: HeadersLike | Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
}

export type CookieSource =
  | string
  | null
  | undefined
  | CookieStoreLike
  | HeadersLike
  | RequestLike
  | Record<string, string | undefined>;

function isHeadersLike(value: unknown): value is HeadersLike {
  return typeof (value as HeadersLike)?.get === "function";
}

/** Read one cookie from any supported source; DataGoat's name first, then DataFast's. */
export function readCookie(source: CookieSource, name: string): string | undefined {
  return (
    readOne(source, name) ??
    (name.startsWith("datagoat_") ? readOne(source, legacyName(name)) : undefined)
  );
}

function readOne(source: CookieSource, name: string): string | undefined {
  if (source === null || source === undefined) return undefined;
  if (typeof source === "string") return parseCookieHeader(source)[name];
  // Next.js cookies() / RequestCookies: get(name) → {name, value}
  if (isHeadersLike(source) && !("append" in source)) {
    const got = (source as CookieStoreLike).get(name);
    if (got && typeof got === "object" && "value" in got) return got.value;
    if (typeof got === "string") return got;
    // Fall through: a Headers-like object whose get() is header lookup.
    const header = (source as HeadersLike).get("cookie");
    return typeof header === "string" ? parseCookieHeader(header)[name] : undefined;
  }
  if (isHeadersLike(source)) return parseCookieHeader(source.get("cookie"))[name];
  const req = source as RequestLike;
  if (req.cookies && typeof req.cookies === "object" && name in req.cookies) {
    return req.cookies[name] ?? undefined;
  }
  if (req.headers) {
    if (isHeadersLike(req.headers)) return parseCookieHeader(req.headers.get("cookie"))[name];
    const raw = (req.headers as Record<string, string | string[] | undefined>).cookie;
    const header = Array.isArray(raw) ? raw.join("; ") : raw;
    return parseCookieHeader(header)[name];
  }
  const plain = (source as Record<string, string | undefined>)[name];
  return typeof plain === "string" ? plain : undefined;
}

/** The `datagoat_visitor_id` (or DataFast's) cookie when it is a valid visitor id, else null. */
export function getVisitorId(source: CookieSource): string | null {
  const value = readCookie(source, VISITOR_COOKIE);
  return isVisitorId(value) ? value : null;
}

/** The `datagoat_session_id` (or DataFast's) cookie when valid, else null. */
export function getSessionId(source: CookieSource): string | null {
  const value = readCookie(source, SESSION_COOKIE);
  return isSessionId(value) ? value : null;
}

export interface CheckoutMetadata {
  datagoat_visitor_id?: string;
  datagoat_session_id?: string;
}

/**
 * Metadata for a checkout so DataGoat attributes the payment to this visit:
 *
 *   stripe.checkout.sessions.create({ ..., metadata: { ...checkoutMetadata(req) } })
 *   polar.checkouts.create({ ..., metadata: checkoutMetadata(req) })
 *
 * Empty object when the visitor has no tracking cookies (ad blocker, consent not given).
 */
export function checkoutMetadata(source: CookieSource): CheckoutMetadata {
  const out: CheckoutMetadata = {};
  const vid = getVisitorId(source);
  const sid = getSessionId(source);
  if (vid) out.datagoat_visitor_id = vid;
  if (vid && sid) out.datagoat_session_id = sid;
  return out;
}

/** Lemon Squeezy: `checkout_data: { custom: ... }` (returned as `meta.custom_data`). */
export function lemonSqueezyCheckoutData(source: CookieSource): { custom: CheckoutMetadata } {
  return { custom: checkoutMetadata(source) };
}

// ---------------------------------------------------------------------------
// Server-side API (POST /api/v1/goals, /identify, /payments)
// ---------------------------------------------------------------------------

export interface ServerClientOptions {
  /** Origin of your DataGoat instance, e.g. https://analytics.example.com. */
  baseUrl: string;
  /** A `dg_` website key (or a `dgt_` account token plus `websiteId`). */
  apiKey: string;
  websiteId?: string;
  fetch?: typeof fetch;
}

export class DataGoatApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "DataGoatApiError";
  }
}

export interface PaymentInput {
  amount: number;
  currency: string;
  transaction_id: string;
  datagoat_visitor_id?: string;
  /** DataFast's name for `datagoat_visitor_id`; still accepted. */
  datafast_visitor_id?: string;
  email?: string;
  name?: string;
  customer_id?: string;
  renewal?: boolean;
  refunded?: boolean;
  is_free_trial?: boolean;
  timestamp?: string;
}

export function createServerClient(options: ServerClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  async function send(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = new URL(`${base}/api/v1/${path}`);
    if (options.websiteId) url.searchParams.set("websiteId", options.websiteId);
    const res = await doFetch(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }
    if (!res.ok) {
      const message =
        (json as { error?: { message?: string } | string })?.error &&
        typeof (json as { error: { message?: string } | string }).error === "object"
          ? ((json as { error: { message?: string } }).error.message ?? `HTTP ${res.status}`)
          : String((json as { error?: string })?.error ?? `HTTP ${res.status}`);
      throw new DataGoatApiError(message, res.status, json);
    }
    return json;
  }
  return {
    /** POST /api/v1/goals: a goal for a visitor seen on your site. */
    goal(visitorId: string, name: string, metadata?: Record<string, string>) {
      return send("POST", "goals", { datagoat_visitor_id: visitorId, name, metadata });
    },
    /** POST /api/v1/identify */
    identify(visitorId: string, userId: string, profile: Record<string, unknown> = {}) {
      return send("POST", "identify", {
        ...profile,
        datagoat_visitor_id: visitorId,
        user_id: userId,
      });
    },
    /** POST /api/v1/payments: any payment provider DataGoat has no integration for. */
    payment(input: PaymentInput) {
      return send("POST", "payments", input);
    },
  };
}
