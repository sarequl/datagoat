/**
 * Bot traffic API (DataFast docs/api/website/bot-traffic): summary, requested pages, account
 * usage, settings with the crawler catalog, and the `dfbot_` request token.
 */
import { Hono } from "hono";
import { z } from "zod";
import type {
  BotCrawlerCount,
  BotTokenStatus,
  BotTrafficPage,
  BotTrafficSettings,
  BotTrafficSummary,
} from "../../../shared/api-types";
import { getAccess, getAuth } from "../../auth/context";
import { requireAccountAccess, requireSiteAccess } from "../../auth/middleware";
import { ApiError } from "../../lib/errors";
import { success } from "../../lib/response";
import type { Site } from "../../lib/sites";
import { escapeLike } from "../../lib/sql";
import {
  bucketKeySql,
  DAY_MS,
  type DateRange,
  enumerateBuckets,
  type Interval,
  lastNDays,
  localDate,
  parseRange,
  toIso,
} from "../../lib/time";
import { parseJsonBody, parseQuery } from "../../lib/validate";
import type { AppEnv } from "../../types";
import { CATEGORIES, COMPANIES, CRAWLERS, CRAWLERS_BY_ID, type CrawlerCategory } from "./catalog";
import {
  crawlerCatalog,
  displayBotToken,
  hashBotToken,
  invalidateBotConfig,
  loadBotConfig,
  newBotToken,
  normaliseSettings,
  saveSettingsStatement,
} from "./settings";
import { allowanceOf, pendingUsage, periodOf, storedUsage } from "./usage";

export const botRoutes = new Hono<AppEnv>();
const W = "/api/v1/admin/websites/:websiteId";
const OWNER = { param: "websiteId", allowSiteKey: false, minRole: "owner" } as const;

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

const BaseQuery = z.object({
  websiteId: z.string().optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  timezone: z.string().optional(),
  interval: z.enum(["hour", "day", "week", "month"]).optional(),
  category: z.enum(["all", ...CATEGORIES] as [string, ...string[]]).default("all"),
  verification: z.enum(["all", "ip_verified", "user_agent_only"]).default("all"),
  company: z.string().max(100).default("all"),
  crawlerId: z.string().max(200).optional(),
});

