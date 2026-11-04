/**
 * Realtime: visitors with pageview activity in the last 10 minutes (DataFast's window), and the
 * realtime map payload (active visitors with geo/system data and purchase-likelihood scores,
 * recent goal events and recent payments). Filters and date ranges do not apply.
 *
 * Cost: `realtime` is one indexed read of 10 minutes of events. The map is one batch (one D1
 * query): active visitors joined to their session, first session, profile and customer status
 * through primary keys and the `sessions_visitor` / `payments_visitor` indexes, recent activity
 * through `events_activity`, recent payments through `payments_time`, and the prediction model.
 */

import { parseJsonColumn } from "../lib/d1";
import { toMajor } from "../lib/money";
import { MINUTE_MS } from "../lib/time";
import { REFERRER_EXPR } from "./breakdowns";
import type { QueryContext } from "./context";
import { CUSTOMER_LIKELIHOOD, conversionLikelihood, rowToModel, scoreVisitor } from "./prediction";

export const REALTIME_WINDOW_MS = 10 * MINUTE_MS;
/** Recent goal events and payments shown next to the map. */
export const RECENT_ACTIVITY_MS = 60 * MINUTE_MS;
export const MAX_MAP_VISITORS = 500;

export async function realtimeVisitors(db: D1Database, siteId: string, now: number) {
  const n = await db
    .prepare(
      "SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE site_id = ? AND ts >= ? AND ts <= ? AND type = 'pageview'",
    )
    .bind(siteId, now - REALTIME_WINDOW_MS, now)
    .first<number>("n");
  return n ?? 0;
}

const PARAM_COLUMNS = [
  ["utm_source", "utm_source"],
  ["utm_medium", "utm_medium"],
  ["utm_campaign", "utm_campaign"],
  ["utm_term", "utm_term"],
  ["utm_content", "utm_content"],
  ["ref", "ref"],
  ["source", "source_param"],
  ["via", "via"],
] as const;

