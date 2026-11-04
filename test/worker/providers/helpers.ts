/**
 * Revenue test helpers: a mocked provider HTTP API (no real third-party calls), connection
 * fixtures, and job runners.
 *
 *   const api = mockProviders({ "GET https://api.stripe.com/v1/events": () => json({ data: [] }) });
 *   ...
 *   expect(api.calls).toHaveLength(1);
 *   api.restore();
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import type { JobDefinition } from "../../../src/jobs/registry";
import { runScheduled } from "../../../src/jobs/scheduler";
import { saveConnection } from "../../../src/providers/connections";
import type { ProviderId } from "../../../src/providers/types";
import { createSession, createSite, createUser, sessionCookie } from "../../helpers/factories";

export interface MockCall {
  method: string;
  url: string;
  headers: Headers;
  body: string | null;
}

export type MockHandler = (call: MockCall) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Replace global fetch. Keys are `METHOD url-prefix` (the longest matching prefix wins); a
 * function key-less fallback answers 599 so unmocked calls fail loudly.
 */
export function mockProviders(routes: Record<string, MockHandler>) {
  const calls: MockCall[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const call: MockCall = {
      method: (init?.method ?? req.method ?? "GET").toUpperCase(),
      url: req.url,
      headers: new Headers(init?.headers ?? req.headers),
      body: init?.body !== undefined && init.body !== null ? String(init.body) : null,
    };
    calls.push(call);
    let best: { key: string; handler: MockHandler } | null = null;
    for (const [key, handler] of Object.entries(routes)) {
      const [method, prefix] = key.split(" ", 2) as [string, string];
      if (method !== call.method || !call.url.startsWith(prefix)) continue;
      if (!best || prefix.length > best.key.length) best = { key: prefix, handler };
    }
    if (!best) return new Response(`unmocked ${call.method} ${call.url}`, { status: 599 });
    return best.handler(call);
  });
  return {
    calls,
    restore: () => spy.mockRestore(),
    /** Calls whose URL starts with `prefix`. */
    to: (prefix: string) => calls.filter((c) => c.url.startsWith(prefix)),
  };
}

export async function ownerWithSite(overrides: Parameters<typeof createSite>[1] = {}) {
  const user = await createUser();
  const site = await createSite(user.id, overrides);
  const cookie = await sessionCookie(user.id);
  return { user, site, cookie };
}

export async function connect(
  siteId: string,
  provider: ProviderId,
  options: {
    credentials?: Record<string, string>;
    webhookSecret?: string | null;
    settings?: Record<string, unknown>;
    syncCursor?: string | null;
    backfill?: boolean;
    now?: number;
  } = {},
) {
  await saveConnection(env, {
    siteId,
    provider,
    credentials: options.credentials ?? { apiKey: "rk_live_testkey0123456789" },
    webhookSecret: options.webhookSecret ?? null,
    settings: options.settings ?? {},
    syncCursor: options.syncCursor,
    backfill: options.backfill ?? false,
    now: options.now,
  });
}

export async function runJobs(jobs: JobDefinition[], at: number, base: Cloudflare.Env = env) {
  const ctx = createExecutionContext();
  const res = await runScheduled(jobs, base, ctx, at);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A visitor with sessions at the given times (ms) and channels. */
export async function visitorWithSessions(
  siteId: string,
  sessions: Array<{ at: number; channel?: string; source?: string | null; country?: string }>,
  visitorId?: string,
) {
  const created = [];
  let vid = visitorId;
  for (const s of sessions) {
    const row = await createSession({
      siteId,
      visitorId: vid,
      startedAt: s.at,
      durationMs: 60_000,
      channel: s.channel ?? "Direct",
      source: s.source ?? null,
      country: s.country ?? null,
      sessionNumber: created.length + 1,
    });
    vid = row.visitorId;
    created.push(row);
  }
  return { visitorId: vid as string, sessions: created };
}

export async function paymentRows(siteId: string) {
  const res = await env.DB.prepare(
    "SELECT * FROM payments WHERE site_id = ? ORDER BY occurred_at, provider_txn_id",
  )
    .bind(siteId)
    .all<Record<string, unknown>>();
  return res.results ?? [];
}

export async function goalEvents(siteId: string) {
  const res = await env.DB.prepare(
    "SELECT ts, session_id, visitor_id, name, props FROM events WHERE site_id = ? AND type = 'custom' ORDER BY ts, id",
  )
    .bind(siteId)
    .all<{ ts: number; session_id: string; visitor_id: string; name: string; props: string }>();
  return res.results ?? [];
}

export const T0 = Date.UTC(2026, 10, 2, 12, 0); // Monday 2 Nov 2026 12:00 UTC
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
