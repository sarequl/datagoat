/**
 * Growth test helpers: a scripted `fetch` mock (no test ever reaches a real provider), a job
 * context for calling job bodies directly, and `apiWith()` to call the app with env overrides
 * (an email provider, OAuth clients, an allowance).
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach } from "vitest";
import { createApp } from "../../../src/app";
import type { JobContext } from "../../../src/jobs/registry";
import { type ApiOptions, type ApiResponse, ORIGIN } from "../../helpers/http";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

type Handler = (call: RecordedCall) => Response | Promise<Response> | unknown;

export interface FetchMock {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  calls: RecordedCall[];
  on(match: string | RegExp, handler: Handler): FetchMock;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fetch that answers from registered handlers (first match wins) and records every call. */
export function mockFetch(): FetchMock {
  const routes: Array<[string | RegExp, Handler]> = [];
  const calls: RecordedCall[] = [];
  const mock: FetchMock = {
    calls,
    on(match, handler) {
      routes.push([match, handler]);
      return mock;
    },
    async fetch(input, init) {
      const req = new Request(input as RequestInfo, init);
      const call: RecordedCall = {
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: init?.body !== undefined && init.body !== null ? String(init.body) : "",
      };
      calls.push(call);
      for (const [match, handler] of routes) {
        const hit = typeof match === "string" ? call.url.startsWith(match) : match.test(call.url);
        if (!hit) continue;
        const out = await handler(call);
        return out instanceof Response ? out : jsonResponse(out ?? {});
      }
      return jsonResponse({ error: `unmocked ${call.method} ${call.url}` }, 599);
    },
  };
  return mock;
}

const realFetch = globalThis.fetch;

/** Route the global fetch (used by request handlers) through a mock for this test. */
export function useGlobalFetch(mock: FetchMock): void {
  globalThis.fetch = mock.fetch as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

export interface TestJobContext extends JobContext {
  saved: unknown;
}

export function jobCtx(options: {
  now: number;
  fetch?: FetchMock;
  state?: unknown;
  db?: D1Database;
  env?: Cloudflare.Env;
}): TestJobContext {
  const e = options.env ?? env;
  const db = options.db ?? e.DB;
  const ctx: TestJobContext = {
    env: { ...e, DB: db },
    db,
    now: options.now,
    slot: options.now,
    lastRunAt: null,
    lastSuccessAt: null,
    state: options.state ?? null,
    saved: undefined,
    setState(next) {
      ctx.saved = next;
    },
    remainingQueries: () => 40,
    fetch: (input, init) =>
      options.fetch
        ? options.fetch.fetch(input, init)
        : Promise.reject(new Error("no fetch mock in this test")),
    waitUntil: () => {},
  };
  return ctx;
}

/** env with an email provider configured (Resend). */
export function emailEnv(base: Cloudflare.Env = env): Cloudflare.Env {
  return { ...base, RESEND_API_KEY: "re_test_key", EMAIL_FROM: "DataGoat <alerts@example.com>" };
}

export const EMAIL = { RESEND_API_KEY: "re_test_key", EMAIL_FROM: "DataGoat <alerts@example.com>" };

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const app = createApp();

/** Like `api()` but with an env override (e.g. an email provider or OAuth client configured). */
// biome-ignore lint/suspicious/noExplicitAny: tests inspect arbitrary JSON bodies
export async function apiWith<T = any>(
  overrides: Partial<Cloudflare.Env>,
  path: string,
  options: ApiOptions = {},
): Promise<ApiResponse<T>> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const headers = new Headers(options.headers);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin !== null && !["GET", "HEAD"].includes(method)) {
    headers.set("origin", options.origin ?? ORIGIN);
  }
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    body =
      typeof options.body === "string" || options.body instanceof Uint8Array
        ? (options.body as BodyInit)
        : JSON.stringify(options.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, body, redirect: "manual" }),
    { ...env, ...overrides } as Cloudflare.Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  return {
    status: res.status,
    headers: res.headers,
    body: parsed as T,
    cookies: res.headers.getSetCookie(),
    raw: res,
  };
}
