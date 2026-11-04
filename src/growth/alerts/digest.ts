/**
 * Digests and the weekly email report (plan §15).
 *
 * `alerts.digest` runs every 10 minutes and works through two queues:
 * - **daily**: `daily_digest` alert rules, from 07:00 UTC, covering the previous local day;
 * - **weekly**: on Mondays from 07:00 UTC, `weekly_digest` alert rules plus the owners of every
 *   website with "send weekly reports" on, covering the previous Monday–Sunday (local time) against
 *   the week before.
 *
 * Each run handles at most SITES_PER_RUN websites (one D1 batch each, aggregation done in SQL) and
 * stores a cursor in job state, so many websites spread over several runs within the Free plan's
 * per-invocation query and CPU limits. Every message has a dedupe key (alert/site + period), so a
 * restarted queue never sends twice.
 */
import type { JobContext } from "../../jobs/registry";
import { countryName } from "../../lib/countries";
import { paymentCountKinds, revenueKinds } from "../../lib/metrics";
import { addDays, DAY_MS, localDate, localParts, startOfDate } from "../../lib/time";
import { emailConfigured } from "../delivery/email";
import { enqueueStatement, type OutboxItem } from "../delivery/outbox";
import { emailLayout, escapeHtml, formatMoney } from "../delivery/templates";
import { ownerEmailsBySite, publicUrl } from "../shared/site-info";
import type { AlertRow } from "./model";
import { baseVars, buildPayload, siteLabel } from "./notify";

export const SITES_PER_RUN = 8;
const SEND_AFTER_MS = 7 * 3_600_000; // 07:00 UTC

export interface PeriodStats {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounces: number;
  durationSum: number;
  revenueMinor: number;
  payments: number;
}

export interface DigestReport {
  site: DigestSite;
  period: "daily" | "weekly";
  label: string;
  from: string;
  to: string;
  current: PeriodStats;
  previous: PeriodStats;
  channels: Array<{ name: string; visitors: number }>;
  referrers: Array<{ name: string; visitors: number }>;
  pages: Array<{ name: string; visitors: number; pageviews: number }>;
  countries: Array<{ name: string; visitors: number }>;
  dashboardUrl: string | null;
}

export interface DigestSite {
  id: string;
  domain: string;
  name: string | null;
  timezone: string;
  currency: string;
  include_renewal_revenue: number;
  send_weekly_reports: number;
}

const kinds = (list: string[]) => `(${list.map((k) => `'${k}'`).join(", ")})`;

function statsSql(includeRenewals: boolean): string {
  return `SELECT
    (SELECT COUNT(DISTINCT visitor_id) FROM sessions WHERE site_id = ?1 AND started_at >= ?2 AND started_at < ?3) AS visitors,
    (SELECT COUNT(*) FROM sessions WHERE site_id = ?1 AND started_at >= ?2 AND started_at < ?3) AS sessions,
    (SELECT COALESCE(SUM(pageviews), 0) FROM sessions WHERE site_id = ?1 AND started_at >= ?2 AND started_at < ?3) AS pageviews,
    (SELECT COALESCE(SUM(CASE WHEN pageviews + interactions <= 1 THEN 1 ELSE 0 END), 0) FROM sessions WHERE site_id = ?1 AND started_at >= ?2 AND started_at < ?3) AS bounces,
    (SELECT COALESCE(SUM(last_seen_at - started_at), 0) FROM sessions WHERE site_id = ?1 AND started_at >= ?2 AND started_at < ?3) AS duration_sum,
    (SELECT COALESCE(SUM(reporting_minor), 0) FROM payments WHERE site_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3 AND kind IN ${kinds(revenueKinds(includeRenewals))}) AS revenue_minor,
    (SELECT COUNT(*) FROM payments WHERE site_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3 AND kind IN ${kinds(paymentCountKinds(includeRenewals))}) AS payments`;
}

function toStats(r: Record<string, unknown> | undefined): PeriodStats {
  return {
    visitors: Number(r?.visitors ?? 0),
    sessions: Number(r?.sessions ?? 0),
    pageviews: Number(r?.pageviews ?? 0),
    bounces: Number(r?.bounces ?? 0),
    durationSum: Number(r?.duration_sum ?? 0),
    revenueMinor: Number(r?.revenue_minor ?? 0),
    payments: Number(r?.payments ?? 0),
  };
}

