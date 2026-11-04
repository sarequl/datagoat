/**
 * Helpers for ingest tests: POST /api/events through the real Worker entry point and wait for
 * the `waitUntil` writes, optionally against a metered env (write budget).
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../../src/index";
import { clearIdentityCache } from "../../../src/ingest/identity";
import { clearSaltCache } from "../../../src/ingest/salts";
import { resetDb } from "../../helpers/db";
import { createSite, type SiteOverrides } from "../../helpers/factories";

export const UA_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
export const UA_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

let ipSeq = 0;
/** A fresh client IP per call, so the per-IP rate limiter never trips across tests. */
export function freshIp(): string {
  ipSeq += 1;
  return `198.51.${Math.floor(ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
}

export interface PostOptions {
  env?: Cloudflare.Env;
  headers?: Record<string, string>;
  cf?: Record<string, unknown>;
  contentType?: string | null;
  ip?: string;
  ua?: string;
  method?: string;
}

export interface PostResult {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: tests inspect arbitrary JSON
  body: any;
  headers: Headers;
}

export async function postEvent(payload: unknown, options: PostOptions = {}): Promise<PostResult> {
  const headers = new Headers({
    "user-agent": options.ua ?? UA_CHROME,
    "accept-language": "en-US,en;q=0.9",
    "cf-connecting-ip": options.ip ?? "203.0.113.7",
    ...options.headers,
  });
  if (options.contentType !== null) {
    headers.set("content-type", options.contentType ?? "text/plain;charset=UTF-8");
  }
  const init: RequestInit & { cf?: Record<string, unknown> } = {
    method: options.method ?? "POST",
    headers,
    body:
      options.method === "OPTIONS"
        ? undefined
        : typeof payload === "string"
          ? payload
          : JSON.stringify(payload),
    cf: options.cf ?? {
      country: "US",
      region: "California",
      city: "San Francisco",
      latitude: "37.7749",
      longitude: "-122.4194",
      asn: 7922,
    },
  };
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://collector.test/api/events", init) as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    options.env ?? env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  return { status: res.status, body, headers: res.headers };
}

export async function resetIngest(): Promise<void> {
  await resetDb();
  clearSaltCache();
  clearIdentityCache();
}

/** A site whose tracking id and domain match the captured DataFast bodies by default. */
export function ingestSite(overrides: SiteOverrides = {}) {
  return createSite(null, { publicId: "dfid_test", domain: "localhost.test", ...overrides });
}

export interface EventBodyOptions {
  websiteId: string;
  href?: string;
  type?: string;
  extraData?: Record<string, unknown>;
  visitorId?: string;
  sessionId?: string;
  sessionNumber?: number;
  referrer?: string | null;
  [key: string]: unknown;
}

/** A tracker body like ours (and DataFast's) builds. */
export function eventBody(o: EventBodyOptions): Record<string, unknown> {
  const {
    websiteId,
    href,
    type,
    extraData,
    visitorId,
    sessionId,
    sessionNumber,
    referrer,
    ...rest
  } = o;
  return {
    websiteId,
    domain: "example.com",
    href: href ?? "https://example.com/",
    referrer: referrer ?? null,
    viewport: { width: 1280, height: 720 },
    visitorId: visitorId ?? "11111111-1111-4111-8111-111111111111",
    sessionId: sessionId ?? "s22222222-2222-4222-8222-222222222222",
    visitorFirstSeenAt: "2026-11-04T10:00:00.000Z",
    visitorSessionNumber: sessionNumber ?? 1,
    language: "en-US",
    timezone: "Europe/Berlin",
    screenWidth: 1440,
    screenHeight: 900,
    type: type ?? "pageview",
    ...(extraData ? { extraData } : {}),
    ...rest,
  };
}

export async function rows<T = Record<string, unknown>>(
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const res = await env.DB.prepare(sql)
    .bind(...params)
    .all<T>();
  return res.results ?? [];
}
