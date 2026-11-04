/**
 * Attack mode (DataFast: "Attack mode" with "Auto-enable on traffic spike"). In DataGoat attack
 * mode is the `strict` bot filter level (`sites.bot_level`), which W1's ingest applies. This
 * module adds:
 *
 * - `attack.detect` (every 5 minutes): for websites with auto-enable on, detects abnormal bot or
 *   bot-like traffic and raises the filter to `strict` for `duration_minutes`, records an
 *   `attack_mode_events` row and notifies the owners (email) and the site's traffic-spike alerts.
 *   When the period ends it restores the previous level (unless someone changed it meanwhile).
 * - `GET/PUT /api/v1/admin/websites/:id/bot-traffic/attack-mode` (DG): settings, manual on/off,
 *   current state and recent events.
 *
 * Signals (both read cheaply, no per-event writes):
 * 1. **Bot spike:** hits dropped by the ingest bot filter (`bot_daily`, any reason, including
 *    headless/automation/datacenter-style reasons W1 records) in the last 5 minutes, measured as
 *    the change of today's counter since the previous run, against the trailing 7-day average.
 * 2. **Suspicious traffic spike:** sessions in the last 15 minutes against the trailing average
 *    from `daily_stats`, where at least 80% are bot-like (one pageview, no interaction, under one
 *    second). A genuine viral spike has normal engagement and does not trigger attack mode.
 */
import { Hono } from "hono";
import { z } from "zod";
import { getAccess } from "../../auth/context";
import { requireSiteAccess } from "../../auth/middleware";
import type { JobContext } from "../../jobs/registry";
import { parseJsonColumn } from "../../lib/d1";
import { newId } from "../../lib/ids";
import { success } from "../../lib/response";
import { siteCache } from "../../lib/site-cache";
import { addDays, DAY_MS, localDate, toIsoOrNull } from "../../lib/time";
import { parseJsonBody } from "../../lib/validate";
import type { AppEnv } from "../../types";
import type { AlertRow } from "../alerts/model";
import { baseVars, buildPayload, siteLabel } from "../alerts/notify";
import { emailConfigured } from "../delivery/email";
import { enqueueStatement, type OutboxItem } from "../delivery/outbox";
import { emailLayout, textToHtml } from "../delivery/templates";
import { ownerEmailsBySite, publicUrl } from "../shared/site-info";

export const DETECT_WINDOW_MS = 5 * 60_000;
const SESSION_WINDOW_MS = 15 * 60_000;
const SUSPICIOUS_SHARE = 0.8;
const MAX_SITES = 20;

export interface AttackSettingsRow {
  site_id: string;
  auto_enable: number;
  multiplier: number;
  min_hits: number;
  duration_minutes: number;
  active_until: number | null;
  previous_level: string | null;
  activated_at: number | null;
  updated_at: number;
}

export interface AttackDetectState {
  bots?: Record<string, { day: string; hits: number }>;
}

interface Candidate extends AttackSettingsRow {
  bot_level: string;
  domain: string;
  name: string | null;
  timezone: string;
}

export interface Detection {
  reason: "bot_spike" | "suspicious_traffic_spike";
  details: Record<string, number>;
}

export function detect(
  s: Pick<AttackSettingsRow, "multiplier" | "min_hits">,
  r: {
    botDelta: number | null;
    botBaselinePerWindow: number;
    sessions: number;
    suspicious: number;
    sessionBaselinePerWindow: number;
  },
): Detection | null {
  if (
    r.botDelta !== null &&
    r.botDelta >= s.min_hits &&
    r.botDelta >= s.multiplier * Math.max(1, r.botBaselinePerWindow)
  ) {
    return {
      reason: "bot_spike",
      details: { botHits5m: r.botDelta, baseline5m: Math.round(r.botBaselinePerWindow * 10) / 10 },
    };
  }
  if (
    r.sessions >= s.min_hits &&
    r.sessions >= s.multiplier * Math.max(1, r.sessionBaselinePerWindow) &&
    r.suspicious / r.sessions >= SUSPICIOUS_SHARE
  ) {
    return {
      reason: "suspicious_traffic_spike",
      details: {
        sessions15m: r.sessions,
        botLikeShare: Math.round((r.suspicious / r.sessions) * 100),
        baseline15m: Math.round(r.sessionBaselinePerWindow * 10) / 10,
      },
    };
  }
  return null;
}