/** Period bounds in the site's timezone: the previous local day or the previous Mon–Sun week. */
export function digestPeriod(period: "daily" | "weekly", now: number, timezone: string) {
  const today = localDate(now, timezone);
  if (period === "daily") {
    const from = addDays(today, -1);
    return {
      from,
      to: from,
      startMs: startOfDate(from, timezone),
      endMs: startOfDate(today, timezone),
      lengthDays: 1,
    };
  }
  const weekday = localParts(now, timezone).weekday; // 1 = Monday
  const thisMonday = addDays(today, -(weekday - 1));
  const from = addDays(thisMonday, -7);
  return {
    from,
    to: addDays(thisMonday, -1),
    startMs: startOfDate(from, timezone),
    endMs: startOfDate(thisMonday, timezone),
    lengthDays: 7,
  };
}

export function buildReportStatements(
  db: D1Database,
  site: DigestSite,
  period: "daily" | "weekly",
  now: number,
): { stmts: D1PreparedStatement[]; bounds: ReturnType<typeof digestPeriod> } {
  const b = digestPeriod(period, now, site.timezone);
  const prevStart = startOfDate(addDays(b.from, -b.lengthDays), site.timezone);
  const sql = statsSql(site.include_renewal_revenue === 1);
  const range = [site.id, b.startMs, b.endMs] as const;
  return {
    bounds: b,
    stmts: [
      db.prepare(sql).bind(...range),
      db.prepare(sql).bind(site.id, prevStart, b.startMs),
      db
        .prepare(
          `SELECT channel AS name, COUNT(DISTINCT visitor_id) AS visitors FROM sessions
           WHERE site_id = ?1 AND started_at >= ?2 AND started_at < ?3 GROUP BY channel ORDER BY visitors DESC LIMIT 5`,
        )
        .bind(...range),
      db
        .prepare(
          `SELECT COALESCE(source, referrer_domain) AS name, COUNT(DISTINCT visitor_id) AS visitors FROM sessions
           WHERE site_id = ?1 AND started_at >= ?2 AND started_at < ?3 AND COALESCE(source, referrer_domain) IS NOT NULL
           GROUP BY 1 ORDER BY visitors DESC LIMIT 5`,
        )
        .bind(...range),
      db
        .prepare(
          `SELECT path AS name, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS pageviews FROM events
           WHERE site_id = ?1 AND ts >= ?2 AND ts < ?3 AND type = 'pageview' GROUP BY path ORDER BY visitors DESC LIMIT 5`,
        )
        .bind(...range),
      db
        .prepare(
          `SELECT country AS name, COUNT(DISTINCT visitor_id) AS visitors FROM sessions
           WHERE site_id = ?1 AND started_at >= ?2 AND started_at < ?3 AND country IS NOT NULL
           GROUP BY country ORDER BY visitors DESC LIMIT 5`,
        )
        .bind(...range),
    ],
  };
}

export function reportFromResults(
  site: DigestSite,
  period: "daily" | "weekly",
  bounds: ReturnType<typeof digestPeriod>,
  results: D1Result[],
  base: string | null,
): DigestReport {
  const rows = (i: number) => (results[i]?.results ?? []) as Array<Record<string, unknown>>;
  const named = (i: number) =>
    rows(i).map((r) => ({ name: String(r.name ?? "(none)"), visitors: Number(r.visitors ?? 0) }));
  return {
    site,
    period,
    label: period === "daily" ? bounds.from : `${bounds.from} – ${bounds.to}`,
    from: bounds.from,
    to: bounds.to,
    current: toStats(rows(0)[0]),
    previous: toStats(rows(1)[0]),
    channels: named(2),
    referrers: named(3),
    pages: rows(4).map((r) => ({
      name: String(r.name ?? "/"),
      visitors: Number(r.visitors ?? 0),
      pageviews: Number(r.pageviews ?? 0),
    })),
    countries: named(5).map((c) => ({ ...c, name: countryName(c.name) })),
    dashboardUrl: base ? `${base}/app/${site.id}/overview` : null,
  };
}

