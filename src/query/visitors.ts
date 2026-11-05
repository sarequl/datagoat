/**
 * Visitors (DataFast `GET /visitors` and `GET /visitors/{id}`).
 *
 * List: visitors with sessions in the range matching DataFast's plain query parameters (and
 * `filter_*`), newest activity first. One statement over `sessions_time`, grouped by visitor.
 *
 * Detail: the visitor's sessions (`sessions_visitor`), goals and other non-pageview events
 * (`events_visitor_activity`), payments (`payments_visitor`), profile, and the pageview timeline
 * read per session by time range through `events_time`, so a profile never scans the site's
 * events.
 */

import { chunk, parseJsonColumn } from "../lib/d1";
import { ApiError } from "../lib/errors";
import { type FilterKey, type ParsedFilter, parseFilterValue } from "../lib/filters";
import { isUuidV4 } from "../lib/ids";
import { toMajor } from "../lib/money";
import { escapeLike, join, list, prepare, raw, type SqlFragment, sql } from "../lib/sql";
import { addDays, localDate } from "../lib/time";
import { normaliseGoalName } from "../lib/validate";
import { REFERRER_EXPR } from "./breakdowns";
import { ACTIVITY, type QueryContext, rangeOn, sessionScope, sessionsFrom } from "./context";
import { PAYMENT_GOALS } from "./event-breakdowns";
import { rowToModel, scoreVisitor } from "./prediction";
import { payingKindsSql } from "./revenue";

// ---------------------------------------------------------------------------
// List parameters
// ---------------------------------------------------------------------------

const ALIASES: Array<[string[], string]> = [
  [["visitedPage", "page"], "visitedPage"],
  [["visitedPageContains", "pageContains"], "visitedPageContains"],
  [["completedGoal", "goal"], "completedGoal"],
  [["visitCount", "visit_count"], "visitCount"],
  [["isCustomer", "hasRevenue"], "isCustomer"],
];

const DIMENSION_PARAMS: FilterKey[] = [
  "country",
  "region",
  "city",
  "browser",
  "os",
  "device",
  "referrer",
  "hostname",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
  "source",
  "via",
];

const COMMON = new Set(["websiteId", "limit", "offset", "startAt", "endAt", "timezone", "q"]);

export interface VisitorListParams {
  filters: ParsedFilter[];
  completedGoals: string[] | null;
  isCustomer: boolean;
  q: string | null;
}

function splitValues(name: string, value: string): string[] {
  const values = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (!values.length) throw new ApiError(400, `Invalid ${name}: missing value`);
  if (values.length > 50) throw new ApiError(400, `Invalid ${name}: at most 50 values`);
  return values;
}

