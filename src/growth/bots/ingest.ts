/**
 * `POST /api/ai-crawls`: server-side crawler request reports (DataFast's endpoint and body,
 * docs/bot-traffic-tracking "Use without Node.js"). Sent by the `@datagoat/ai-crawl` middleware
 * or any backend.
 *
 * Body: `{websiteId, domain, href, ai: {userAgent, ip?, statusCode?, source}}` (≤ 16 KB), or the
 * DataGoat batch form `{events: [...]}` with up to 50 such objects (≤ 64 KB).
 *
 * Pipeline per event: site lookup (isolate cache) → per-site rate limit (Rate Limiting binding,
 * no storage) → optional `dfbot_` token → hostname must belong to the website → classify the user
 * agent on the server (the client's provider/category fields are ignored) → per-site exclusions →
 * IP verification against published ranges → verified-only filter → allowance → write.
 *
 * Write budget: every accepted request is ONE row written (an upsert into `bot_traffic`, whose
 * composite primary key is its only index). Identical requests in one batch are merged first, and
 * all events of a request go to D1 in one `db.batch()`. Ignored requests write nothing.
 */
import { Hono } from "hono";
import { z } from "zod";
import { timingSafeEqual } from "../../lib/crypto";
import { siteCache } from "../../lib/site-cache";
import type { Site } from "../../lib/sites";
import { HOUR_MS } from "../../lib/time";
import type { AppEnv } from "../../types";
import { hostBelongsToSite } from "../shared/site-info";
import { classifyUserAgent } from "./catalog";
import { ipInRanges, loadIpRanges } from "./ip-ranges";
import { hashBotToken, loadBotConfig } from "./settings";
import { allowanceAllows, recordUsage } from "./usage";

export const MAX_SINGLE_BYTES = 16 * 1024;
export const MAX_BATCH_BYTES = 64 * 1024;
export const MAX_BATCH_EVENTS = 50;

const CrawlEvent = z.object({
  websiteId: z.string().min(1).max(100),
  domain: z.string().max(253).optional(),
  href: z.string().min(1).max(4096),
  ai: z.object({
    userAgent: z.string().max(1024).default(""),
    ip: z.string().max(64).nullish(),
    statusCode: z.number().int().nullish(),
    source: z.string().max(64).nullish(),
  }),
});
type CrawlEvent = z.output<typeof CrawlEvent>;

export type IgnoreReason =
  | "unknown_website"
  | "hostname_mismatch"
  | "not_a_crawler"
  | "excluded"
  | "not_verified"
  | "allowance_exhausted"
  | "invalid_url";