function change(cur: number, prev: number): string {
  if (prev === 0) return cur === 0 ? "0%" : "new";
  const pct = ((cur - prev) / prev) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`;
}

function kpis(r: DigestReport) {
  const c = r.current;
  const p = r.previous;
  const bounce = (s: PeriodStats) => (s.sessions ? Math.round((s.bounces / s.sessions) * 100) : 0);
  const dur = (s: PeriodStats) => (s.sessions ? Math.round(s.durationSum / s.sessions / 1000) : 0);
  return [
    { label: "Visitors", value: String(c.visitors), change: change(c.visitors, p.visitors) },
    { label: "Pageviews", value: String(c.pageviews), change: change(c.pageviews, p.pageviews) },
    {
      label: "Revenue",
      value: formatMoney(c.revenueMinor, r.site.currency),
      change: change(c.revenueMinor, p.revenueMinor),
    },
    { label: "Payments", value: String(c.payments), change: change(c.payments, p.payments) },
    { label: "Bounce rate", value: `${bounce(c)}%`, change: change(bounce(c), bounce(p)) },
    { label: "Avg. session", value: `${dur(c)}s`, change: change(dur(c), dur(p)) },
  ];
}

export function renderReportText(r: DigestReport): string {
  const title = `${r.period === "daily" ? "Daily" : "Weekly"} report for ${siteLabel(r.site)} (${r.label})`;
  const lines = [title, ""];
  const vs = r.period === "daily" ? "vs previous day" : "vs previous week";
  for (const k of kpis(r)) lines.push(`${k.label}: ${k.value} (${k.change} ${vs})`);
  const section = (name: string, list: Array<{ name: string; visitors: number }>) => {
    if (list.length === 0) return;
    lines.push("", `${name}:`);
    for (const item of list) lines.push(`  ${item.name} — ${item.visitors} visitors`);
  };
  section("Top channels", r.channels);
  section("Top referrers", r.referrers);
  section("Top pages", r.pages);
  section("Top countries", r.countries);
  if (r.dashboardUrl) lines.push("", r.dashboardUrl);
  return lines.join("\n");
}

export function renderReportHtml(r: DigestReport, footer: string): string {
  const vs = r.period === "daily" ? "vs previous day" : "vs previous week";
  const kpiCells = kpis(r)
    .map(
      (k) =>
        `<td style="padding:8px;border:1px solid rgba(0,0,0,.06);vertical-align:top"><div style="color:#5c5c5c;font-size:12px">${escapeHtml(k.label)}</div><div style="font-size:18px;font-weight:600">${escapeHtml(k.value)}</div><div style="font-size:12px;color:${k.change.startsWith("-") ? "#c8202b" : "#00754c"}">${escapeHtml(k.change)} ${vs}</div></td>`,
    )
    .reduce<string[]>((rows, cell, i) => {
      if (i % 3 === 0) rows.push("");
      rows[rows.length - 1] += cell;
      return rows;
    }, [])
    .map((row) => `<tr>${row}</tr>`)
    .join("");
  const table = (name: string, list: Array<{ name: string; visitors: number }>) =>
    list.length === 0
      ? ""
      : `<h2 style="font-size:15px;margin:20px 0 6px">${escapeHtml(name)}</h2><table style="width:100%;border-collapse:collapse;font-size:14px">${list
          .map(
            (i) =>
              `<tr><td style="padding:4px 0;border-bottom:1px solid rgba(0,0,0,.06)">${escapeHtml(i.name)}</td><td style="padding:4px 0;text-align:right;border-bottom:1px solid rgba(0,0,0,.06)">${i.visitors}</td></tr>`,
          )
          .join("")}</table>`;
  const body = `<p style="margin:0 0 12px;color:#5c5c5c">${escapeHtml(r.label)}</p><table style="width:100%;border-collapse:collapse">${kpiCells}</table>${table("Top channels", r.channels)}${table("Top referrers", r.referrers)}${table("Top pages", r.pages)}${table("Top countries", r.countries)}`;
  return emailLayout({
    title: `${r.period === "daily" ? "Daily" : "Weekly"} report for ${siteLabel(r.site)}`,
    bodyHtml: body,
    actionUrl: r.dashboardUrl,
    footer,
  });
}

interface QueueState {
  key: string;
  cursor: string;
  done: boolean;
}

export interface DigestState {
  daily?: QueueState;
  weekly?: QueueState;
}

const SITE_COLS =
  "s.id, s.domain, s.name, s.timezone, s.currency, s.include_renewal_revenue, s.send_weekly_reports";