export async function realtimeMap(qc: QueryContext) {
  const { db, site, now } = qc;
  const since = now - REALTIME_WINDOW_MS;
  const recentSince = now - RECENT_ACTIVITY_MS;
  const paying = site.includeRenewalRevenue ? "('payment', 'renewal')" : "('payment')";
  const fsParams = PARAM_COLUMNS.map(([k, c]) => `fs.${c} AS p_${k}`).join(", ");
  const [visitorsRes, eventsRes, paymentsRes, modelRes, countRes] = await db.batch([
    db
      .prepare(
        `WITH a AS (
           SELECT visitor_id AS v, session_id AS sid, path, hostname, MAX(ts) AS last
           FROM events WHERE site_id = ?1 AND ts >= ?2 AND ts <= ?3 AND type = 'pageview'
           GROUP BY visitor_id ORDER BY last DESC LIMIT ${MAX_MAP_VISITORS})
         SELECT a.v, a.path, a.hostname, a.last, s.started_at, s.session_number, s.country, s.region,
           s.city, s.lat, s.lon, s.browser, s.os, s.device, s.channel,
           ${REFERRER_EXPR} AS referrer_label, s.referrer_domain, s.source,
           vis.user_id, vis.name AS profile_name, vis.image, ${fsParams},
           (SELECT COUNT(*) FROM sessions s2 WHERE s2.site_id = ?1 AND s2.visitor_id = a.v) AS visits,
           EXISTS (SELECT 1 FROM payments p INDEXED BY payments_visitor WHERE p.site_id = ?1 AND p.visitor_id = a.v
             AND p.kind IN ${paying}) AS is_customer,
           (SELECT p.customer_name FROM payments p INDEXED BY payments_visitor WHERE p.site_id = ?1 AND p.visitor_id = a.v
             AND p.customer_name IS NOT NULL ORDER BY p.occurred_at DESC LIMIT 1) AS customer_name,
           (SELECT p.customer_email FROM payments p INDEXED BY payments_visitor WHERE p.site_id = ?1 AND p.visitor_id = a.v
             AND p.customer_email IS NOT NULL ORDER BY p.occurred_at DESC LIMIT 1) AS customer_email
         FROM a
         LEFT JOIN sessions s ON s.site_id = ?1 AND s.id = a.sid
         LEFT JOIN visitors vis ON vis.site_id = ?1 AND vis.id = a.v
         LEFT JOIN sessions fs ON fs.site_id = ?1 AND fs.id = vis.first_session_id
         ORDER BY a.last DESC`,
      )
      .bind(site.id, since, now),
    db
      .prepare(
        `SELECT e.id, e.type, e.name, e.visitor_id, e.ts, e.path, e.props, s.country,
           ${REFERRER_EXPR} AS referrer_label, s.referrer_domain, s.source, vis.name AS profile_name
         FROM events e
         LEFT JOIN sessions s ON s.site_id = e.site_id AND s.id = e.session_id
         LEFT JOIN visitors vis ON vis.site_id = e.site_id AND vis.id = e.visitor_id
         WHERE e.site_id = ?1 AND e.type <> 'pageview' AND e.type = 'custom' AND e.ts >= ?2 AND e.ts <= ?3
         ORDER BY e.ts DESC LIMIT 50`,
      )
      .bind(site.id, recentSince, now),
    db
      .prepare(
        `SELECT id, kind, reporting_minor, reporting_currency, customer_name, customer_email, occurred_at
         FROM payments WHERE site_id = ?1 AND occurred_at >= ?2 AND occurred_at <= ?3
           AND kind IN ('payment', 'renewal')
         ORDER BY occurred_at DESC LIMIT 20`,
      )
      .bind(site.id, recentSince, now),
    db
      .prepare(
        "SELECT model, baseline_conversion_rate, baseline_average_value, sample_visitors, trained_at FROM prediction_models WHERE site_id = ?",
      )
      .bind(site.id),
    db
      .prepare(
        "SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE site_id = ? AND ts >= ? AND ts <= ? AND type = 'pageview'",
      )
      .bind(site.id, since, now),
  ]);
  const modelRow = modelRes?.results?.[0] as Record<string, unknown> | undefined;
  const model = modelRow ? rowToModel(modelRow) : null;
  const pii = qc.includePii;

  const visitors = ((visitorsRes?.results ?? []) as Array<Record<string, unknown>>).map((r) => {
    const isCustomer = Boolean(r.is_customer);
    const customerName = pii ? ((r.customer_name as string | null) ?? null) : null;
    const profileName = pii ? ((r.profile_name as string | null) ?? null) : null;
    const displayName = profileName ?? customerName;
    const params: Record<string, string | null> = {};
    for (const [k] of PARAM_COLUMNS) params[k] = (r[`p_${k}`] as string | null) ?? null;
    const hasReferrer = r.source !== null || r.referrer_domain !== null;
    const out: Record<string, unknown> = {
      visitorId: String(r.v),
      location: {
        city: (r.city as string | null) ?? null,
        region: (r.region as string | null) ?? null,
        countryCode: (r.country as string | null) ?? null,
      },
      system: {
        browser: r.browser ? { name: String(r.browser) } : null,
        os: r.os ? { name: String(r.os) } : null,
        device: r.device ? { type: String(r.device) } : null,
      },
      currentUrl: (r.path as string | null) ?? null,
      referrer: hasReferrer ? String(r.referrer_label) : null,
      sessionStartTime: r.started_at ? new Date(Number(r.started_at)).toISOString() : null,
      visitCount: Number(r.session_number ?? r.visits ?? 1),
      params,
      latitude: r.lat === null || r.lat === undefined ? null : Number(r.lat),
      longitude: r.lon === null || r.lon === undefined ? null : Number(r.lon),
      isCustomer,
      customerName,
      customerEmail: pii ? ((r.customer_email as string | null) ?? null) : null,
      profileData: {
        displayName,
        userId: (r.user_id as string | null) ?? null,
        ...(r.image ? { profileImage: String(r.image) } : {}),
        hasProfile: r.user_id !== null && r.user_id !== undefined,
        isRandomName: displayName === null,
      },
    };
    if (model) {
      out.conversionLikelihood = isCustomer
        ? CUSTOMER_LIKELIHOOD
        : conversionLikelihood(
            model,
            scoreVisitor(model, {
              channel: r.channel as string | null,
              referrer: r.referrer_label as string | null,
              country: r.country as string | null,
              device: r.device as string | null,
              browser: r.browser === "Mobile Safari" ? "Safari" : (r.browser as string | null),
              os: r.os as string | null,
            }),
          );
    }
    return out;
  });

  const recentEvents = ((eventsRes?.results ?? []) as Array<Record<string, unknown>>).map((r) => {
    const hasReferrer = r.source !== null || r.referrer_domain !== null;
    return {
      _id: String(r.id),
      type: (r.name as string | null) ?? (r.type as string | null) ?? null,
      visitorId: String(r.visitor_id),
      timestamp: new Date(Number(r.ts)).toISOString(),
      path: (r.path as string | null) ?? null,
      countryCode: (r.country as string | null) ?? null,
      extraData: parseJsonColumn<Record<string, unknown>>(r.props, {}),
      referrer: hasReferrer && r.referrer_label ? String(r.referrer_label) : null,
      customerName: null,
      amount: null,
      displayName: pii ? ((r.profile_name as string | null) ?? null) : null,
    };
  });

  const recentPayments = ((paymentsRes?.results ?? []) as Array<Record<string, unknown>>).map(
    (r) => ({
      _id: String(r.id),
      type: "payment_received" as const,
      timestamp: new Date(Number(r.occurred_at)).toISOString(),
      name: pii ? ((r.customer_name as string | null) ?? null) : null,
      email: pii ? ((r.customer_email as string | null) ?? null) : null,
      amount: toMajor(Number(r.reporting_minor), String(r.reporting_currency)),
      currency: String(r.reporting_currency),
      renewal: r.kind === "renewal",
      displayName: null,
      isNew: false,
      visible: true,
    }),
  );

  return {
    count: Math.max(
      visitors.length,
      Number((countRes?.results?.[0] as { n?: number } | undefined)?.n ?? 0),
    ),
    visitors,
    ...(model
      ? {
          conversionMetrics: {
            baselineConversionRate: model.baselineConversionRate,
            baselineAverageValue: model.baselineAverageValue,
          },
        }
      : {}),
    hasConversionPredictions: model !== null,
    recentEvents,
    recentPayments,
  };
}

