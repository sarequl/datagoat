/**
 * `GET /api/v1/mentions` (DataFast docs/api/website/mentions/list) and `GET /api/v1/x/links` (DG:
 * visitors, revenue and payments per X post or link-in-bio profile that sent traffic through t.co).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Mention, XLinkRow } from "../../../shared/api-types";
import { getAccess } from "../../auth/context";
import { requireSiteAccess } from "../../auth/middleware";
import { parseJsonColumn } from "../../lib/d1";
import { compileFilters, parseFilters } from "../../lib/filters";
import { attributionColumn, paymentCountKinds, revenueKinds } from "../../lib/metrics";
import { toMajor } from "../../lib/money";
import { paginationOf, success } from "../../lib/response";
import { prepare, raw, sql } from "../../lib/sql";
import { lastNDays, parseRange, toIso } from "../../lib/time";
import { parsePagination, parseQuery } from "../../lib/validate";
import type { AppEnv } from "../../types";

export const mentionRoutes = new Hono<AppEnv>();

const MentionsQuery = z.object({
  websiteId: z.string().optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  timezone: z.string().optional(),
  q: z.string().max(200).optional(),
  platform: z.enum(["x", "reddit"]).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
});

function mentionDto(r: Record<string, unknown>): Mention {
  const platform = r.platform as "x" | "reddit";
  const m: Mention = {
    id: String(r.id),
    websiteId: String(r.site_id),
    platform,
    timestamp: toIso(Number(r.ts)),
    text: String(r.text),
    url: String(r.url),
    author: {
      name: (r.author_name as string | null) ?? null,
      username: (r.author_username as string | null) ?? null,
      image: (r.author_image as string | null) ?? null,
    },
    engagement: parseJsonColumn<Record<string, number>>(r.engagement, {}),
  };
  if (platform === "x") {
    m.media = parseJsonColumn<unknown[]>(r.media, []);
    m.isRetweet = r.is_retweet === 1;
  } else if (r.subreddit) {
    m.subreddit = String(r.subreddit);
  }
  return m;
}

mentionRoutes.get("/api/v1/mentions", requireSiteAccess("analytics:read"), async (c) => {
  const { site } = getAccess(c);
  const q = parseQuery(c, MentionsQuery, { strict: true });
  const { limit, offset } = parsePagination(q, { max: 1000 });
  const range =
    parseRange(q, site.timezone, (tz, now) => lastNDays(30, tz, now)) ??
    lastNDays(30, site.timezone);
  const base = sql`site_id = ${site.id} AND ts >= ${range.startMs} AND ts < ${range.endMs} AND relevant = 1`;
  let where = base;
  if (q.platform) where = sql`${where} AND platform = ${q.platform}`;
  const term = q.q?.trim().toLowerCase();
  if (term) {
    where = sql`${where} AND instr(lower(text || ' ' || COALESCE(author_name, '') || ' ' || COALESCE(author_username, '') || ' ' || url || ' ' || COALESCE(subreddit, '')), ${term}) > 0`;
  }
  const order = raw(q.order === "asc" ? "ASC" : "DESC");
  const db = c.env.DB;
  const [rows, filtered, all] = await db.batch([
    prepare(
      db,
      sql`SELECT * FROM mentions WHERE ${where} ORDER BY ts ${order}, id ${order} LIMIT ${limit} OFFSET ${offset}`,
    ),
    prepare(db, sql`SELECT COUNT(*) AS n FROM mentions WHERE ${where}`),
    prepare(db, sql`SELECT COUNT(*) AS n FROM mentions WHERE ${base}`),
  ]);
  const total = Number((filtered?.results?.[0] as { n?: number })?.n ?? 0);
  return success(c, ((rows?.results ?? []) as Record<string, unknown>[]).map(mentionDto), {
    pagination: paginationOf(limit, offset, total),
    extra: {
      meta: {
        totalMentions: Number((all?.results?.[0] as { n?: number })?.n ?? 0),
        sampled: false,
        mentionLimit: null,
        timezone: range.timezone,
        startAt: toIso(range.startMs),
        endAt: toIso(range.endMs - 1),
      },
    },
  });
});

const XLinksQuery = z.object({
  websiteId: z.string().optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  timezone: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

/** SQL normalising a stored referrer to the `https://t.co/<code>` form used by `x_links`. */
const TCO_SQL = `rtrim(replace(substr(s.referrer, 1, CASE WHEN instr(s.referrer, '?') > 0 THEN instr(s.referrer, '?') - 1 ELSE length(s.referrer) END), 'http://', 'https://'), '/')`;

