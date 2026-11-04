/**
 * Public dashboard share link (DataFast "Public dashboard") and usage (DataGoat):
 *   GET    …/share   settings:read   current link
 *   POST   …/share   settings:write  enable, or rotate the token; `{isPublicDataEnabled?}`
 *   DELETE …/share   settings:write  disable (the old URL stops working at once)
 *   GET    …/usage   settings:read   events counted, rows, D1 size vs plan limits
 */
import { Hono } from "hono";
import { z } from "zod";
import { getAccess } from "../../../auth/context";
import { requireSiteAccess } from "../../../auth/middleware";
import { randomToken } from "../../../lib/ids";
import { success } from "../../../lib/response";
import { siteCache } from "../../../lib/site-cache";
import { loadSiteById, type Site } from "../../../lib/sites";
import { addDays, DAY_MS, localDate, startOfDate } from "../../../lib/time";
import { parseJsonBody } from "../../../lib/validate";
import type { AppEnv } from "../../../types";

export const shareRoutes = new Hono<AppEnv>();

const W = "/api/v1/admin/websites/:websiteId";

export function shareLinkDto(site: Pick<Site, "shareToken" | "publicDataEnabled">, origin: string) {
  return {
    enabled: site.shareToken !== null,
    token: site.shareToken,
    url: site.shareToken ? `${origin}/share/${site.shareToken}` : null,
    isPublicDataEnabled: site.publicDataEnabled,
  };
}

const origin = (url: string) => new URL(url).origin;

shareRoutes.get(
  `${W}/share`,
  requireSiteAccess("settings:read", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const fresh = (await loadSiteById(c.env.DB, site.id)) ?? site;
    return success(c, shareLinkDto(fresh, origin(c.req.url)));
  },
);

const ShareBody = z.object({ isPublicDataEnabled: z.boolean().optional() }).strict();

shareRoutes.post(
  `${W}/share`,
  requireSiteAccess("settings:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const body = await parseJsonBody(c, ShareBody);
    const token = randomToken(18);
    const publicData = body.isPublicDataEnabled ?? site.publicDataEnabled;
    await c.env.DB.prepare(
      "UPDATE sites SET share_token = ?, public_data_enabled = ?, updated_at = ? WHERE id = ?",
    )
      .bind(token, publicData ? 1 : 0, Date.now(), site.id)
      .run();
    siteCache.invalidate(site);
    return success(
      c,
      shareLinkDto({ shareToken: token, publicDataEnabled: publicData }, origin(c.req.url)),
    );
  },
);

shareRoutes.delete(
  `${W}/share`,
  requireSiteAccess("settings:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    await c.env.DB.prepare("UPDATE sites SET share_token = NULL, updated_at = ? WHERE id = ?")
      .bind(Date.now(), site.id)
      .run();
    siteCache.invalidate(site);
    return success(
      c,
      shareLinkDto(
        { shareToken: null, publicDataEnabled: site.publicDataEnabled },
        origin(c.req.url),
      ),
    );
  },
);

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export const D1_LIMITS = {
  free: { bytes: 500 * 1024 * 1024, rowsWrittenPerDay: 100_000 },
  // Workers Paid: 10 GB per database; 50M rows written per month included (~1.67M a day).
  paid: { bytes: 10 * 1024 * 1024 * 1024, rowsWrittenPerDay: Math.round(50_000_000 / 30) },
} as const;

shareRoutes.get(
  `${W}/usage`,
  requireSiteAccess("settings:read", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const db = c.env.DB;
    const now = Date.now();
    const planName =
      c.env.D1_PLAN === "paid" ? "paid" : c.env.D1_PLAN === "free" ? "free" : "unknown";
    const limits = planName === "paid" ? D1_LIMITS.paid : D1_LIMITS.free;
    // Stored events: rollup counts for closed days (kept by the rollup job) plus raw counts after
    // the watermark, and only for days inside the retention window.
    const state = await db
      .prepare("SELECT through_day, timezone FROM rollup_state WHERE site_id = ?")
      .bind(site.id)
      .first<{ through_day: string | null; timezone: string }>();
    const tz = state?.timezone ?? site.timezone;
    const through = state?.through_day ?? null;
    const rawFrom = through ? startOfDate(addDays(through, 1), tz) : 0;
    const cutoff = site.retentionDays ? now - site.retentionDays * DAY_MS : 0;
    const cutoffDay = cutoff ? localDate(cutoff, tz) : "0000-00-00";
    const since = now - DAY_MS;
    const results = await db.batch([
      db
        .prepare(
          "SELECT COALESCE(SUM(events), 0) AS events, COALESCE(SUM(sessions), 0) AS sessions FROM daily_stats WHERE site_id = ? AND day > ? AND day <= ?",
        )
        .bind(site.id, cutoffDay, through ?? "0000-00-00"),
      db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND ts >= ?")
        .bind(site.id, Math.max(rawFrom, cutoff)),
      db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE site_id = ? AND started_at >= ?")
        .bind(site.id, rawFrom),
      db.prepare("SELECT COUNT(*) AS n FROM visitors WHERE site_id = ?").bind(site.id),
      db.prepare("SELECT COUNT(*) AS n FROM payments WHERE site_id = ?").bind(site.id),
      db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND ts >= ?")
        .bind(site.id, since),
      db
        .prepare(
          "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN session_number IS NULL OR session_number < 2 THEN 1 ELSE 0 END), 0) AS fresh FROM sessions WHERE site_id = ? AND started_at >= ?",
        )
        .bind(site.id, since),
      db.prepare("SELECT MIN(ts) AS t FROM events WHERE site_id = ?").bind(site.id),
    ]);
    const n = (i: number, col = "n") =>
      Number((results[i]?.results?.[0] as Record<string, unknown>)?.[col] ?? 0);
    const size = Math.max(
      ...results.map((r) => Number((r.meta as { size_after?: number }).size_after ?? 0)),
    );
    const events = n(0, "events") + n(1);
    const sessionsTotal = n(0, "sessions") + n(2);
    const events24 = n(5);
    const sessions24 = n(6);
    const newVisitors24 = n(6, "fresh");
    const oldest = (results[7]?.results?.[0] as { t?: number | null } | undefined)?.t ?? null;
    return success(c, {
      databaseSizeBytes: size,
      databaseLimitBytes: limits.bytes,
      databasePercentUsed: Math.round((10000 * size) / limits.bytes) / 100,
      plan: planName,
      rows: { events, sessions: sessionsTotal, visitors: n(3), payments: n(4) },
      last24h: {
        events: events24,
        sessions: sessions24,
        // Plan §7: an event writes 2 rows, a new session 3 more, a new visitor 1 more (approx.).
        estimatedRowsWritten: events24 * 2 + sessions24 * 3 + newVisitors24,
      },
      estimatedDailyWriteLimit: limits.rowsWrittenPerDay,
      retentionDays: site.retentionDays,
      oldestEventAt: oldest === null ? null : new Date(Number(oldest)).toISOString(),
    });
  },
);
