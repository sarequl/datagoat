/**
 * Meta Ads reads (DG): spend per campaign joined with DataGoat's attributed revenue (ROAS), the
 * summary used by the ROAS KPI, and a live list of ad accounts and campaigns for the settings UI.
 *
 * Matching (DataFast docs/meta-ads-attribution): a session belongs to a campaign when its
 * `utm_campaign` equals the campaign id or name (case-insensitive), or contains the campaign name,
 * and the session looks like Meta traffic (utm_source meta/facebook/fb/instagram/ig, a paid-social
 * utm_medium, the Paid Social channel, or an fbclid). Exact matches win over partial ones; each
 * session counts for one campaign. Revenue is the payments attributed to those sessions by the
 * website's attribution model that occurred in the range.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AdCampaignRow } from "../../../shared/api-types";
import { getAccess } from "../../auth/context";
import { requireSiteAccess } from "../../auth/middleware";
import { chunk } from "../../lib/d1";
import { attributionColumn, paymentCountKinds, revenueKinds } from "../../lib/metrics";
import { toMajor } from "../../lib/money";
import { paginationOf, success } from "../../lib/response";
import type { Site } from "../../lib/sites";
import { type DateRange, lastNDays, localDate, parseRange } from "../../lib/time";
import { parsePagination, parseQuery } from "../../lib/validate";
import type { AppEnv } from "../../types";
import { freshToken } from "../integrations/tokens";
import { getConnection } from "../shared/connections";
import { errorMessage } from "../shared/http";
import { listAdAccounts, listCampaigns } from "./client";
import type { MetaCursor, MetaSettings } from "./sync";

export const metaRoutes = new Hono<AppEnv>();

const RangeQuery = z.object({
  websiteId: z.string().optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  timezone: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

const META_SOURCES =
  "'meta', 'facebook', 'fb', 'instagram', 'ig', 'facebook.com', 'instagram.com', 'm.facebook.com', 'l.facebook.com'";
const META_MEDIUMS =
  "'paid-social', 'paid_social', 'paidsocial', 'social-paid', 'social_paid', 'cpc', 'ppc', 'paid', 'ads', 'ad'";

interface SpendAgg {
  account_id: string;
  campaign_id: string;
  campaign_name: string | null;
  currency: string;
  spend_minor: number;
  impressions: number;
  clicks: number;
  purchase_minor: number | null;
}

async function fxFactor(
  db: D1Database,
  from: string[],
  to: string,
): Promise<Map<string, number | null>> {
  const currencies = [...new Set([...from, to])];
  const out = new Map<string, number | null>();
  if (from.every((c) => c === to)) {
    for (const c of from) out.set(c, 1);
    return out;
  }
  const res = await db
    .prepare(
      `SELECT currency, per_usd FROM fx_rates WHERE currency IN (${currencies.map(() => "?").join(", ")})
       AND day = (SELECT MAX(day) FROM fx_rates f2 WHERE f2.currency = fx_rates.currency)`,
    )
    .bind(...currencies)
    .all<{ currency: string; per_usd: number }>();
  const rates = new Map((res.results ?? []).map((r) => [r.currency, r.per_usd]));
  if (to === "USD") rates.set("USD", 1);
  for (const c of from) {
    if (c === to) out.set(c, 1);
    else {
      const a = c === "USD" ? 1 : rates.get(c);
      const b = rates.get(to);
      out.set(c, a && b ? b / a : null);
    }
  }
  return out;
}

export async function campaignRows(
  db: D1Database,
  site: Site,
  range: DateRange,
  selected: string[],
) {
  const from = localDate(range.startMs, range.timezone);
  const to = localDate(range.endMs - 1, range.timezone);
  const spendRes = await db
    .prepare(
      `SELECT account_id, campaign_id, MAX(campaign_name) AS campaign_name, MAX(currency) AS currency,
         SUM(spend_minor) AS spend_minor, SUM(impressions) AS impressions, SUM(clicks) AS clicks,
         SUM(purchase_value_minor) AS purchase_minor
       FROM ad_spend_daily WHERE site_id = ? AND platform = 'meta' AND day >= ? AND day <= ?
       GROUP BY account_id, campaign_id`,
    )
    .bind(site.id, from, to)
    .all<SpendAgg>();
  const spend = spendRes.results ?? [];
  // Selected campaigns without spend in the range still get a row (names from any day).
  const missing = selected.filter((id) => !spend.some((s) => s.campaign_id === id));
  if (missing.length) {
    const names = await db
      .prepare(
        `SELECT account_id, campaign_id, MAX(campaign_name) AS campaign_name, MAX(currency) AS currency
         FROM ad_spend_daily WHERE site_id = ? AND platform = 'meta' AND campaign_id IN (${missing.map(() => "?").join(", ")})
         GROUP BY account_id, campaign_id`,
      )
      .bind(site.id, ...missing)
      .all<SpendAgg>();
    const known = new Map((names.results ?? []).map((n) => [n.campaign_id, n]));
    for (const id of missing) {
      const n = known.get(id);
      spend.push({
        account_id: n?.account_id ?? "",
        campaign_id: id,
        campaign_name: n?.campaign_name ?? null,
        currency: n?.currency ?? site.currency,
        spend_minor: 0,
        impressions: 0,
        clicks: 0,
        purchase_minor: null,
      });
    }
  }
  if (spend.length === 0) return { rows: [] as AdCampaignRow[], unconverted: false };

  const attr = attributionColumn(site.attributionModel);
  const rev = revenueKinds(site.includeRenewalRevenue)
    .map((k) => `'${k}'`)
    .join(", ");
  const counted = paymentCountKinds(site.includeRenewalRevenue)
    .map((k) => `'${k}'`)
    .join(", ");
  const stats = new Map<string, { visitors: number; revenue_minor: number; payments: number }>();
  // 2 parameters per campaign + 6 fixed: chunks of 40 stay under D1's 100-parameter limit.
  const stmts = chunk(spend, 40).map((part) =>
    db
      .prepare(
        `WITH c(cid, cname) AS (VALUES ${part.map(() => "(?, ?)").join(", ")}),
         ms AS (
           SELECT s.id, s.visitor_id, c.cid,
             ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY
               CASE WHEN lower(s.utm_campaign) = c.cid OR lower(s.utm_campaign) = c.cname THEN 0 ELSE 1 END,
               length(c.cname) DESC) AS rn
           FROM sessions s JOIN c ON (lower(s.utm_campaign) = c.cid OR lower(s.utm_campaign) = c.cname
             OR (length(c.cname) >= 4 AND instr(lower(s.utm_campaign), c.cname) > 0))
           WHERE s.site_id = ? AND s.started_at >= ? AND s.started_at < ? AND s.utm_campaign IS NOT NULL
             AND (lower(COALESCE(s.utm_source, '')) IN (${META_SOURCES})
               OR lower(COALESCE(s.utm_medium, '')) IN (${META_MEDIUMS})
               OR s.channel = 'Paid Social' OR instr(COALESCE(s.ad_click_ids, ''), 'fbclid') > 0)
         ),
         m AS (SELECT id, visitor_id, cid FROM ms WHERE rn = 1),
         v AS (SELECT cid, COUNT(DISTINCT visitor_id) AS visitors FROM m GROUP BY cid),
         r AS (
           SELECT m.cid, SUM(CASE WHEN p.kind IN (${rev}) THEN p.reporting_minor ELSE 0 END) AS revenue_minor,
             SUM(CASE WHEN p.kind IN (${counted}) THEN 1 ELSE 0 END) AS payments
           FROM payments p JOIN m ON m.id = p.${attr}
           WHERE p.site_id = ? AND p.occurred_at >= ? AND p.occurred_at < ?
           GROUP BY m.cid
         )
         SELECT c.cid, COALESCE(v.visitors, 0) AS visitors, COALESCE(r.revenue_minor, 0) AS revenue_minor,
           COALESCE(r.payments, 0) AS payments
         FROM c LEFT JOIN v ON v.cid = c.cid LEFT JOIN r ON r.cid = c.cid`,
      )
      .bind(
        ...part.flatMap((s) => [
          s.campaign_id.toLowerCase(),
          (s.campaign_name ?? s.campaign_id).toLowerCase(),
        ]),
        site.id,
        range.startMs,
        range.endMs,
        site.id,
        range.startMs,
        range.endMs,
      ),
  );
  for (const res of await db.batch(stmts)) {
    for (const row of (res.results ?? []) as Array<{
      cid: string;
      visitors: number;
      revenue_minor: number;
      payments: number;
    }>) {
      stats.set(row.cid, {
        visitors: row.visitors,
        revenue_minor: row.revenue_minor,
        payments: row.payments,
      });
    }
  }
  const factors = await fxFactor(
    db,
    spend.map((s) => s.currency),
    site.currency,
  );
  let unconverted = false;
  const rows: AdCampaignRow[] = spend.map((s) => {
    const st = stats.get(s.campaign_id.toLowerCase()) ?? {
      visitors: 0,
      revenue_minor: 0,
      payments: 0,
    };
    const f = factors.get(s.currency);
    if (f === null) unconverted = true;
    const spendSite = toMajor(
      Math.round(Number(s.spend_minor) * (f ?? 1)),
      f === null ? s.currency : site.currency,
    );
    const revenue = toMajor(Number(st.revenue_minor), site.currency);
    return {
      platform: "meta",
      accountId: s.account_id,
      campaignId: s.campaign_id,
      campaignName: s.campaign_name,
      spend: spendSite,
      impressions: Number(s.impressions),
      clicks: Number(s.clicks),
      visitors: Number(st.visitors),
      revenue,
      payments: Number(st.payments),
      roas: spendSite > 0 ? Math.round((revenue / spendSite) * 100) / 100 : null,
      metaPurchaseValue:
        s.purchase_minor === null
          ? null
          : toMajor(Math.round(Number(s.purchase_minor) * (f ?? 1)), site.currency),
    };
  });
  rows.sort((a, b) => b.spend - a.spend || b.revenue - a.revenue);
  return { rows, unconverted };
}

function rangeOf(site: Site, q: z.output<typeof RangeQuery>) {
  return (
    parseRange(q, site.timezone, (tz, now) => lastNDays(30, tz, now)) ??
    lastNDays(30, site.timezone)
  );
}

async function selectedCampaigns(db: D1Database, siteId: string): Promise<string[]> {
  const conn = await getConnection<MetaSettings, MetaCursor>(db, siteId, "meta_ads");
  return conn?.settings.campaignIds ?? [];
}

metaRoutes.get("/api/v1/ads/campaigns", requireSiteAccess("analytics:read"), async (c) => {
  const { site } = getAccess(c);
  const q = parseQuery(c, RangeQuery, { strict: true });
  const { limit, offset } = parsePagination(q, { max: 1000 });
  const { rows } = await campaignRows(
    c.env.DB,
    site,
    rangeOf(site, q),
    await selectedCampaigns(c.env.DB, site.id),
  );
  return success(c, rows.slice(offset, offset + limit), {
    pagination: paginationOf(limit, offset, rows.length),
  });
});

metaRoutes.get("/api/v1/ads/summary", requireSiteAccess("analytics:read"), async (c) => {
  const { site } = getAccess(c);
  const q = parseQuery(c, RangeQuery, { strict: true });
  const { rows, unconverted } = await campaignRows(
    c.env.DB,
    site,
    rangeOf(site, q),
    await selectedCampaigns(c.env.DB, site.id),
  );
  const sum = (k: "spend" | "revenue" | "impressions" | "clicks" | "visitors" | "payments") =>
    rows.reduce((s, r) => s + r[k], 0);
  const spend = Math.round(sum("spend") * 100) / 100;
  const revenue = Math.round(sum("revenue") * 100) / 100;
  return success(c, {
    currency: site.currency,
    spend,
    revenue,
    roas: spend > 0 ? Math.round((revenue / spend) * 100) / 100 : null,
    campaigns: rows.length,
    impressions: sum("impressions"),
    clicks: sum("clicks"),
    visitors: sum("visitors"),
    payments: sum("payments"),
    currencyConverted: !unconverted,
  });
});

/** DG: ad accounts and campaigns the connected Meta user can read (live). */
metaRoutes.get("/api/v1/ads/accounts", requireSiteAccess("settings:read"), async (c) => {
  const { site } = getAccess(c);
  const conn = await getConnection(c.env.DB, site.id, "meta_ads");
  if (!conn?.hasCredentials) return success(c, []);
  const fetcher = (i: RequestInfo | URL, init?: RequestInit) => fetch(i, init);
  try {
    const { token } = await freshToken(c.env, fetcher, conn, Date.now());
    const accounts = await listAdAccounts(fetcher, c.env, token);
    const withCampaigns = await Promise.all(
      accounts
        .slice(0, 10)
        .map(async (a) => ({ ...a, campaigns: await listCampaigns(fetcher, c.env, token, a.id) })),
    );
    return success(c, withCampaigns);
  } catch (err) {
    return success(c, [], { extra: { error: errorMessage(err) } });
  }
});
