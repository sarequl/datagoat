/**
 * `alerts.traffic-spike` (hourly at :03): traffic-spike alert rules and DataFast's "viral traffic
 * alerts" website setting (emails the owners).
 *
 * The hour that just closed is compared with the trailing hourly average (plan §15: alert at four
 * times the average by default). The baseline comes from W2's `daily_stats` rollup for the last 7
 * closed days (7 rows read); when a site has no rollup yet, the previous 24 hours of sessions are
 * counted instead. Notifications carry the hour in their dedupe key, so they are sent once.
 */
import type { JobContext } from "../../jobs/registry";
import { chunk } from "../../lib/d1";
import { addDays, HOUR_MS, localDate } from "../../lib/time";
import { emailConfigured } from "../delivery/email";
import { enqueueStatement, type OutboxItem } from "../delivery/outbox";
import { emailLayout, textToHtml } from "../delivery/templates";
import { ownerEmailsBySite, publicUrl } from "../shared/site-info";
import type { SiteLite } from "./evaluate";
import {
  type AlertRow,
  DEFAULT_SPIKE_MIN_SESSIONS,
  DEFAULT_SPIKE_MULTIPLIER,
  triggerOf,
} from "./model";
import { baseVars, buildPayload, siteLabel } from "./notify";

const MAX_SITES_PER_RUN = 25;

export interface SpikeReading {
  current: number;
  hourlyAverage: number;
  ratio: number;
}

export function isSpike(reading: SpikeReading, multiplier: number, minSessions: number): boolean {
  return (
    reading.current >= minSessions &&
    reading.current >= multiplier * Math.max(1, reading.hourlyAverage)
  );
}

