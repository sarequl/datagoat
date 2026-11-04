/**
 * Per-credential API rate limiting with the API_LIMITER Workers Rate Limiting binding
 * (60 requests per minute, DataFast's documented budget). No KV or D1 writes.
 *
 * The binding only answers allowed/denied, so `X-RateLimit-Remaining` comes from an approximate
 * per-isolate counter for the current fixed 60-second window, and `X-RateLimit-Reset` is the end of
 * that window (epoch seconds). The binding stays the authority for 429s.
 *
 * Dashboard sessions are not limited (a human loading a dashboard issues bursts of queries).
 */
import type { MiddlewareHandler } from "hono";
import { rateLimitBody } from "../lib/response";
import type { AppEnv } from "../types";

export const API_RATE_LIMIT = 60;
const WINDOW_MS = 60_000;

const windows = new Map<string, { start: number; count: number }>();

function track(key: string, now: number): { remaining: number; reset: number } {
  const start = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  let w = windows.get(key);
  if (!w || w.start !== start) {
    if (windows.size > 5000) windows.clear();
    w = { start, count: 0 };
    windows.set(key, w);
  }
  w.count += 1;
  return {
    remaining: Math.max(0, API_RATE_LIMIT - w.count),
    reset: Math.floor((start + WINDOW_MS) / 1000),
  };
}

export const apiRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth || auth.kind === "session") return next();
  const key = `${auth.kind}:${auth.credentialId}`;
  const { remaining, reset } = track(key, Date.now());
  const headers = {
    "X-RateLimit-Limit": String(API_RATE_LIMIT),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(reset),
  };
  const outcome = await c.env.API_LIMITER.limit({ key });
  if (!outcome.success) {
    return c.json(rateLimitBody(API_RATE_LIMIT, 0, reset), 429, {
      ...headers,
      "X-RateLimit-Remaining": "0",
      "Retry-After": String(Math.max(1, reset - Math.floor(Date.now() / 1000))),
    });
  }
  await next();
  for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
};

export function resetRateLimitState(): void {
  windows.clear();
}