async function notify(
  ctx: Pick<JobContext, "db" | "env" | "now">,
  sites: Array<{
    id: string;
    domain: string;
    name: string | null;
    timezone: string;
    currency?: string;
  }>,
  build: (site: { id: string; domain: string; name: string | null }) => {
    subject: string;
    text: string;
    key: string;
  },
): Promise<D1PreparedStatement[]> {
  if (sites.length === 0) return [];
  const { db, now } = ctx;
  const ids = sites.map((s) => s.id);
  const [owners, base, alertsRes] = await Promise.all([
    ownerEmailsBySite(db, ids),
    publicUrl(db),
    db
      .prepare(
        `SELECT * FROM alerts WHERE is_enabled = 1 AND trigger_type = 'traffic_spike' AND site_id IN (${ids.map(() => "?").join(", ")})`,
      )
      .bind(...ids)
      .all<AlertRow>(),
  ]);
  const items: OutboxItem[] = [];
  for (const site of sites) {
    const msg = build(site);
    const url = base ? `${base}/app/${site.id}/bot-traffic` : null;
    const to = owners.get(site.id) ?? [];
    if (emailConfigured(ctx.env) && to.length) {
      items.push({
        siteId: site.id,
        dedupeKey: `${msg.key}:owners`,
        payload: {
          channel: "email",
          to,
          subject: msg.subject,
          text: url ? `${msg.text}\n\n${url}` : msg.text,
          html: emailLayout({ title: msg.subject, bodyHtml: textToHtml(msg.text), actionUrl: url }),
        },
      });
    }
    for (const alert of (alertsRes.results ?? []).filter((a) => a.site_id === site.id)) {
      const payload = buildPayload(alert, site, baseVars(site, base, "bot-traffic"), to, {
        summary: msg.subject,
        visitorId: null,
        goalName: null,
        text: msg.text,
      });
      // Owners already got the email above; alert rules on email without a fixed recipient
      // would duplicate it.
      if (
        payload &&
        !(
          payload.channel === "email" &&
          emailConfigured(ctx.env) &&
          !parseJsonColumn<{ email?: string }>(alert.destination, {}).email
        )
      ) {
        items.push({ siteId: site.id, payload, dedupeKey: `${msg.key}:${alert.id}` });
      }
    }
  }
  return items.map((i) => enqueueStatement(db, i, now));
}