async function runQueue(
  ctx: Pick<JobContext, "db" | "env" | "now">,
  period: "daily" | "weekly",
  key: string,
  state: QueueState | undefined,
): Promise<QueueState> {
  const { db, now } = ctx;
  const current = state && state.key === key ? state : { key, cursor: "", done: false };
  if (current.done) return current;
  const triggerType = period === "daily" ? "daily_digest" : "weekly_digest";
  const emailOk = emailConfigured(ctx.env);
  const weeklyReports = period === "weekly" && emailOk ? "OR s.send_weekly_reports = 1" : "";
  const sitesRes = await db
    .prepare(
      `SELECT ${SITE_COLS} FROM sites s WHERE s.deleted_at IS NULL AND s.id > ?1
         AND (EXISTS (SELECT 1 FROM alerts a WHERE a.site_id = s.id AND a.is_enabled = 1 AND a.trigger_type = ?2) ${weeklyReports})
       ORDER BY s.id LIMIT ${SITES_PER_RUN + 1}`,
    )
    .bind(current.cursor, triggerType)
    .all<DigestSite>();
  const all = sitesRes.results ?? [];
  const sites = all.slice(0, SITES_PER_RUN);
  if (sites.length === 0) return { ...current, done: true };
  const ids = sites.map((s) => s.id);
  const [alertsRes, base, owners] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM alerts WHERE is_enabled = 1 AND trigger_type = ? AND site_id IN (${ids.map(() => "?").join(", ")})`,
      )
      .bind(triggerType, ...ids)
      .all<AlertRow>(),
    publicUrl(db),
    ownerEmailsBySite(db, ids),
  ]);
  const alerts = alertsRes.results ?? [];
  const items: OutboxItem[] = [];
  const reads = sites.map((site) => buildReportStatements(db, site, period, now));
  const flat = reads.flatMap((r) => r.stmts);
  const results = await db.batch(flat);
  let offset = 0;
  sites.forEach((site, i) => {
    const read = reads[i];
    if (!read) return;
    const slice = results.slice(offset, offset + read.stmts.length);
    offset += read.stmts.length;
    const report = reportFromResults(site, period, read.bounds, slice, base);
    const text = renderReportText(report);
    const recipients = owners.get(site.id) ?? [];
    for (const alert of alerts.filter((a) => a.site_id === site.id)) {
      const payload = buildPayload(
        alert,
        site,
        { ...baseVars(site, base), summary: text },
        recipients,
        {
          summary: `${period === "daily" ? "Daily" : "Weekly"} digest ${report.label}`,
          visitorId: null,
          goalName: null,
          text,
          html: renderReportHtml(report, `You receive this because of the alert "${alert.name}".`),
          data: report,
        },
      );
      if (payload) {
        items.push({ siteId: site.id, payload, dedupeKey: `${period}:${alert.id}:${report.from}` });
      }
    }
    if (period === "weekly" && emailOk && site.send_weekly_reports === 1 && recipients.length) {
      items.push({
        siteId: site.id,
        dedupeKey: `weekly-report:${site.id}:${report.from}`,
        payload: {
          channel: "email",
          to: recipients,
          subject: `Weekly report for ${siteLabel(site)}: ${report.current.visitors} visitors`,
          text,
          html: renderReportHtml(
            report,
            "You receive this because weekly reports are on for this website. Turn them off in its settings.",
          ),
        },
      });
    }
  });
  if (items.length) await db.batch(items.map((item) => enqueueStatement(db, item, now)));
  const last = sites[sites.length - 1]?.id ?? current.cursor;
  return { key, cursor: last, done: all.length <= SITES_PER_RUN };
}

/** Week key = the UTC date of this week's Monday. */
export function weekKey(now: number): string {
  const day = Math.floor(now / DAY_MS);
  const isoDay = ((day + 3) % 7) + 1;
  return new Date((day - (isoDay - 1)) * DAY_MS).toISOString().slice(0, 10);
}

export async function runDigests(
  ctx: Pick<JobContext, "db" | "env" | "now" | "state" | "setState">,
): Promise<DigestState> {
  const state = (ctx.state ?? {}) as DigestState;
  const next: DigestState = { ...state };
  const dayMs = ctx.now % DAY_MS;
  if (dayMs >= SEND_AFTER_MS) {
    const dayKey = new Date(ctx.now).toISOString().slice(0, 10);
    next.daily = await runQueue(ctx, "daily", dayKey, state.daily);
    const isMonday = ((Math.floor(ctx.now / DAY_MS) + 3) % 7) + 1 === 1;
    if (isMonday) next.weekly = await runQueue(ctx, "weekly", weekKey(ctx.now), state.weekly);
  }
  if (JSON.stringify(next) !== JSON.stringify(state)) ctx.setState(next);
  return next;
}
