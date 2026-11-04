/**
 * `alerts.evaluate` (every minute): goal-completed and new-sale alerts.
 *
 * Each run rescans the last few minutes of goal events (`events_time` index) and newly stored
 * payments for the sites that have enabled alerts, and enqueues one outbox row per (alert, event)
 * with a dedupe key. Overlapping windows and overlapping cron invocations are therefore harmless:
 * a notification is stored and delivered once. No cursor is persisted, so an idle minute costs one
 * small read of `alerts` and no writes.
 *
 * Rate limiting: at most PER_RUN_CAP new notifications per alert per run, and ALERT_DAILY_LIMIT
 * (default 100) per alert per UTC day; when the daily limit is hit, one "limit reached" notice
 * is sent instead and the rest of the day's events are skipped.
 */
import type { JobContext } from "../../jobs/registry";
import { countryName } from "../../lib/countries";
import { chunk } from "../../lib/d1";
import type { Site } from "../../lib/sites";
import { enqueueStatement, type OutboxItem } from "../delivery/outbox";
import { formatMoney, type TemplateVars } from "../delivery/templates";
import { ownerEmailsBySite, publicUrl } from "../shared/site-info";
import { type AlertRow, triggerOf } from "./model";
import { alertLimit, baseVars, buildPayload, siteLabel } from "./notify";

export const EVAL_WINDOW_MS = 3 * 60_000;
/** Payments stored now but dated earlier than this are backfills, not new sales. */
export const SALE_MAX_AGE_MS = 2 * 86_400_000;
export const PER_RUN_CAP = 10;
const ROWS_PER_SITE = 100;

const SESSION_COLS = `se.country, se.city, se.region, se.device, se.browser, se.os, se.source,
  se.referrer_domain, se.channel, se.utm_source, se.utm_campaign`;

type Joined = AlertRow & { site_row: string };
export type SiteLite = Pick<Site, "id" | "name" | "domain" | "timezone" | "currency">;

interface EventRow {
  id: number;
  ts: number;
  name: string;
  visitor_id: string;
  path: string | null;
  [k: string]: unknown;
}

interface SaleRow {
  id: string;
  kind: "payment" | "renewal" | "free_trial";
  reporting_minor: number;
  reporting_currency: string;
  visitor_id: string | null;
  occurred_at: number;
  [k: string]: unknown;
}

export function sessionVars(r: Record<string, unknown>): TemplateVars {
  const code = typeof r.country === "string" ? r.country : null;
  const referrer =
    (r.source as string | null) ?? (r.referrer_domain as string | null) ?? "Direct / None";
  return {
    country: code ? countryName(code) : "Unknown",
    city: (r.city as string | null) ?? "",
    region: (r.region as string | null) ?? "",
    device: (r.device as string | null) ?? "",
    browser: (r.browser as string | null) ?? "",
    os: (r.os as string | null) ?? "",
    referrer,
    source: (r.source as string | null) ?? "",
    channel: (r.channel as string | null) ?? "",
    utm_source: (r.utm_source as string | null) ?? "",
    utm_campaign: (r.utm_campaign as string | null) ?? "",
  };
}

const dayStart = (ms: number) => Math.floor(ms / 86_400_000) * 86_400_000;

