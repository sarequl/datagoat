/**
 * In-process calls from MCP tools to the Worker's own `/api/v1` handlers, so REST and MCP share
 * one implementation of validation, authorization, rate limits and response shapes.
 *
 * The internal request carries a one-time Bearer `dgi_<nonce>`. The matching AuthContext rides on
 * the ExecutionContext object passed to `app.fetch`, which an outside caller cannot set, so the
 * `dgi_` resolver only ever accepts requests made here. Everything else about the request is
 * ordinary: the shared middleware (authenticate → rate limit) and the handler run unchanged.
 */
import type { AuthContext } from "../auth/context";
import { registerBearerResolver } from "../auth/credentials";
import { timingSafeEqual } from "../lib/crypto";
import { randomToken } from "../lib/ids";

const INTERNAL = Symbol.for("datagoat.mcp.internal-call");
const PREFIX = "dgi_";

interface InternalMarker {
  token: string;
  auth: AuthContext;
}

type MarkedContext = ExecutionContext & { [INTERNAL]?: InternalMarker };

let resolverRegistered = false;

/** Register the `dgi_` resolver (idempotent; called at module load of src/mcp/index.ts). */
export function registerInternalResolver(): void {
  if (resolverRegistered) return;
  resolverRegistered = true;
  registerBearerResolver(PREFIX, async (token, _env, ctx) => {
    const marker = (ctx as MarkedContext | undefined)?.[INTERNAL];
    if (!marker || !timingSafeEqual(marker.token, token)) return null;
    return marker.auth;
  });
}

export interface ApiRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Absolute path, e.g. `/api/v1/analytics/overview`. */
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
}

export interface ApiResult {
  status: number;
  headers: Headers;
  /** Parsed JSON body (or the raw text when not JSON). */
  body: unknown;
}

export type Fetcher = (
  request: Request,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
) => Promise<Response>;

let appFetch: Fetcher | undefined;

async function defaultFetcher(): Promise<Fetcher> {
  if (!appFetch) {
    // Imported lazily: src/app.ts imports the route table, which imports this module.
    const { createApp } = await import("../app");
    const app = createApp();
    appFetch = (req, env, ctx) => Promise.resolve(app.fetch(req, env, ctx));
  }
  return appFetch;
}

export function buildPath(path: string, query: ApiRequest["query"]): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Call an `/api/v1` handler in-process as `auth`. */
export async function callApi(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  origin: string,
  auth: AuthContext,
  request: ApiRequest,
): Promise<ApiResult> {
  const token = `${PREFIX}${randomToken(24)}`;
  const marked: MarkedContext = {
    waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p),
    passThroughOnException: () => ctx.passThroughOnException(),
    props: (ctx as { props?: unknown }).props,
    [INTERNAL]: { token, auth },
  } as MarkedContext;
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "user-agent": "datagoat-mcp",
  });
  let body: string | undefined;
  if (request.body !== undefined && request.method !== "GET") {
    body = JSON.stringify(request.body);
    headers.set("content-type", "application/json");
  }
  const url = `${origin}${buildPath(request.path, request.query)}`;
  const fetcher = await defaultFetcher();
  const res = await fetcher(
    new Request(url, { method: request.method, headers, body }),
    env,
    marked,
  );
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep text
    }
  } else {
    parsed = null;
  }
  return { status: res.status, headers: res.headers, body: parsed };
}