export interface Accepted {
  siteId: string;
  hour: number;
  crawlerId: string;
  hostname: string;
  path: string;
  statusCode: number;
  verified: 0 | 1;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function fail(status: number, message: string): Response {
  return json(status, { success: false, error: message });
}

export const botIngestRoutes = new Hono<AppEnv>();

botIngestRoutes.post("/api/ai-crawls", async (c) => {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_BATCH_BYTES) return fail(413, "Body too large");
  const text = await c.req.text();
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_BATCH_BYTES) return fail(413, "Body too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(400, "Invalid JSON body");
  }
  const isBatch =
    Array.isArray(parsed) ||
    (parsed !== null && typeof parsed === "object" && "events" in (parsed as object));
  if (!isBatch && bytes > MAX_SINGLE_BYTES) return fail(413, "Body must be smaller than 16 KB");
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : isBatch
      ? ((parsed as { events: unknown }).events as unknown[])
      : [parsed];
  if (!Array.isArray(list) || list.length === 0) return fail(400, "No events");
  if (list.length > MAX_BATCH_EVENTS)
    return fail(400, `At most ${MAX_BATCH_EVENTS} events per request`);
  const events: CrawlEvent[] = [];
  for (const item of list) {
    const r = CrawlEvent.safeParse(item);
    if (!r.success) {
      const issue = r.error.issues[0];
      return fail(400, `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
    }
    events.push(r.data);
  }

  const db = c.env.DB;
  const now = Date.now();
  const sites = new Map<string, Site | null>();
  for (const ref of new Set(events.map((e) => e.websiteId))) {
    if (sites.size >= 5) return fail(400, "At most 5 websites per batch");
    const site = (await siteCache.byPublicId(db, ref)) ?? (await siteCache.byId(db, ref));
    sites.set(ref, site && site.deletedAt === null ? site : null);
  }
  if (!isBatch && !sites.get(events[0]?.websiteId ?? "")) return fail(404, "Unknown websiteId");

  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? null;
  const bearerHash = bearer ? await hashBotToken(bearer) : null;

  const accepted: Accepted[] = [];
  const ignored: Partial<Record<IgnoreReason, number>> = {};
  const ignore = (reason: IgnoreReason) => {
    ignored[reason] = (ignored[reason] ?? 0) + 1;
  };
  const checkedSites = new Set<string>();

  for (const ev of events) {
    const site = sites.get(ev.websiteId);
    if (!site) {
      ignore("unknown_website");
      continue;
    }
    if (!checkedSites.has(site.id)) {
      const limit = await c.env.INGEST_SITE_LIMITER.limit({ key: `ai-crawls:${site.id}` });
      if (!limit.success) return fail(429, "Too many requests");
      const config = await loadBotConfig(db, site.id, now);
      if (config.settings.requireAuthToken) {
        if (!bearerHash || !config.tokenHash || !timingSafeEqual(bearerHash, config.tokenHash)) {
          return fail(401, "Missing or invalid bot traffic token");
        }
      }
      checkedSites.add(site.id);
    }
    let url: URL;
    try {
      url = new URL(ev.href);
    } catch {
      if (!isBatch) return fail(400, "href must be an absolute URL");
      ignore("invalid_url");
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      ignore("invalid_url");
      continue;
    }
    if (!hostBelongsToSite(url.hostname, site)) {
      if (!isBatch) return fail(400, "href hostname does not belong to this website");
      ignore("hostname_mismatch");
      continue;
    }
    const crawler = classifyUserAgent(ev.ai.userAgent);
    if (!crawler) {
      ignore("not_a_crawler");
      continue;
    }
    const { settings } = await loadBotConfig(db, site.id, now);
    if (settings.excludedCrawlerIds.includes(crawler.id)) {
      ignore("excluded");
      continue;
    }
    let verified: 0 | 1 = 0;
    if (crawler.ipSource && ev.ai.ip) {
      const ranges = await loadIpRanges(db, now);
      verified = ipInRanges(ev.ai.ip, ranges.get(crawler.ipSource) ?? []) ? 1 : 0;
    }
    if (settings.verifiedOnly && !verified) {
      ignore("not_verified");
      continue;
    }
    const status = ev.ai.statusCode ?? 0;
    accepted.push({
      siteId: site.id,
      hour: Math.floor(now / HOUR_MS) * HOUR_MS,
      crawlerId: crawler.id,
      hostname: url.hostname.toLowerCase(),
      path: (decodeSafe(url.pathname) || "/").slice(0, 512),
      statusCode: status >= 100 && status <= 599 ? status : 0,
      verified,
    });
  }

  let toWrite = accepted;
  if (accepted.length) {
    const allowed = await allowanceAllows(c.env, db, accepted.length, now);
    if (allowed < accepted.length) {
      for (let i = allowed; i < accepted.length; i++) ignore("allowance_exhausted");
      toWrite = accepted.slice(0, allowed);
    }
  }
  if (toWrite.length) await db.batch(writeStatements(db, toWrite));
  const flush = recordUsage(c.env, db, toWrite.length, ignored.allowance_exhausted ?? 0, now);
  if (flush) {
    try {
      c.executionCtx.waitUntil(flush);
    } catch {
      await flush;
    }
  }
  return json(200, {
    success: true,
    tracked: toWrite.length,
    ignored: Object.values(ignored).reduce((a, b) => a + (b ?? 0), 0),
  });
});

function decodeSafe(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** One upsert per distinct key; identical keys in a batch are merged first. */
export function writeStatements(db: D1Database, rows: readonly Accepted[]): D1PreparedStatement[] {
  const merged = new Map<string, { row: Accepted; n: number }>();
  for (const row of rows) {
    const key = [
      row.siteId,
      row.hour,
      row.crawlerId,
      row.hostname,
      row.path,
      row.statusCode,
      row.verified,
    ].join("\u0000");
    const entry = merged.get(key);
    if (entry) entry.n += 1;
    else merged.set(key, { row, n: 1 });
  }
  return [...merged.values()].map(({ row, n }) =>
    db
      .prepare(
        `INSERT INTO bot_traffic (site_id, hour, crawler_id, hostname, path, status_code, verified, requests)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (site_id, hour, crawler_id, hostname, path, status_code, verified)
         DO UPDATE SET requests = requests + excluded.requests`,
      )
      .bind(
        row.siteId,
        row.hour,
        row.crawlerId,
        row.hostname,
        row.path,
        row.statusCode,
        row.verified,
        n,
      ),
  );
}