export async function evaluateEventAlerts(ctx: Pick<JobContext, "db" | "env" | "now">) {
  const { db, now } = ctx;
  const res = await db
    .prepare(
      `SELECT a.*, json_object('id', s.id, 'domain', s.domain, 'name', s.name, 'timezone', s.timezone,
          'currency', s.currency) AS site_row
       FROM alerts a JOIN sites s ON s.id = a.site_id AND s.deleted_at IS NULL
       WHERE a.is_enabled = 1 AND a.trigger_type IN ('goal', 'new_sale')`,
    )
    .all<Joined>();
  const alerts = res.results ?? [];
  if (alerts.length === 0) return { enqueued: 0 };

  const bySite = new Map<string, { site: SiteLite; goal: Joined[]; sale: Joined[] }>();
  for (const a of alerts) {
    let entry = bySite.get(a.site_id);
    if (!entry) {
      entry = { site: JSON.parse(a.site_row) as SiteLite, goal: [], sale: [] };
      bySite.set(a.site_id, entry);
    }
    if (a.trigger_type === "goal") entry.goal.push(a);
    else entry.sale.push(a);
  }

  const from = now - EVAL_WINDOW_MS;
  const reads: D1PreparedStatement[] = [];
  const plan: Array<{ siteId: string; kind: "goal" | "sale" }> = [];
  for (const [siteId, entry] of bySite) {
    const names = [
      ...new Set(entry.goal.map((a) => triggerOf(a).goalName).filter(Boolean)),
    ] as string[];
    if (names.length) {
      reads.push(
        db
          .prepare(
            `SELECT e.id, e.ts, e.name, e.visitor_id, e.path, ${SESSION_COLS}
             FROM events e LEFT JOIN sessions se ON se.site_id = e.site_id AND se.id = e.session_id
             WHERE e.site_id = ? AND e.ts >= ? AND e.ts <= ? AND e.type = 'custom'
               AND e.name IN (${names.map(() => "?").join(", ")})
             ORDER BY e.ts LIMIT ${ROWS_PER_SITE}`,
          )
          .bind(siteId, from, now, ...names.slice(0, 90)),
      );
      plan.push({ siteId, kind: "goal" });
    }
    if (entry.sale.length) {
      reads.push(
        db
          .prepare(
            `SELECT p.id, p.kind, p.reporting_minor, p.reporting_currency, p.visitor_id, p.occurred_at, ${SESSION_COLS}
             FROM payments p LEFT JOIN sessions se ON se.site_id = p.site_id
               AND se.id = COALESCE(p.last_session_id, p.first_session_id)
             WHERE p.site_id = ? AND p.occurred_at >= ? AND p.created_at >= ? AND p.created_at <= ?
               AND p.kind IN ('payment', 'renewal', 'free_trial')
             ORDER BY p.created_at LIMIT ${ROWS_PER_SITE}`,
          )
          .bind(siteId, now - SALE_MAX_AGE_MS, from, now),
      );
      plan.push({ siteId, kind: "sale" });
    }
  }
  const results: D1Result[] = [];
  for (const group of chunk(reads, 50)) results.push(...(await db.batch(group)));
  // results follow `plan`.
  const found = new Map<string, { goal: EventRow[]; sale: SaleRow[] }>();
  plan.forEach((p, i) => {
    const rows = (results[i]?.results ?? []) as unknown[];
    const entry = found.get(p.siteId) ?? { goal: [], sale: [] };
    if (p.kind === "goal") entry.goal = rows as EventRow[];
    else entry.sale = rows as SaleRow[];
    found.set(p.siteId, entry);
  });
  const sitesWithMatches = [...found.entries()].filter(([, f]) => f.goal.length || f.sale.length);
  if (sitesWithMatches.length === 0) return { enqueued: 0 };

  const [base, owners] = await Promise.all([
    publicUrl(db),
    ownerEmailsBySite(
      db,
      sitesWithMatches.map(([id]) => id),
    ),
  ]);
  const limit = alertLimit(ctx.env);
  const today = dayStart(now);
  const items: OutboxItem[] = [];
  type Candidate = {
    alert: Joined;
    key: string;
    vars: TemplateVars;
    summary: string;
    visitorId: string | null;
    goal: string | null;
  };
  const perSite: Array<{
    siteId: string;
    site: SiteLite;
    recipients: string[];
    candidates: Candidate[];
  }> = [];

  for (const [siteId, f] of sitesWithMatches) {
    const entry = bySite.get(siteId);
    if (!entry) continue;
    const { site } = entry;
    const recipients = owners.get(siteId) ?? [];
    const candidates: Candidate[] = [];
    for (const alert of entry.goal) {
      const goal = triggerOf(alert).goalName;
      for (const ev of f.goal.filter((e) => e.name === goal)) {
        candidates.push({
          alert,
          key: `goal:${alert.id}:${ev.id}`,
          vars: {
            ...baseVars(site, base, "goals"),
            ...sessionVars(ev),
            goal: ev.name,
            page: ev.path ?? "",
            visitor_id: ev.visitor_id,
            time: new Date(ev.ts).toISOString(),
          },
          summary: `${ev.name}${sessionVars(ev).country ? ` from ${sessionVars(ev).country}` : ""}`,
          visitorId: ev.visitor_id,
          goal: ev.name,
        });
      }
    }
    for (const alert of entry.sale) {
      const t = triggerOf(alert);
      for (const p of f.sale) {
        if (p.kind === "renewal" && t.includeRenewals === false) continue;
        if (p.kind === "free_trial" && !t.includeFreeTrials) continue;
        const amount = formatMoney(p.reporting_minor, p.reporting_currency || site.currency);
        const kind = p.kind === "free_trial" ? "free trial" : p.kind;
        candidates.push({
          alert,
          key: `sale:${alert.id}:${p.id}`,
          vars: {
            ...baseVars(site, base, "revenue"),
            ...sessionVars(p),
            amount,
            currency: p.reporting_currency,
            kind,
            visitor_id: p.visitor_id ?? "",
            time: new Date(p.occurred_at).toISOString(),
          },
          summary: `${kind} ${amount}`,
          visitorId: p.visitor_id,
          goal: null,
        });
      }
    }

    perSite.push({ siteId, site, recipients, candidates });
  }

  // Skip events already enqueued by an earlier (overlapping) run, so they do not use up the cap.
  const keys = perSite.flatMap((p) => p.candidates.map((c) => c.key));
  const existing = new Set<string>();
  if (keys.length) {
    const res = await db.batch(
      chunk(keys, 90).map((part) =>
        db
          .prepare(
            `SELECT dedupe_key FROM outbox WHERE dedupe_key IN (${part.map(() => "?").join(", ")})`,
          )
          .bind(...part),
      ),
    );
    for (const r of res)
      for (const row of (r.results ?? []) as Array<{ dedupe_key: string }>)
        existing.add(row.dedupe_key);
  }

  for (const { siteId, site, recipients, candidates } of perSite) {
    const perAlert = new Map<string, number>();
    for (const cand of candidates) {
      if (existing.has(cand.key)) continue;
      const a = cand.alert;
      const usedToday = a.daily_count_reset_at === today ? a.daily_count : 0;
      const n = perAlert.get(a.id) ?? 0;
      if (n >= PER_RUN_CAP) continue;
      if (usedToday + n >= limit) {
        const notice = buildPayload(a, site, baseVars(site, base, "alerts"), recipients, {
          summary: "Daily notification limit reached",
          visitorId: null,
          goalName: null,
          text: `The alert "${a.name}" reached its limit of ${limit} notifications today on ${siteLabel(site)}. Further events today are not sent; counting resumes tomorrow (UTC).`,
        });
        if (notice) {
          items.push({
            siteId,
            payload: notice,
            dedupeKey: `limit:${a.id}:${new Date(today).toISOString().slice(0, 10)}`,
          });
        }
        perAlert.set(a.id, PER_RUN_CAP);
        continue;
      }
      const payload = buildPayload(a, site, cand.vars, recipients, {
        summary: cand.summary,
        visitorId: cand.visitorId,
        goalName: cand.goal,
      });
      if (!payload) continue;
      items.push({ siteId, payload, dedupeKey: cand.key });
      perAlert.set(a.id, n + 1);
    }
  }
  if (items.length === 0) return { enqueued: 0 };
  let enqueued = 0;
  for (const group of chunk(items, 50)) {
    const out = await db.batch(group.map((item) => enqueueStatement(db, item, now)));
    enqueued += out.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  }
  return { enqueued };
}