mentionRoutes.get("/api/v1/x/links", requireSiteAccess("analytics:read"), async (c) => {
  const { site } = getAccess(c);
  const q = parseQuery(c, XLinksQuery, { strict: true, allowPrefixes: ["filter_"] });
  const { limit, offset } = parsePagination(q, { max: 1000 });
  const range =
    parseRange(q, site.timezone, (tz, now) => lastNDays(30, tz, now)) ??
    lastNDays(30, site.timezone);
  const filters = compileFilters(parseFilters(new URL(c.req.url).searchParams), {
    siteId: site.id,
    range,
  });
  const attr = raw(attributionColumn(site.attributionModel));
  const rev = raw(
    `(${revenueKinds(site.includeRenewalRevenue)
      .map((k) => `'${k}'`)
      .join(", ")})`,
  );
  const counted = raw(
    `(${paymentCountKinds(site.includeRenewalRevenue)
      .map((k) => `'${k}'`)
      .join(", ")})`,
  );
  const tco = raw(TCO_SQL);
  const stmt = sql`WITH xs AS (
      SELECT s.id, s.visitor_id, COALESCE(x.tweet_id, x.tweet_url, x.tco_url) AS k,
        x.tweet_id, x.tweet_url, x.author_username, x.text
      FROM sessions s LEFT JOIN x_links x ON x.site_id = s.site_id AND x.tco_url = ${tco}
      WHERE s.site_id = ${site.id} AND s.started_at >= ${range.startMs} AND s.started_at < ${range.endMs}
        AND s.referrer_domain IN ('t.co', 'x.com', 'twitter.com', 'mobile.twitter.com') AND ${filters}
    ),
    v AS (
      SELECT k, MAX(tweet_id) AS tweet_id, MAX(tweet_url) AS tweet_url, MAX(author_username) AS author_username,
        MAX(text) AS text, COUNT(DISTINCT visitor_id) AS visitors
      FROM xs GROUP BY k
    ),
    r AS (
      SELECT xs.k, COALESCE(SUM(CASE WHEN p.kind IN ${rev} THEN p.reporting_minor ELSE 0 END), 0) AS revenue_minor,
        COALESCE(SUM(CASE WHEN p.kind IN ${counted} THEN 1 ELSE 0 END), 0) AS payments
      FROM payments p JOIN xs ON xs.id = p.${attr}
      WHERE p.site_id = ${site.id} AND p.occurred_at >= ${range.startMs} AND p.occurred_at < ${range.endMs}
      GROUP BY xs.k
    )
    SELECT v.*, COALESCE(r.revenue_minor, 0) AS revenue_minor, COALESCE(r.payments, 0) AS payments,
      COUNT(*) OVER () AS total_rows
    FROM v LEFT JOIN r ON r.k IS v.k
    ORDER BY v.visitors DESC, revenue_minor DESC LIMIT ${limit} OFFSET ${offset}`;
  const res = await prepare(c.env.DB, stmt).all<Record<string, unknown>>();
  const rows = res.results ?? [];
  const data: XLinkRow[] = rows.map((r) => ({
    tweetId: (r.tweet_id as string | null) ?? null,
    tweetUrl: (r.tweet_url as string | null) ?? null,
    authorUsername: (r.author_username as string | null) ?? null,
    text: (r.text as string | null) ?? null,
    visitors: Number(r.visitors ?? 0),
    revenue: toMajor(Number(r.revenue_minor ?? 0), site.currency),
    payments: Number(r.payments ?? 0),
  }));
  const total = Number(rows[0]?.total_rows ?? 0);
  return success(c, data, { pagination: paginationOf(limit, offset, total) });
});
