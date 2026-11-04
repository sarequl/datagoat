/**
 * Workers Cache API for analytics responses (plan §9). Keys are the website, its last settings
 * change, the endpoint and the normalised query (minus `websiteId`), plus the public-view flag,
 * so every caller with access to the website shares an entry and a settings change starts fresh.
 * Ranges that end before today (website timezone) are cached for a day; anything touching today
 * or all time for 60 seconds. Authentication always runs first; only 200 responses are stored.
 *
 * The Cache API is a no-op on `*.workers.dev` hostnames, so queries stay within budget without it.
 * A request with `Cache-Control: no-cache` skips the lookup; `ANALYTICS_CACHE=off` disables it.
 */
import type { Context } from "hono";
import { startOfLocalDay } from "../lib/time";
import type { AppEnv } from "../types";
import type { QueryContext } from "./context";

export const CLOSED_RANGE_TTL = 86_400;
export const OPEN_RANGE_TTL = 60;

export function cacheTtl(qc: Pick<QueryContext, "range" | "now" | "site">): number {
  if (!qc.range) return OPEN_RANGE_TTL;
  return qc.range.endMs <= startOfLocalDay(qc.now, qc.site.timezone)
    ? CLOSED_RANGE_TTL
    : OPEN_RANGE_TTL;
}

export function cacheKey(
  c: Context<AppEnv>,
  qc: Pick<QueryContext, "site" | "publicView">,
): string {
  const url = new URL(c.req.url);
  const params = [...url.searchParams.entries()]
    .filter(([k]) => k !== "websiteId")
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = new URLSearchParams(params).toString();
  const endpoint = url.pathname.replace(/^\/api\/share\/[^/]+\/analytics\//, "/api/v1/analytics/");
  return `https://analytics-cache.datagoat.internal/${qc.site.id}/${qc.site.updatedAt}/${qc.publicView ? "public" : "private"}${endpoint}?${query}`;
}

function cacheAvailable(env: Cloudflare.Env): boolean {
  return env.ANALYTICS_CACHE !== "off" && typeof caches !== "undefined" && "default" in caches;
}

export async function withCache(
  c: Context<AppEnv>,
  qc: QueryContext,
  compute: () => Promise<Response>,
): Promise<Response> {
  if (!cacheAvailable(c.env)) return compute();
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(cacheKey(c, qc));
  const bypass = /no-cache/i.test(c.req.header("cache-control") ?? "");
  if (!bypass) {
    const hit = await cache.match(key);
    if (hit) {
      return new Response(hit.body, {
        status: hit.status,
        headers: {
          "content-type": hit.headers.get("content-type") ?? "application/json",
          "X-Cache": "HIT",
        },
      });
    }
  }
  const res = await compute();
  if (res.status !== 200) return res;
  const ttl = cacheTtl(qc);
  const body = await res.clone().arrayBuffer();
  const stored = new Response(body, {
    status: 200,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
      "Cache-Control": `public, max-age=${ttl}`,
    },
  });
  const put = cache.put(key, stored).catch(() => undefined);
  try {
    c.executionCtx.waitUntil(put);
  } catch {
    await put;
  }
  const out = new Response(body, { status: 200, headers: res.headers });
  out.headers.set("X-Cache", "MISS");
  return out;
}