/** Map DataFast's plain list parameters onto the filter compiler. Unknown parameters → 400. */
export function parseVisitorListParams(params: URLSearchParams): VisitorListParams {
  const seen = new Map<string, string>();
  for (const [key, value] of params) {
    if (key === "didNotCompleteGoal" || key === "goalNot") {
      throw new ApiError(400, `${key} is not supported`);
    }
    if (seen.has(key)) throw new ApiError(400, `Duplicate query parameter: ${key}`);
    seen.set(key, value);
  }
  const canonical = new Map<string, string>();
  for (const [key, value] of seen) {
    if (COMMON.has(key) || key.startsWith("filter_")) continue;
    const alias = ALIASES.find(([names]) => names.includes(key));
    const name = alias ? alias[1] : key;
    if (!alias && !(DIMENSION_PARAMS as string[]).includes(key)) {
      throw new ApiError(400, `Unsupported query parameter: ${key}`);
    }
    if (canonical.has(name)) throw new ApiError(400, `Use only one of ${alias?.[0].join(" or ")}`);
    canonical.set(name, value);
  }
  const filters: ParsedFilter[] = [];
  const page = canonical.get("visitedPage");
  if (page !== undefined) {
    filters.push({ key: "page", operator: "is", values: splitValues("visitedPage", page) });
  }
  const contains = canonical.get("visitedPageContains");
  if (contains !== undefined) {
    filters.push({
      key: "page",
      operator: "contains",
      values: splitValues("visitedPageContains", contains),
    });
  }
  const goal = canonical.get("completedGoal");
  let completedGoals: string[] | null = null;
  if (goal !== undefined) {
    completedGoals = splitValues("completedGoal", goal).map(normaliseGoalName);
    filters.push({ key: "goal", operator: "is", values: completedGoals });
  }
  const visitCount = canonical.get("visitCount");
  if (visitCount !== undefined) filters.push(parseFilterValue("visit_count", visitCount));
  for (const key of DIMENSION_PARAMS) {
    const v = canonical.get(key);
    if (v !== undefined) filters.push(parseFilterValue(key, v));
  }
  const customer = canonical.get("isCustomer");
  let isCustomer = false;
  if (customer !== undefined) {
    if (customer !== "true" && customer !== "false") {
      throw new ApiError(400, "isCustomer/hasRevenue must be true or false");
    }
    isCustomer = customer === "true";
  }
  if (isCustomer && completedGoals) {
    throw new ApiError(400, "completedGoal cannot be combined with isCustomer or hasRevenue");
  }
  const q = seen.get("q")?.trim() || null;
  if (q && q.length > 200) throw new ApiError(400, "q must be at most 200 characters");
  return { filters, completedGoals, isCustomer, q };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const ACQUISITION = [
  ["utm_source", "utm_source"],
  ["utm_medium", "utm_medium"],
  ["utm_campaign", "utm_campaign"],
  ["utm_term", "utm_term"],
  ["utm_content", "utm_content"],
  ["ref", "ref"],
  ["source", "source_param"],
  ["via", "via"],
] as const;

export function visitorType(sessionNumber: unknown): "new" | "returning" | null {
  if (sessionNumber === null || sessionNumber === undefined) return null;
  return Number(sessionNumber) < 2 ? "new" : "returning";
}

export async function listVisitors(
  qc: QueryContext,
  params: VisitorListParams,
  page: { limit: number; offset: number },
) {
  const site = qc.site;
  const extra: SqlFragment[] = [];
  if (params.isCustomer) {
    extra.push(
      sql`s.visitor_id IN (SELECT visitor_id FROM payments WHERE site_id = ${site.id}
        AND visitor_id IS NOT NULL AND kind IN ${raw(payingKindsSql(qc))})`,
    );
  }
  if (params.q) {
    const like = `%${escapeLike(params.q)}%`;
    const emailClause = qc.includePii ? sql` OR email LIKE ${like} ESCAPE '\\'` : raw("");
    extra.push(
      sql`(s.visitor_id = ${params.q} OR s.visitor_id IN (SELECT id FROM visitors WHERE site_id = ${site.id}
        AND (user_id = ${params.q} OR name LIKE ${like} ESCAPE '\\'${emailClause})))`,
    );
  }
  const extraSql = extra.length ? sql` AND ${join(extra)}` : raw("");
  const goalSeen = params.completedGoals
    ? sql`(SELECT MAX(e.ts) FROM events e INDEXED BY events_visitor_activity WHERE e.site_id = ${site.id} AND e.${raw(ACTIVITY)}
        AND e.visitor_id = g.v AND e.type = 'custom' AND e.name IN ${list(params.completedGoals)}
        AND ${rangeOn("e.ts", qc.range)})`
    : raw("g.last_seen");
  const acquisition = ACQUISITION.map(([k, c]) => `s.${c} AS a_${k}`).join(", ");
  const scope = sessionScope(qc);
  const grouped = sql`SELECT s.visitor_id AS v, MAX(s.last_seen_at) AS last_seen, s.session_number,
      s.hostname, s.exit_path, s.entry_path, s.country, s.region, s.city, s.browser, s.os, s.device,
      s.source, s.referrer_domain, ${raw(REFERRER_EXPR)} AS referrer_label, ${raw(acquisition)}
    FROM ${sessionsFrom(qc.range)} WHERE ${scope}${extraSql}
    GROUP BY s.visitor_id`;
  const res = await prepare(
    qc.db,
    sql`WITH g AS MATERIALIZED (${grouped})
      SELECT g.*, ${goalSeen} AS seen, COUNT(*) OVER () AS total_rows,
        vis.client_first_seen_at, vis.first_seen_at, vis.user_id, vis.name AS profile_name,
        (SELECT COALESCE(SUM(p.reporting_minor), 0) FROM payments p INDEXED BY payments_visitor WHERE p.site_id = ${site.id}
          AND p.visitor_id = g.v AND p.kind IN ('payment', 'renewal', 'refund')) AS revenue_minor
      FROM g LEFT JOIN visitors vis ON vis.site_id = ${site.id} AND vis.id = g.v
      ORDER BY seen DESC, g.v LIMIT ${page.limit} OFFSET ${page.offset}`,
  ).all<Record<string, unknown>>();
  const rows = res.results ?? [];
  let total = Number(rows[0]?.total_rows ?? 0);
  if (!rows.length && page.offset > 0) {
    total = Number(
      (await prepare(qc.db, sql`SELECT COUNT(*) AS n FROM (${grouped})`).first<number>("n")) ?? 0,
    );
  }
  const data = rows.map((r) => {
    const acq: Record<string, string | null> = {
      referrer: r.source !== null || r.referrer_domain !== null ? String(r.referrer_label) : null,
    };
    for (const [k] of ACQUISITION) acq[k] = (r[`a_${k}`] as string | null) ?? null;
    const path = (r.exit_path as string | null) ?? (r.entry_path as string | null);
    return {
      visitorId: String(r.v),
      lastSeenAt:
        r.seen === null || r.seen === undefined ? null : new Date(Number(r.seen)).toISOString(),
      visitorFirstSeenAt: isoOrNull(r.client_first_seen_at ?? r.first_seen_at),
      visitorSessionNumber: r.session_number === null ? null : Number(r.session_number),
      visitorType: visitorType(r.session_number),
      currentUrl: path ? `${r.hostname ?? ""}${path}` : null,
      identity: {
        country: (r.country as string | null) ?? null,
        region: (r.region as string | null) ?? null,
        city: (r.city as string | null) ?? null,
        browser: (r.browser as string | null) ?? null,
        os: (r.os as string | null) ?? null,
        device: (r.device as string | null) ?? null,
      },
      acquisition: acq,
      userId: (r.user_id as string | null) ?? null,
      displayName: qc.includePii ? ((r.profile_name as string | null) ?? null) : null,
      revenue: toMajor(Number(r.revenue_minor ?? 0), site.currency),
    };
  });
  return { data, total };
}

function isoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : new Date(Number(v)).toISOString();
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const COOKIELESS_ID = /^[0-9a-f]{16,64}$/i;

export function assertVisitorId(id: string, privacyMode: string): void {
  if (isUuidV4(id)) return;
  if (privacyMode !== "cookie" && COOKIELESS_ID.test(id)) return;
  throw new ApiError(400, "Invalid visitorId: must be a UUID v4");
}

const MAX_SESSIONS = 500;
const TIMELINE_SESSIONS = 50;
const MAX_PAGES = 1000;

function goalOrigin(name: string): {
  origin: "manual" | "payment_provider";
  type: "custom" | "payment" | "subscription_lifecycle";
} {
  if (!PAYMENT_GOALS.has(name)) return { origin: "manual", type: "custom" };
  return {
    origin: "payment_provider",
    type: name.startsWith("subscription_") ? "subscription_lifecycle" : "payment",
  };
}

/** Google sessions that get keyword guesses (newest first), one statement each in one batch. */
export const KEYWORD_SESSIONS = 10;
/** Days of Search Console data around the session day (GSC reports by day and lags). */
const KEYWORD_WINDOW_DAYS = 3;

/**
 * DataFast's "keyword probability" in journeys: for sessions that arrived from Google search,
 * the Search Console queries that brought clicks to the session's landing page around that day,
 * with each query's share of those clicks. Costs nothing when no session came from Google, and one
 * batched read (≤ 10 statements) otherwise; empty when Search Console is not connected.
 */
async function googleKeywords(
  qc: QueryContext,
  sessions: Array<Record<string, unknown>>,
): Promise<Map<string, Array<{ query: string; probability: number }>>> {
  const out = new Map<string, Array<{ query: string; probability: number }>>();
  const google = sessions
    .filter(
      (s) =>
        s.channel === "Organic Search" &&
        String(s.source ?? "").toLowerCase() === "google" &&
        typeof s.entry_path === "string",
    )
    .slice(0, KEYWORD_SESSIONS);
  if (!google.length) return out;
  const { db, site } = qc;
  const stmts = google.map((s) => {
    const day = localDate(Number(s.started_at), site.timezone);
    const host = String(s.hostname ?? site.domain);
    const path = String(s.entry_path).split(/[?#]/)[0] || "/";
    const alt = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : `${path}/`;
    const pages = [`https://${host}${path}`, `https://${host}${alt}`, `http://${host}${path}`];
    return db
      .prepare(
        `SELECT query, SUM(clicks) AS clicks, SUM(SUM(clicks)) OVER () AS total FROM gsc_daily
         WHERE site_id = ? AND day >= ? AND day <= ? AND query <> '' AND page IN (?, ?, ?)
         GROUP BY query HAVING SUM(clicks) > 0 ORDER BY clicks DESC LIMIT 3`,
      )
      .bind(
        site.id,
        addDays(day, -KEYWORD_WINDOW_DAYS),
        addDays(day, KEYWORD_WINDOW_DAYS),
        ...pages,
      );
  });
  const results = await db.batch(stmts);
  google.forEach((s, i) => {
    const rows = (results[i]?.results ?? []) as Array<{
      query: string;
      clicks: number;
      total: number;
    }>;
    if (!rows.length) return;
    out.set(
      String(s.id),
      rows.map((r) => ({
        query: String(r.query),
        probability:
          Number(r.total) > 0 ? Math.round((Number(r.clicks) / Number(r.total)) * 100) : 0,
      })),
    );
  });
  return out;
}

export async function visitorProfile(qc: QueryContext, visitorId: string) {
  const { db, site, now } = qc;
  const [sessionsRes, visitorRes, paymentsRes, eventsRes, modelRes] = await db.batch([
    db
      .prepare(
        `SELECT s.*, ${REFERRER_EXPR} AS referrer_label FROM sessions s
         WHERE s.site_id = ? AND s.visitor_id = ? ORDER BY s.started_at DESC LIMIT ${MAX_SESSIONS}`,
      )
      .bind(site.id, visitorId),
    db.prepare("SELECT * FROM visitors WHERE site_id = ? AND id = ?").bind(site.id, visitorId),
    db
      .prepare(
        "SELECT id, provider, kind, reporting_minor, reporting_currency, occurred_at FROM payments INDEXED BY payments_visitor WHERE site_id = ? AND visitor_id = ? ORDER BY occurred_at DESC LIMIT 500",
      )
      .bind(site.id, visitorId),
    db
      .prepare(
        `SELECT type, name, ts, path, hostname FROM events INDEXED BY events_visitor_activity
         WHERE site_id = ? AND visitor_id = ? AND ${ACTIVITY} ORDER BY ts DESC LIMIT 1000`,
      )
      .bind(site.id, visitorId),
    db
      .prepare(
        "SELECT model, baseline_conversion_rate, baseline_average_value, sample_visitors, trained_at FROM prediction_models WHERE site_id = ?",
      )
      .bind(site.id),
  ]);
  const sessions = (sessionsRes?.results ?? []) as Array<Record<string, unknown>>;
  if (!sessions.length) throw new ApiError(404, "No pageviews found for this visitor");
  const visitor = (visitorRes?.results?.[0] as Record<string, unknown> | undefined) ?? null;
  const payments = (paymentsRes?.results ?? []) as Array<Record<string, unknown>>;
  const activity = (eventsRes?.results ?? []) as Array<Record<string, unknown>>;

  // Pageview timeline: events of the latest sessions, by time range through events_time.
  const timelineSessions = sessions.slice(0, TIMELINE_SESSIONS);
  const pageStmts = chunk(timelineSessions, 30).map((group) => {
    const ranges = group.map(() => "(ts >= ? AND ts <= ? AND session_id = ?)").join(" OR ");
    return db
      .prepare(
        `SELECT ts, hostname, path FROM events WHERE site_id = ? AND type = 'pageview' AND (${ranges})`,
      )
      .bind(
        site.id,
        ...group.flatMap((s) => [Number(s.started_at), Number(s.last_seen_at), String(s.id)]),
      );
  });
  const pageResults = pageStmts.length ? await db.batch(pageStmts) : [];
  const pages = pageResults
    .flatMap((r) => (r.results ?? []) as Array<Record<string, unknown>>)
    .sort((a, b) => Number(b.ts) - Number(a.ts))
    .slice(0, MAX_PAGES);

  const keywords = await googleKeywords(qc, sessions);

  const latest = sessions[0] as Record<string, unknown>;
  const earliest = sessions[sessions.length - 1] as Record<string, unknown>;
  const firstSession =
    sessions.find((s) => s.id === visitor?.first_session_id) ??
    (earliest as Record<string, unknown>);
  const paying = new Set(site.includeRenewalRevenue ? ["payment", "renewal"] : ["payment"]);
  const isCustomer = payments.some((p) => paying.has(String(p.kind)));
  const firstSeen = Number(visitor?.first_seen_at ?? earliest.started_at);
  const params: Record<string, string | null> = {};
  for (const [k, c] of ACQUISITION) params[k] = (firstSession[c] as string | null) ?? null;
  const sessionNumber = latest.session_number === null ? 0 : Number(latest.session_number);
  const latestPath = (latest.exit_path as string | null) ?? (latest.entry_path as string | null);

  const completedGoals = activity
    .filter((e) => e.type === "custom" && e.name)
    .map((e) => ({
      name: String(e.name),
      ...goalOrigin(String(e.name)),
      timestamp: new Date(Number(e.ts)).toISOString(),
    }));

  // GitHub-style activity grid: events per local day (pageviews from sessions + other events).
  const grid = new Map<string, { events: number; goals: number }>();
  for (const s of sessions) {
    const day = localDate(Number(s.started_at), qc.timezone);
    const cell = grid.get(day) ?? { events: 0, goals: 0 };
    cell.events += Number(s.pageviews ?? 0);
    grid.set(day, cell);
  }
  for (const e of activity) {
    const day = localDate(Number(e.ts), qc.timezone);
    const cell = grid.get(day) ?? { events: 0, goals: 0 };
    cell.events += 1;
    if (e.type === "custom") cell.goals += 1;
    grid.set(day, cell);
  }

  const out: Record<string, unknown> = {
    visitorId,
    identity: {
      country: (latest.country as string | null) ?? null,
      countryCode: (latest.country as string | null) ?? null,
      region: (latest.region as string | null) ?? null,
      city: (latest.city as string | null) ?? null,
      params,
      adClickIds: parseJsonColumn<Record<string, string>>(firstSession.ad_click_ids, {}),
      browser: {
        name: (latest.browser as string | null) ?? null,
        version: (latest.browser_version as string | null) ?? null,
      },
      os: {
        name: (latest.os as string | null) ?? null,
        version: (latest.os_version as string | null) ?? null,
      },
      device: {
        type: (latest.device as string | null) ?? null,
        vendor: (latest.device_vendor as string | null) ?? null,
        model: (latest.device_model as string | null) ?? null,
      },
      viewport: {
        width:
          latest.viewport_width === null ? null : Number(latest.viewport_width ?? null) || null,
        height:
          latest.viewport_height === null ? null : Number(latest.viewport_height ?? null) || null,
      },
    },
    activity: {
      visitCount: sessions.length,
      visitorFirstSeenAt: isoOrNull(visitor?.client_first_seen_at ?? null),
      visitorSessionNumber: sessionNumber,
      visitorType: visitorType(latest.session_number),
      pageViewCount: sessions.reduce((n, s) => n + Number(s.pageviews ?? 0), 0),
      timeSinceFirstVisit: Math.max(0, now - firstSeen),
      timeSinceCurrentVisit: Math.max(0, now - Number(latest.started_at)),
      firstVisitAt: new Date(Number(earliest.started_at)).toISOString(),
      lastVisitAt: new Date(Number(latest.started_at)).toISOString(),
      currentUrl: latestPath ? `${latest.hostname ?? ""}${latestPath}` : null,
      completedGoals,
      visitedPages: pages.map((p) => ({
        url: `${p.hostname ?? ""}${p.path ?? ""}`,
        timestamp: new Date(Number(p.ts)).toISOString(),
      })),
    },
    sessions: sessions.map((s) => ({
      id: String(s.id),
      startedAt: new Date(Number(s.started_at)).toISOString(),
      endedAt: new Date(Number(s.last_seen_at)).toISOString(),
      channel: String(s.channel),
      referrer: s.source !== null || s.referrer_domain !== null ? String(s.referrer_label) : null,
      entryPath: String(s.entry_path),
      pageviews: Number(s.pageviews ?? 0),
      ...(keywords.has(String(s.id)) ? { searchKeywords: keywords.get(String(s.id)) } : {}),
    })),
    payments: payments.map((p) => ({
      id: String(p.id),
      amount: toMajor(Number(p.reporting_minor), String(p.reporting_currency)),
      currency: String(p.reporting_currency),
      kind: String(p.kind),
      provider: String(p.provider),
      timestamp: new Date(Number(p.occurred_at)).toISOString(),
    })),
    activityGrid: [...grid.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, c]) => ({ date, events: c.events, goals: c.goals })),
  };
  if (visitor?.user_id) {
    const metadata = parseJsonColumn<Record<string, unknown>>(visitor.profile, {});
    if (visitor.name && metadata.name === undefined) metadata.name = visitor.name;
    if (visitor.image && metadata.image === undefined) metadata.image = visitor.image;
    if (!qc.includePii) {
      delete metadata.email;
      delete metadata.name;
    }
    out.profile = {
      userId: String(visitor.user_id),
      metadata,
      identifiedAt: isoOrNull(visitor.identified_at) ?? new Date(firstSeen).toISOString(),
    };
  }
  const modelRow = modelRes?.results?.[0] as Record<string, unknown> | undefined;
  const model = modelRow ? rowToModel(modelRow) : null;
  if (model && !isCustomer) {
    const p = scoreVisitor(model, {
      channel: firstSession.channel as string | null,
      referrer: firstSession.referrer_label as string | null,
      country: firstSession.country as string | null,
      device: firstSession.device as string | null,
      browser:
        firstSession.browser === "Mobile Safari"
          ? "Safari"
          : (firstSession.browser as string | null),
      os: firstSession.os as string | null,
    });
    out.prediction = {
      score: p.score,
      conversionRate: p.conversionRate,
      expectedValue: p.expectedValue,
      confidence: p.confidence,
    };
  }
  return out;
}