const PagesQuery = BaseQuery.extend({
  pageSearch: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

interface Resolved {
  range: DateRange;
  interval: Interval;
  category: string;
  verification: string;
  company: string;
  crawlerId: string | null;
  /** SQL predicate on bot_traffic (alias-free) and its parameters. */
  where: string;
  params: unknown[];
}

export function inferInterval(range: DateRange): Interval {
  const days = (range.endMs - range.startMs) / DAY_MS;
  if (days <= 2) return "hour";
  if (days <= 120) return "day";
  if (days <= 400) return "week";
  return "month";
}

function resolve(site: Site, q: z.output<typeof BaseQuery>): Resolved {
  const range =
    parseRange(q, site.timezone, (tz, now) => lastNDays(30, tz, now)) ??
    lastNDays(30, site.timezone);
  if (q.company !== "all" && !COMPANIES.includes(q.company)) {
    throw new ApiError(400, `Unknown company: ${q.company}`);
  }
  if (q.crawlerId && !CRAWLERS_BY_ID.has(q.crawlerId)) {
    throw new ApiError(400, `Unknown crawlerId: ${q.crawlerId}`);
  }
  const ids = CRAWLERS.filter(
    (c) =>
      (q.category === "all" || c.category === q.category) &&
      (q.company === "all" || c.company === q.company) &&
      (!q.crawlerId || c.id === q.crawlerId),
  ).map((c) => c.id);
  const parts = ["site_id = ?", "hour >= ?", "hour < ?"];
  const params: unknown[] = [site.id, range.startMs, range.endMs];
  const filtered = q.category !== "all" || q.company !== "all" || Boolean(q.crawlerId);
  if (filtered) {
    if (ids.length === 0) parts.push("1 = 0");
    else {
      parts.push(`crawler_id IN (${ids.map(() => "?").join(", ")})`);
      params.push(...ids);
    }
  }
  if (q.verification !== "all")
    parts.push(`verified = ${q.verification === "ip_verified" ? 1 : 0}`);
  return {
    range,
    interval: q.interval ?? inferInterval(range),
    category: q.category,
    verification: q.verification,
    company: q.company,
    crawlerId: q.crawlerId ?? null,
    where: parts.join(" AND "),
    params,
  };
}

function crawlerMeta(id: string): {
  company: string;
  userAgent: string;
  category: CrawlerCategory;
} {
  const def = CRAWLERS_BY_ID.get(id);
  if (def) return { company: def.company, userAgent: def.userAgent, category: def.category };
  const [company = "Unknown", userAgent = id, category = "ai_crawler"] = id.split("::");
  return { company, userAgent, category: category as CrawlerCategory };
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 10000) / 100 : 0);

function crawlerCounts(
  rows: Array<{ crawler_id: string; verified: number; n: number }>,
): BotCrawlerCount[] {
  const map = new Map<string, BotCrawlerCount>();
  for (const r of rows) {
    const meta = crawlerMeta(r.crawler_id);
    const e = map.get(r.crawler_id) ?? {
      id: r.crawler_id,
      ...meta,
      requestCount: 0,
      ipVerifiedRequests: 0,
      userAgentOnlyRequests: 0,
    };
    e.requestCount += Number(r.n);
    if (r.verified) e.ipVerifiedRequests = (e.ipVerifiedRequests ?? 0) + Number(r.n);
    else e.userAgentOnlyRequests = (e.userAgentOnlyRequests ?? 0) + Number(r.n);
    map.set(r.crawler_id, e);
  }
  return [...map.values()].sort(
    (a, b) => b.requestCount - a.requestCount || a.id.localeCompare(b.id),
  );
}

function bindAll(stmt: D1PreparedStatement, params: unknown[]) {
  return params.length ? stmt.bind(...params) : stmt;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export async function botSummary(
  db: D1Database,
  site: Site,
  r: Resolved,
): Promise<BotTrafficSummary> {
  const bucket = bucketKeySql("hour", r.interval, r.range.timezone, r.range.startMs, r.range.endMs);
  const [byCrawler, series] = await db.batch([
    bindAll(
      db.prepare(
        `SELECT crawler_id, verified, SUM(requests) AS n FROM bot_traffic WHERE ${r.where} GROUP BY crawler_id, verified`,
      ),
      r.params,
    ),
    bindAll(
      db.prepare(
        `SELECT ${bucket.sql} AS k, crawler_id, verified, SUM(requests) AS n FROM bot_traffic WHERE ${r.where}
         GROUP BY k, crawler_id, verified`,
      ),
      r.params,
    ),
  ]);
  const crawlers = crawlerCounts(
    (byCrawler?.results ?? []) as Array<{ crawler_id: string; verified: number; n: number }>,
  );
  const total = crawlers.reduce((s, c) => s + c.requestCount, 0);
  for (const c of crawlers) c.percentage = pct(c.requestCount, total);
  const byCat = (cat: CrawlerCategory) =>
    crawlers.filter((c) => c.category === cat).reduce((s, c) => s + c.requestCount, 0);
  const companies = new Map<string, BotTrafficSummary["companies"][number]>();
  for (const c of crawlers) {
    const e = companies.get(c.company) ?? {
      company: c.company,
      requestCount: 0,
      aiAnswerRequests: 0,
      ipVerifiedRequests: 0,
      percentage: 0,
    };
    e.requestCount += c.requestCount;
    if (c.category === "answer_fetch") e.aiAnswerRequests += c.requestCount;
    e.ipVerifiedRequests += c.ipVerifiedRequests ?? 0;
    companies.set(c.company, e);
  }
  const companyList = [...companies.values()]
    .map((c) => ({ ...c, percentage: pct(c.requestCount, total) }))
    .sort((a, b) => b.requestCount - a.requestCount);

  const buckets = new Map<
    number,
    { requestCount: number; aiAnswerRequests: number; ipVerifiedRequests: number }
  >();
  for (const row of (series?.results ?? []) as Array<{
    k: number | string;
    crawler_id: string;
    verified: number;
    n: number;
  }>) {
    const start = bucket.keyToStart(row.k);
    const e = buckets.get(start) ?? { requestCount: 0, aiAnswerRequests: 0, ipVerifiedRequests: 0 };
    e.requestCount += Number(row.n);
    if (crawlerMeta(row.crawler_id).category === "answer_fetch")
      e.aiAnswerRequests += Number(row.n);
    if (row.verified) e.ipVerifiedRequests += Number(row.n);
    buckets.set(start, e);
  }
  const timeseries = enumerateBuckets(
    r.range.startMs,
    r.range.endMs,
    r.interval,
    r.range.timezone,
  ).map((start) => ({
    date: r.interval === "hour" ? toIso(start) : localDate(start, r.range.timezone),
    ...(buckets.get(start) ?? { requestCount: 0, aiAnswerRequests: 0, ipVerifiedRequests: 0 }),
  }));
  const verified = crawlers.reduce((s, c) => s + (c.ipVerifiedRequests ?? 0), 0);
  return {
    websiteId: site.id,
    domain: site.domain,
    range: {
      startAt: toIso(r.range.startMs),
      endAt: toIso(r.range.endMs - 1),
      timezone: r.range.timezone,
      interval: r.interval,
    },
    filters: {
      category: r.category,
      verification: r.verification,
      company: r.company,
      crawlerId: r.crawlerId,
    },
    totalRequests: total,
    aiAnswerRequests: byCat("answer_fetch"),
    indexingRequests: byCat("search_index"),
    trainingRequests: byCat("training"),
    otherCrawlerRequests: byCat("ai_crawler"),
    ipVerifiedRequests: verified,
    userAgentOnlyRequests: total - verified,
    companies: companyList,
    crawlers,
    timeseries,
  };
}

botRoutes.get("/api/v1/analytics/bot-traffic", requireSiteAccess("analytics:read"), async (c) => {
  const { site } = getAccess(c);
  const q = parseQuery(c, BaseQuery, { strict: true });
  return success(c, [await botSummary(c.env.DB, site, resolve(site, q))]);
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export function pageSearchSql(search: string): { sql: string; params: string[] } {
  const term = search.trim().toLowerCase();
  if (term.includes("*")) {
    const pattern = term
      .split("*")
      .map((part) => escapeLike(part))
      .join("%");
    return {
      sql: "(lower(path) LIKE ? ESCAPE '\\' OR lower(hostname || path) LIKE ? ESCAPE '\\')",
      params: [pattern, pattern],
    };
  }
  return {
    sql: "instr(lower(hostname || path), ?) > 0",
    params: [term],
  };
}

botRoutes.get(
  "/api/v1/analytics/bot-traffic/pages",
  requireSiteAccess("analytics:read"),
  async (c) => {
    const { site } = getAccess(c);
    const q = parseQuery(c, PagesQuery, { strict: true });
    const r = resolve(site, q);
    let where = r.where;
    const params = [...r.params];
    if (q.pageSearch?.trim()) {
      const s = pageSearchSql(q.pageSearch);
      where += ` AND ${s.sql}`;
      params.push(...s.params);
    }
    const db = c.env.DB;
    const pageRes = await bindAll(
      db.prepare(
        `SELECT hostname, path, SUM(requests) AS n, SUM(CASE WHEN verified = 1 THEN requests ELSE 0 END) AS v
       FROM bot_traffic WHERE ${where} GROUP BY hostname, path ORDER BY n DESC, hostname, path
       LIMIT ${q.limit + 1} OFFSET ${q.offset}`,
      ),
      params,
    ).all<{ hostname: string; path: string; n: number; v: number }>();
    const rows = pageRes.results ?? [];
    const hasMore = rows.length > q.limit;
    const pageRows = rows.slice(0, q.limit);
    const details = new Map<
      string,
      Array<{ crawler_id: string; status_code: number; verified: number; n: number }>
    >();
    if (pageRows.length) {
      const keys = pageRows.map((p) => `${p.hostname}::${p.path}`);
      const room = Math.max(1, 95 - params.length);
      const stmts: D1PreparedStatement[] = [];
      for (let i = 0; i < keys.length; i += room) {
        const part = keys.slice(i, i + room);
        stmts.push(
          bindAll(
            db.prepare(
              `SELECT hostname, path, crawler_id, status_code, verified, SUM(requests) AS n FROM bot_traffic
             WHERE ${where} AND (hostname || '::' || path) IN (${part.map(() => "?").join(", ")})
             GROUP BY hostname, path, crawler_id, status_code, verified`,
            ),
            [...params, ...part],
          ),
        );
      }
      for (const res of await db.batch(stmts)) {
        for (const row of (res.results ?? []) as Array<Record<string, unknown>>) {
          const key = `${row.hostname}::${row.path}`;
          const list = details.get(key) ?? [];
          list.push({
            crawler_id: String(row.crawler_id),
            status_code: Number(row.status_code),
            verified: Number(row.verified),
            n: Number(row.n),
          });
          details.set(key, list);
        }
      }
    }
    const data: BotTrafficPage[] = pageRows.map((p) => {
      const id = `${p.hostname}::${p.path}`;
      const d = details.get(id) ?? [];
      const statuses = new Map<number, number>();
      for (const x of d) statuses.set(x.status_code, (statuses.get(x.status_code) ?? 0) + x.n);
      return {
        id,
        hostname: p.hostname,
        path: p.path,
        requestCount: Number(p.n),
        ipVerifiedRequests: Number(p.v),
        userAgentOnlyRequests: Number(p.n) - Number(p.v),
        statusCodes: [...statuses.entries()]
          .map(([statusCode, requestCount]) => ({ statusCode, requestCount }))
          .sort((a, b) => b.requestCount - a.requestCount),
        crawlers: crawlerCounts(d).map(
          ({ id: cid, company, userAgent, category, requestCount }) => ({
            id: cid,
            company,
            userAgent,
            category,
            requestCount,
          }),
        ),
      };
    });
    return c.json({
      status: "success",
      data,
      context: {
        websiteId: site.id,
        domain: site.domain,
        range: {
          startAt: toIso(r.range.startMs),
          endAt: toIso(r.range.endMs - 1),
          timezone: r.range.timezone,
        },
        filters: {
          category: r.category,
          verification: r.verification,
          company: r.company,
          crawlerId: r.crawlerId,
          pageSearch: q.pageSearch ?? null,
        },
      },
      pagination: {
        limit: q.limit,
        offset: q.offset,
        hasMore,
        nextOffset: hasMore ? q.offset + q.limit : null,
      },
    });
  },
);

// ---------------------------------------------------------------------------
// Usage (account-wide)
// ---------------------------------------------------------------------------

botRoutes.get(
  "/api/v1/admin/bot-traffic/usage",
  requireAccountAccess("analytics:read", { allowSiteKey: false }),
  async (c) => {
    const auth = getAuth(c);
    if (auth.kind !== "session" && auth.websiteIds !== "all") {
      throw new ApiError(
        403,
        "Bot traffic usage is account-wide: use a token with access to all websites",
      );
    }
    const db = c.env.DB;
    const now = Date.now();
    const period = periodOf(now);
    const sitesRes = await db
      .prepare(
        `SELECT s.id, s.domain, s.logo FROM memberships m JOIN sites s ON s.id = m.site_id AND s.deleted_at IS NULL
         WHERE m.user_id = ? AND m.role = 'owner'`,
      )
      .bind(auth.user.id)
      .all<{ id: string; domain: string; logo: string | null }>();
    const owned = sitesRes.results ?? [];
    const counts = new Map<string, number>();
    if (owned.length) {
      const res = await db.batch(
        owned.map((s) =>
          db
            .prepare(
              "SELECT COALESCE(SUM(requests), 0) AS n FROM bot_traffic WHERE site_id = ? AND hour >= ? AND hour < ?",
            )
            .bind(s.id, period.startMs, period.endMs),
        ),
      );
      owned.forEach((s, i) => {
        counts.set(s.id, Number((res[i]?.results?.[0] as { n?: number })?.n ?? 0));
      });
    }
    const websiteStats = owned
      .filter((s) => (counts.get(s.id) ?? 0) > 0)
      .map((s) => ({
        websiteId: s.id,
        domain: s.domain,
        logo: s.logo,
        requestCount: counts.get(s.id) ?? 0,
      }))
      .sort((a, b) => b.requestCount - a.requestCount);
    const allowance = allowanceOf(c.env);
    const stored = allowance === null ? null : await storedUsage(db, now);
    const pending = pendingUsage();
    const used =
      stored === null
        ? websiteStats.reduce((s, w) => s + w.requestCount, 0)
        : stored.accepted + pending.accepted;
    return success(c, [
      {
        usage: {
          usage: used,
          dropped: stored === null ? 0 : stored.dropped + pending.dropped,
          packQuantity: 0,
          allowance,
          remaining: allowance === null ? null : Math.max(0, allowance - used),
          percentUsed:
            allowance === null ? 0 : Math.min(100, Math.round((used / allowance) * 10000) / 100),
          periodStartAt: toIso(period.startMs),
          resetAt: toIso(period.endMs),
          isCounting: allowance !== null,
        },
        websiteStats,
        billing: null,
        includedRequests: allowance,
        packRequests: null,
        packMonthlyPrice: null,
        canView: true,
        canPurchase: false,
      },
    ]);
  },
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const PatchBody = z
  .object({
    verifiedOnly: z.boolean().optional(),
    requireAuthToken: z.boolean().optional(),
    disableCompanies: z.array(z.string().max(100)).max(100).optional(),
    enableCompanies: z.array(z.string().max(100)).max(100).optional(),
    disableCrawlerIds: z.array(z.string().max(200)).max(200).optional(),
    enableCrawlerIds: z.array(z.string().max(200)).max(200).optional(),
    excludedCrawlerIds: z.array(z.string().max(200)).max(200).optional(),
    hiddenCrawlers: z.array(z.string().max(200)).max(200).optional(),
    hideDashboardCard: z.boolean().optional(),
    groupBy: z.enum(["crawlers", "pages"]).optional(),
    pageFilterIds: z.array(z.string().max(600)).max(100).optional(),
  })
  .strict();

function settingsBody(site: Site, settings: BotTrafficSettings) {
  return [
    { websiteId: site.id, domain: site.domain, settings, crawlerCatalog: crawlerCatalog(settings) },
  ];
}

botRoutes.get(`${W}/bot-traffic/settings`, requireSiteAccess("settings:read", OWNER), async (c) => {
  const { site } = getAccess(c);
  const { settings } = await loadBotConfig(c.env.DB, site.id, 0);
  return success(c, settingsBody(site, settings));
});

export function applySettingsPatch(
  current: BotTrafficSettings,
  body: z.output<typeof PatchBody>,
  hasToken: boolean,
): BotTrafficSettings {
  const incremental = [
    "disableCompanies",
    "enableCompanies",
    "disableCrawlerIds",
    "enableCrawlerIds",
  ].some((k) => body[k as keyof typeof body] !== undefined);
  if (incremental && body.excludedCrawlerIds !== undefined) {
    throw new ApiError(
      400,
      "excludedCrawlerIds replaces the whole list; do not combine it with enable/disable fields",
    );
  }
  for (const company of [...(body.disableCompanies ?? []), ...(body.enableCompanies ?? [])]) {
    if (!COMPANIES.includes(company)) throw new ApiError(400, `Unknown company: ${company}`);
  }
  for (const id of [
    ...(body.disableCrawlerIds ?? []),
    ...(body.enableCrawlerIds ?? []),
    ...(body.excludedCrawlerIds ?? []),
  ]) {
    if (!CRAWLERS_BY_ID.has(id)) throw new ApiError(400, `Unknown crawler id: ${id}`);
  }
  const excluded = new Set(body.excludedCrawlerIds ?? current.excludedCrawlerIds);
  const ofCompanies = (list: string[] | undefined) =>
    CRAWLERS.filter((c) => (list ?? []).includes(c.company)).map((c) => c.id);
  for (const id of ofCompanies(body.disableCompanies)) excluded.add(id);
  for (const id of body.disableCrawlerIds ?? []) excluded.add(id);
  for (const id of ofCompanies(body.enableCompanies)) excluded.delete(id);
  for (const id of body.enableCrawlerIds ?? []) excluded.delete(id);
  if (body.requireAuthToken === true && !hasToken) {
    throw new ApiError(400, "Create a bot traffic token before requiring it");
  }
  return normaliseSettings({
    ...current,
    excludedCrawlerIds: [...excluded],
    ...(body.verifiedOnly !== undefined ? { verifiedOnly: body.verifiedOnly } : {}),
    ...(body.requireAuthToken !== undefined ? { requireAuthToken: body.requireAuthToken } : {}),
    ...(body.hiddenCrawlers !== undefined ? { hiddenCrawlers: body.hiddenCrawlers } : {}),
    ...(body.hideDashboardCard !== undefined ? { hideDashboardCard: body.hideDashboardCard } : {}),
    ...(body.groupBy !== undefined ? { groupBy: body.groupBy } : {}),
    ...(body.pageFilterIds !== undefined ? { pageFilterIds: body.pageFilterIds } : {}),
  });
}

botRoutes.patch(
  `${W}/bot-traffic/settings`,
  requireSiteAccess("settings:write", OWNER),
  async (c) => {
    const { site } = getAccess(c);
    const body = await parseJsonBody(c, PatchBody, { maxBytes: 8 * 1024 });
    const config = await loadBotConfig(c.env.DB, site.id, 0);
    const next = applySettingsPatch(config.settings, body, config.tokenHash !== null);
    await saveSettingsStatement(c.env.DB, site.id, next, Date.now()).run();
    invalidateBotConfig(site.id);
    return success(c, settingsBody(site, next));
  },
);

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

async function tokenStatus(db: D1Database, site: Site, secret?: string): Promise<BotTokenStatus> {
  const row = await db
    .prepare(
      `SELECT t.display_token, t.created_at, (SELECT settings FROM bot_settings WHERE site_id = ?1) AS settings
       FROM (SELECT 1) LEFT JOIN bot_tokens t ON t.site_id = ?1`,
    )
    .bind(site.id)
    .first<{ display_token: string | null; created_at: number | null; settings: string | null }>();
  let require = false;
  try {
    require = Boolean(
      row?.settings && (JSON.parse(row.settings) as BotTrafficSettings).requireAuthToken,
    );
  } catch {
    require = false;
  }
  const status: BotTokenStatus = {
    websiteId: site.id,
    domain: site.domain,
    hasToken: Boolean(row?.display_token),
    displayToken: row?.display_token ?? null,
    createdAt: row?.created_at ? toIso(row.created_at) : null,
    requireAuthToken: Boolean(row?.display_token) && require,
  };
  if (secret) status.requestAuthToken = secret;
  return status;
}

botRoutes.get(`${W}/bot-traffic/token`, requireSiteAccess("settings:read", OWNER), async (c) => {
  const { site } = getAccess(c);
  return success(c, [await tokenStatus(c.env.DB, site)]);
});

botRoutes.post(`${W}/bot-traffic/token`, requireSiteAccess("settings:write", OWNER), async (c) => {
  const { site } = getAccess(c);
  const token = newBotToken();
  const res = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO bot_tokens (site_id, token_hash, display_token, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(site.id, await hashBotToken(token), displayBotToken(token), Date.now())
    .run();
  if (!res.meta.changes) throw new ApiError(409, "A token already exists; rotate it instead");
  invalidateBotConfig(site.id);
  return success(c, [await tokenStatus(c.env.DB, site, token)]);
});

botRoutes.put(`${W}/bot-traffic/token`, requireSiteAccess("settings:write", OWNER), async (c) => {
  const { site } = getAccess(c);
  const token = newBotToken();
  const res = await c.env.DB.prepare(
    "UPDATE bot_tokens SET token_hash = ?, display_token = ?, created_at = ? WHERE site_id = ?",
  )
    .bind(await hashBotToken(token), displayBotToken(token), Date.now(), site.id)
    .run();
  if (!res.meta.changes) throw new ApiError(404, "No token exists yet; create one first");
  invalidateBotConfig(site.id);
  return success(c, [await tokenStatus(c.env.DB, site, token)]);
});

botRoutes.delete(
  `${W}/bot-traffic/token`,
  requireSiteAccess("settings:write", OWNER),
  async (c) => {
    const { site } = getAccess(c);
    const db = c.env.DB;
    const config = await loadBotConfig(db, site.id, 0);
    const now = Date.now();
    await db.batch([
      db.prepare("DELETE FROM bot_tokens WHERE site_id = ?").bind(site.id),
      saveSettingsStatement(db, site.id, { ...config.settings, requireAuthToken: false }, now),
    ]);
    invalidateBotConfig(site.id);
    return success(c, [await tokenStatus(db, site)]);
  },
);