export async function runAttackDetection(
  ctx: Pick<JobContext, "db" | "env" | "now" | "state" | "setState">,
) {
  const { db, now } = ctx;
  const state = (ctx.state ?? {}) as AttackDetectState;
  const [expiredRes, candRes] = await db.batch([
    db
      .prepare(
        `SELECT am.site_id, am.previous_level, s.domain, s.name, s.timezone FROM attack_mode am
       JOIN sites s ON s.id = am.site_id WHERE am.active_until IS NOT NULL AND am.active_until <= ?`,
      )
      .bind(now),
    db.prepare(
      `SELECT am.*, s.bot_level, s.domain, s.name, s.timezone FROM attack_mode am
       JOIN sites s ON s.id = am.site_id AND s.deleted_at IS NULL
       WHERE am.auto_enable = 1 AND am.active_until IS NULL LIMIT ${MAX_SITES}`,
    ),
  ]);
  const writes: D1PreparedStatement[] = [];
  const expired = (expiredRes?.results ?? []) as Array<{
    site_id: string;
    previous_level: string | null;
    domain: string;
    name: string | null;
    timezone: string;
  }>;
  for (const e of expired) {
    writes.push(
      db
        .prepare(
          "UPDATE sites SET bot_level = ?, updated_at = ? WHERE id = ? AND bot_level = 'strict'",
        )
        .bind(
          e.previous_level && e.previous_level !== "strict" ? e.previous_level : "standard",
          now,
          e.site_id,
        ),
      db
        .prepare(
          "UPDATE attack_mode SET active_until = NULL, previous_level = NULL, activated_at = NULL, updated_at = ? WHERE site_id = ?",
        )
        .bind(now, e.site_id),
      db
        .prepare(
          "UPDATE attack_mode_events SET ended_at = ? WHERE site_id = ? AND source = 'auto' AND ended_at IS NULL",
        )
        .bind(now, e.site_id),
    );
  }
  writes.push(
    ...(await notify(
      ctx,
      expired.map((e) => ({ ...e, id: e.site_id })),
      (site) => ({
        subject: `Attack mode is off for ${siteLabel(site)}`,
        text: `The automatic attack-mode period for ${siteLabel(site)} ended. The bot filter is back to its previous level.`,
        key: `attack-off:${site.id}:${now}`,
      }),
    )),
  );

  const candidates = (candRes?.results ?? []) as Candidate[];
  const nextBots: Record<string, { day: string; hits: number }> = {};
  const activated: Array<Candidate & { detection: Detection }> = [];
  if (candidates.length) {
    const utcToday = new Date(now).toISOString().slice(0, 10);
    const reads = candidates.flatMap((c) => {
      const localToday = localDate(now, c.timezone);
      return [
        db
          .prepare(
            `SELECT
               (SELECT COALESCE(SUM(hits), 0) FROM bot_daily WHERE site_id = ?1 AND day = ?2) AS today_hits,
               (SELECT COALESCE(SUM(hits), 0) FROM bot_daily WHERE site_id = ?1 AND day >= ?3 AND day < ?2) AS week_hits,
               (SELECT COUNT(*) FROM sessions WHERE site_id = ?1 AND started_at >= ?4 AND started_at < ?5) AS sessions,
               (SELECT COUNT(*) FROM sessions WHERE site_id = ?1 AND started_at >= ?4 AND started_at < ?5
                  AND pageviews <= 1 AND interactions = 0 AND last_seen_at - started_at < 1000) AS suspicious,
               (SELECT COALESCE(SUM(sessions), 0) FROM daily_stats WHERE site_id = ?1 AND day >= ?6 AND day < ?7) AS week_sessions,
               (SELECT COUNT(*) FROM daily_stats WHERE site_id = ?1 AND day >= ?6 AND day < ?7) AS rollup_days`,
          )
          .bind(
            c.site_id,
            utcToday,
            addDays(utcToday, -7),
            now - SESSION_WINDOW_MS,
            now,
            addDays(localToday, -7),
            localToday,
          ),
      ];
    });
    const results = await db.batch(reads);
    candidates.forEach((c, i) => {
      const r = (results[i]?.results?.[0] ?? {}) as Record<string, number>;
      const todayHits = Number(r.today_hits ?? 0);
      const prev = state.bots?.[c.site_id];
      nextBots[c.site_id] = { day: utcToday, hits: todayHits };
      const botDelta =
        prev && prev.day === utcToday ? todayHits - prev.hits : prev ? todayHits : null;
      const days = Number(r.rollup_days ?? 0);
      const detection = detect(c, {
        botDelta,
        botBaselinePerWindow: Number(r.week_hits ?? 0) / ((7 * DAY_MS) / DETECT_WINDOW_MS),
        sessions: Number(r.sessions ?? 0),
        suspicious: Number(r.suspicious ?? 0),
        sessionBaselinePerWindow:
          days > 0 ? Number(r.week_sessions ?? 0) / ((days * DAY_MS) / SESSION_WINDOW_MS) : 0,
      });
      if (detection && c.bot_level !== "strict") activated.push({ ...c, detection });
    });
  }
  for (const a of activated) {
    const until = now + a.duration_minutes * 60_000;
    writes.push(
      db
        .prepare(
          "UPDATE sites SET bot_level = 'strict', updated_at = ? WHERE id = ? AND bot_level != 'strict'",
        )
        .bind(now, a.site_id),
      db
        .prepare(
          "UPDATE attack_mode SET active_until = ?, previous_level = ?, activated_at = ?, updated_at = ? WHERE site_id = ?",
        )
        .bind(until, a.bot_level, now, now, a.site_id),
      db
        .prepare(
          `INSERT INTO attack_mode_events (id, site_id, source, reason, details, started_at)
           VALUES (?, ?, 'auto', ?, ?, ?)`,
        )
        .bind(newId(now), a.site_id, a.detection.reason, JSON.stringify(a.detection.details), now),
    );
  }
  writes.push(
    ...(await notify(
      ctx,
      activated.map((a) => ({ ...a, id: a.site_id })),
      (site) => {
        const a = activated.find((x) => x.site_id === site.id);
        const why =
          a?.detection.reason === "bot_spike"
            ? `${a.detection.details.botHits5m} bot requests were blocked in the last 5 minutes (usually about ${a.detection.details.baseline5m}).`
            : `${a?.detection.details.sessions15m} sessions in the last 15 minutes, ${a?.detection.details.botLikeShare}% of them bot-like.`;
        return {
          subject: `Attack mode is on for ${siteLabel(site)}`,
          text: `DataGoat detected abnormal traffic on ${siteLabel(site)}: ${why} The strict bot filter is on for the next ${a?.duration_minutes ?? 0} minutes and switches off automatically.`,
          key: `attack-on:${site.id}:${now}`,
        };
      },
    )),
  );
  if (writes.length) await db.batch(writes);
  for (const id of [...expired.map((e) => e.site_id), ...activated.map((a) => a.site_id)]) {
    siteCache.invalidate(id);
  }
  const nextState: AttackDetectState = { bots: nextBots };
  if (JSON.stringify(nextState) !== JSON.stringify(state))
    ctx.setState(candidates.length ? nextState : null);
  return { activated: activated.map((a) => a.site_id), expired: expired.map((e) => e.site_id) };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export const attackRoutes = new Hono<AppEnv>();
const PATH = "/api/v1/admin/websites/:websiteId/bot-traffic/attack-mode";

async function attackDto(db: D1Database, siteId: string, botLevel: string) {
  const [settingsRes, eventsRes] = await db.batch([
    db.prepare("SELECT * FROM attack_mode WHERE site_id = ?").bind(siteId),
    db
      .prepare(
        "SELECT * FROM attack_mode_events WHERE site_id = ? ORDER BY started_at DESC LIMIT 20",
      )
      .bind(siteId),
  ]);
  const s = (settingsRes?.results?.[0] as AttackSettingsRow | undefined) ?? null;
  return {
    enabled: botLevel === "strict",
    autoEnable: s ? s.auto_enable === 1 : false,
    multiplier: s?.multiplier ?? 5,
    minHits: s?.min_hits ?? 100,
    durationMinutes: s?.duration_minutes ?? 240,
    autoActiveUntil: toIsoOrNull(s?.active_until ?? null),
    events: ((eventsRes?.results ?? []) as Array<Record<string, unknown>>).map((e) => ({
      id: String(e.id),
      source: e.source as "auto" | "manual",
      reason: String(e.reason),
      details: parseJsonColumn<Record<string, unknown>>(e.details, {}),
      startedAt: toIsoOrNull(Number(e.started_at)),
      endedAt: toIsoOrNull((e.ended_at as number | null) ?? null),
    })),
  };
}

attackRoutes.get(PATH, requireSiteAccess("settings:read", { param: "websiteId" }), async (c) => {
  const { site } = getAccess(c);
  return success(c, [await attackDto(c.env.DB, site.id, site.botLevel)]);
});

const AttackBody = z
  .object({
    enabled: z.boolean().optional(),
    autoEnable: z.boolean().optional(),
    multiplier: z.number().min(2).max(100).optional(),
    minHits: z.number().int().min(10).max(1_000_000).optional(),
    durationMinutes: z
      .number()
      .int()
      .min(15)
      .max(7 * 24 * 60)
      .optional(),
  })
  .strict();

attackRoutes.put(PATH, requireSiteAccess("settings:write", { param: "websiteId" }), async (c) => {
  const { site } = getAccess(c);
  const body = await parseJsonBody(c, AttackBody, { maxBytes: 4096 });
  const now = Date.now();
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO attack_mode (site_id, auto_enable, multiplier, min_hits, duration_minutes, updated_at)
         VALUES (?1, COALESCE(?2, 0), COALESCE(?3, 5), COALESCE(?4, 100), COALESCE(?5, 240), ?6)
         ON CONFLICT (site_id) DO UPDATE SET auto_enable = COALESCE(?2, auto_enable),
           multiplier = COALESCE(?3, multiplier), min_hits = COALESCE(?4, min_hits),
           duration_minutes = COALESCE(?5, duration_minutes), updated_at = ?6`,
      )
      .bind(
        site.id,
        body.autoEnable === undefined ? null : body.autoEnable ? 1 : 0,
        body.multiplier ?? null,
        body.minHits ?? null,
        body.durationMinutes ?? null,
        now,
      ),
  ];
  let level = site.botLevel;
  if (body.enabled === true && site.botLevel !== "strict") {
    level = "strict";
    stmts.push(
      db
        .prepare("UPDATE sites SET bot_level = 'strict', updated_at = ? WHERE id = ?")
        .bind(now, site.id),
      db
        .prepare("UPDATE attack_mode SET previous_level = ? WHERE site_id = ?")
        .bind(site.botLevel, site.id),
      db
        .prepare(
          "INSERT INTO attack_mode_events (id, site_id, source, reason, details, started_at) VALUES (?, ?, 'manual', 'manual', '{}', ?)",
        )
        .bind(newId(now), site.id, now),
    );
  } else if (body.enabled === false && site.botLevel === "strict") {
    const row = await db
      .prepare("SELECT previous_level FROM attack_mode WHERE site_id = ?")
      .bind(site.id)
      .first<{ previous_level: string | null }>();
    level =
      row?.previous_level && row.previous_level !== "strict"
        ? (row.previous_level as typeof level)
        : "standard";
    stmts.push(
      db
        .prepare("UPDATE sites SET bot_level = ?, updated_at = ? WHERE id = ?")
        .bind(level, now, site.id),
      db
        .prepare(
          "UPDATE attack_mode SET active_until = NULL, previous_level = NULL, activated_at = NULL WHERE site_id = ?",
        )
        .bind(site.id),
      db
        .prepare(
          "UPDATE attack_mode_events SET ended_at = ? WHERE site_id = ? AND ended_at IS NULL",
        )
        .bind(now, site.id),
    );
  }
  await db.batch(stmts);
  siteCache.invalidate(site);
  return success(c, [await attackDto(db, site.id, level)]);
});