export async function evaluateTrafficSpikes(ctx: Pick<JobContext, "db" | "env" | "now">) {
  const { db, now } = ctx;
  const hourEnd = Math.floor(now / HOUR_MS) * HOUR_MS;
  const hourStart = hourEnd - HOUR_MS;
  const [alertsRes, viralRes] = await db.batch([
    db.prepare(
      `SELECT a.* FROM alerts a JOIN sites s ON s.id = a.site_id AND s.deleted_at IS NULL
       WHERE a.is_enabled = 1 AND a.trigger_type = 'traffic_spike'`,
    ),
    db.prepare(
      "SELECT id, domain, name, timezone, currency FROM sites WHERE send_viral_traffic_alerts = 1 AND deleted_at IS NULL",
    ),
  ]);
  const alerts = (alertsRes?.results ?? []) as AlertRow[];
  const viral = (viralRes?.results ?? []) as SiteLite[];
  const siteIds = [...new Set([...alerts.map((a) => a.site_id), ...viral.map((s) => s.id)])].slice(
    0,
    MAX_SITES_PER_RUN,
  );
  if (siteIds.length === 0) return { checked: 0, enqueued: 0 };

  // Site rows for alert-only sites, plus the readings, in one batch.
  const sitesRes = await db
    .prepare(
      `SELECT id, domain, name, timezone, currency FROM sites WHERE id IN (${siteIds.map(() => "?").join(", ")})`,
    )
    .bind(...siteIds)
    .all<SiteLite>();
  const sites = new Map((sitesRes.results ?? []).map((s) => [s.id, s]));
  const readStmts = siteIds.map((id) => {
    const site = sites.get(id);
    const today = localDate(now, site?.timezone ?? "UTC");
    return db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sessions WHERE site_id = ?1 AND started_at >= ?2 AND started_at < ?3) AS current,
           (SELECT COALESCE(SUM(sessions), 0) FROM daily_stats WHERE site_id = ?1 AND day >= ?4 AND day < ?5) AS rollup_sessions,
           (SELECT COUNT(*) FROM daily_stats WHERE site_id = ?1 AND day >= ?4 AND day < ?5) AS rollup_days`,
      )
      .bind(id, hourStart, hourEnd, addDays(today, -7), today);
  });
  const readings = new Map<string, { current: number; sum: number; days: number }>();
  const readResults = await db.batch(readStmts);
  siteIds.forEach((id, i) => {
    const r = (readResults[i]?.results?.[0] ?? {}) as Record<string, number>;
    readings.set(id, {
      current: Number(r.current ?? 0),
      sum: Number(r.rollup_sessions ?? 0),
      days: Number(r.rollup_days ?? 0),
    });
  });
  // Fallback baseline (previous 24 h of sessions) only for sites with traffic and no rollups.
  const needFallback = siteIds.filter((id) => {
    const r = readings.get(id);
    return r && r.days === 0 && r.current > 0;
  });
  const fallback = new Map<string, number>();
  if (needFallback.length) {
    const res = await db.batch(
      needFallback.map((id) =>
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ?",
          )
          .bind(id, hourStart - 24 * HOUR_MS, hourStart),
      ),
    );
    needFallback.forEach((id, i) => {
      fallback.set(id, Number((res[i]?.results?.[0] as { n?: number } | undefined)?.n ?? 0));
    });
  }
  const reading = (id: string): SpikeReading => {
    const r = readings.get(id) ?? { current: 0, sum: 0, days: 0 };
    const avg = r.days > 0 ? r.sum / (r.days * 24) : (fallback.get(id) ?? 0) / 24;
    return {
      current: r.current,
      hourlyAverage: avg,
      ratio: avg > 0 ? r.current / avg : r.current,
    };
  };

  const firing = siteIds.filter((id) => reading(id).current > 0);
  if (firing.length === 0) return { checked: siteIds.length, enqueued: 0 };
  const [base, owners] = await Promise.all([publicUrl(db), ownerEmailsBySite(db, firing)]);
  const hourKey = new Date(hourStart).toISOString().slice(0, 13);
  const items: OutboxItem[] = [];

  for (const alert of alerts) {
    const site = sites.get(alert.site_id);
    if (!site || !firing.includes(site.id)) continue;
    const t = triggerOf(alert);
    const r = reading(site.id);
    if (
      !isSpike(
        r,
        t.multiplier ?? DEFAULT_SPIKE_MULTIPLIER,
        t.minSessions ?? DEFAULT_SPIKE_MIN_SESSIONS,
      )
    )
      continue;
    const payload = buildPayload(
      alert,
      site,
      {
        ...baseVars(site, base),
        visitors: r.current,
        baseline: Math.round(r.ratio * 10) / 10,
        time: new Date(hourStart).toISOString(),
      },
      owners.get(site.id) ?? [],
      {
        summary: `${r.current} sessions in an hour (${Math.round(r.ratio * 10) / 10}x)`,
        visitorId: null,
        goalName: null,
        data: { ...r, hourStart: new Date(hourStart).toISOString() },
      },
    );
    if (payload)
      items.push({ siteId: site.id, payload, dedupeKey: `spike:${alert.id}:${hourKey}` });
  }

  if (emailConfigured(ctx.env)) {
    for (const site of viral) {
      if (!firing.includes(site.id)) continue;
      const r = reading(site.id);
      if (!isSpike(r, DEFAULT_SPIKE_MULTIPLIER, DEFAULT_SPIKE_MIN_SESSIONS)) continue;
      const to = owners.get(site.id) ?? [];
      if (to.length === 0) continue;
      const vars = baseVars(site, base);
      const ratio = Math.round(r.ratio * 10) / 10;
      const text = `${siteLabel(site)} is getting more traffic than usual: ${r.current} sessions in the last hour, about ${ratio}x the normal hourly average.`;
      items.push({
        siteId: site.id,
        dedupeKey: `viral:${site.id}:${hourKey}`,
        payload: {
          channel: "email",
          to,
          subject: `Traffic spike on ${siteLabel(site)}`,
          text: vars.dashboard_url ? `${text}\n\n${vars.dashboard_url}` : text,
          html: emailLayout({
            title: `Traffic spike on ${siteLabel(site)}`,
            bodyHtml: textToHtml(text),
            actionUrl: typeof vars.dashboard_url === "string" ? vars.dashboard_url : null,
            footer: "You receive this because viral traffic alerts are on for this website.",
          }),
        },
      });
    }
  }
  if (items.length === 0) return { checked: siteIds.length, enqueued: 0 };
  let enqueued = 0;
  for (const group of chunk(items, 50)) {
    const res = await db.batch(group.map((item) => enqueueStatement(db, item, now)));
    enqueued += res.reduce((n, x) => n + (x.meta.changes ?? 0), 0);
  }
  return { checked: siteIds.length, enqueued };
}