// ---------------------------------------------------------------------------
// Globe replay
// ---------------------------------------------------------------------------

export const REPLAY_STEP_MS = 15 * MINUTE_MS;
export const REPLAY_FRAMES = 32;
export const MAX_REPLAY_VISITORS_PER_FRAME = 300;

/**
 * The last 8 hours of globe activity in 32 frames of 15 minutes (DataFast's globe replay): per
 * frame the visitors with pageviews in it (position from their session, customer flag and
 * purchase-likelihood score), and pageview, goal and payment counts. No PII.
 *
 * Cost: one batch: 8 hours of pageviews through `events_time` grouped by frame and visitor, the
 * frame's sessions by primary key, goals through `events_activity`, payments through
 * `payments_time`, and the prediction model.
 */
export async function realtimeReplay(qc: QueryContext) {
  const { db, site, now } = qc;
  const end = Math.floor(now / REPLAY_STEP_MS) * REPLAY_STEP_MS + REPLAY_STEP_MS;
  const start = end - REPLAY_FRAMES * REPLAY_STEP_MS;
  const paying = site.includeRenewalRevenue ? "('payment', 'renewal')" : "('payment')";
  const [visitorsRes, goalsRes, paymentsRes, modelRes] = await db.batch([
    db
      .prepare(
        `WITH a AS MATERIALIZED (
           SELECT CAST((ts - ?2) / ${REPLAY_STEP_MS} AS INTEGER) AS f, visitor_id AS v, session_id AS sid, COUNT(*) AS pv, MAX(ts) AS last
           FROM events WHERE site_id = ?1 AND ts >= ?2 AND ts < ?3 AND type = 'pageview'
           GROUP BY 1, 2)
         SELECT a.f, a.v, a.pv, s.lat, s.lon, s.country, s.city, s.channel, s.device, s.os,
           ${REFERRER_EXPR} AS referrer_label,
           CASE WHEN s.browser = 'Mobile Safari' THEN 'Safari' ELSE s.browser END AS browser,
           EXISTS (SELECT 1 FROM payments p INDEXED BY payments_visitor WHERE p.site_id = ?1
             AND p.visitor_id = a.v AND p.visitor_id IS NOT NULL AND p.kind IN ${paying}
             AND p.occurred_at < ?3) AS is_customer
         FROM a LEFT JOIN sessions s ON s.site_id = ?1 AND s.id = a.sid
         ORDER BY a.f, a.last DESC`,
      )
      .bind(site.id, start, end),
    db
      .prepare(
        `SELECT CAST((ts - ?2) / ${REPLAY_STEP_MS} AS INTEGER) AS f, COUNT(*) AS n FROM events
         WHERE site_id = ?1 AND type <> 'pageview' AND type = 'custom' AND ts >= ?2 AND ts < ?3 GROUP BY 1`,
      )
      .bind(site.id, start, end),
    db
      .prepare(
        `SELECT CAST((occurred_at - ?2) / ${REPLAY_STEP_MS} AS INTEGER) AS f, COUNT(*) AS n FROM payments
         WHERE site_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3 AND kind IN ${paying} GROUP BY 1`,
      )
      .bind(site.id, start, end),
    db
      .prepare(
        "SELECT model, baseline_conversion_rate, baseline_average_value, sample_visitors, trained_at FROM prediction_models WHERE site_id = ?",
      )
      .bind(site.id),
  ]);
  const modelRow = modelRes?.results?.[0] as Record<string, unknown> | undefined;
  const model = modelRow ? rowToModel(modelRow) : null;
  const frames = Array.from({ length: REPLAY_FRAMES }, (_, i) => ({
    at: new Date(start + i * REPLAY_STEP_MS).toISOString(),
    visitors: [] as Array<{
      visitorId: string;
      latitude: number | null;
      longitude: number | null;
      countryCode: string | null;
      city: string | null;
      isCustomer: boolean;
      conversionScore: number | null;
    }>,
    pageviews: 0,
    goals: 0,
    payments: 0,
  }));
  for (const r of (visitorsRes?.results ?? []) as Array<Record<string, unknown>>) {
    const frame = frames[Number(r.f)];
    if (!frame) continue;
    frame.pageviews += Number(r.pv ?? 0);
    if (frame.visitors.length >= MAX_REPLAY_VISITORS_PER_FRAME) continue;
    const isCustomer = Boolean(r.is_customer);
    let score: number | null = null;
    if (model) {
      score = isCustomer
        ? 100
        : scoreVisitor(model, {
            channel: r.channel as string | null,
            referrer: r.referrer_label as string | null,
            country: r.country as string | null,
            device: r.device as string | null,
            browser: r.browser as string | null,
            os: r.os as string | null,
          }).score;
    }
    frame.visitors.push({
      visitorId: String(r.v),
      latitude: r.lat === null || r.lat === undefined ? null : Number(r.lat),
      longitude: r.lon === null || r.lon === undefined ? null : Number(r.lon),
      countryCode: (r.country as string | null) ?? null,
      city: (r.city as string | null) ?? null,
      isCustomer,
      conversionScore: score,
    });
  }
  for (const r of (goalsRes?.results ?? []) as Array<{ f: number; n: number }>) {
    const frame = frames[Number(r.f)];
    if (frame) frame.goals = Number(r.n);
  }
  for (const r of (paymentsRes?.results ?? []) as Array<{ f: number; n: number }>) {
    const frame = frames[Number(r.f)];
    if (frame) frame.payments = Number(r.n);
  }
  return {
    stepMinutes: REPLAY_STEP_MS / MINUTE_MS,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    frames,
  };
}
