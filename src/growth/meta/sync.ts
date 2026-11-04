/**
 * `meta.sync` (hourly at :23): daily spend, impressions, clicks, reach and Meta-reported purchase
 * value per selected campaign into `ad_spend_daily`. The first runs backfill 90 days in 30-day
 * windows; afterwards each run refreshes the last 3 days (Meta revises recent days). Upserts write
 * only changed rows.
 */
import type { JobContext } from "../../jobs/registry";
import { chunk } from "../../lib/d1";
import { errorFields, log } from "../../lib/log";
import { toMinor } from "../../lib/money";
import { addDays } from "../../lib/time";
import { freshToken } from "../integrations/tokens";
import { type Connection, listActiveConnections, syncResultStatement } from "../shared/connections";
import { errorMessage } from "../shared/http";
import { campaignInsights, type InsightRow } from "./client";

export const SITES_PER_RUN = 3;
export const BACKFILL_DAYS = 90;
const WINDOW_DAYS = 30;

export interface MetaSettings {
  adAccountIds?: string[];
  campaignIds?: string[];
  /** campaign id → ad account id, recorded when campaigns are chosen in the dashboard. */
  campaignAccounts?: Record<string, string>;
}

export interface MetaCursor {
  backfilledTo?: string;
  backfillDone?: boolean;
}

export function spendUpserts(
  db: D1Database,
  siteId: string,
  accountId: string,
  rows: readonly InsightRow[],
  fallbackCurrency: string,
) {
  return chunk(rows, 8).map((part) =>
    db
      .prepare(
        `INSERT INTO ad_spend_daily (site_id, platform, account_id, campaign_id, day, campaign_name, currency,
           spend_minor, impressions, clicks, reach, purchase_value_minor)
         VALUES ${part.map(() => "(?, 'meta', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
         ON CONFLICT (site_id, platform, account_id, campaign_id, day) DO UPDATE SET
           campaign_name = excluded.campaign_name, currency = excluded.currency, spend_minor = excluded.spend_minor,
           impressions = excluded.impressions, clicks = excluded.clicks, reach = excluded.reach,
           purchase_value_minor = excluded.purchase_value_minor
         WHERE ad_spend_daily.spend_minor != excluded.spend_minor OR ad_spend_daily.impressions != excluded.impressions
           OR ad_spend_daily.clicks != excluded.clicks OR ad_spend_daily.reach != excluded.reach
           OR ad_spend_daily.purchase_value_minor IS NOT excluded.purchase_value_minor
           OR ad_spend_daily.campaign_name IS NOT excluded.campaign_name`,
      )
      .bind(
        ...part.flatMap((r) => {
          const currency = r.currency ?? fallbackCurrency;
          return [
            siteId,
            accountId,
            r.campaignId,
            r.day,
            r.campaignName,
            currency,
            toMinor(r.spend, currency),
            Math.round(r.impressions),
            Math.round(r.clicks),
            Math.round(r.reach),
            r.purchaseValue === null ? null : toMinor(r.purchaseValue, currency),
          ];
        }),
      ),
  );
}

export function metaWindow(
  cursor: MetaCursor,
  now: number,
): { since: string; until: string; backfill: boolean } {
  const today = new Date(now).toISOString().slice(0, 10);
  if (!cursor.backfillDone) {
    const oldest = addDays(today, -BACKFILL_DAYS);
    const until = cursor.backfilledTo ? addDays(cursor.backfilledTo, -1) : today;
    const start = addDays(until, -(WINDOW_DAYS - 1));
    const since = start.localeCompare(oldest) < 0 ? oldest : start;
    return { since, until, backfill: true };
  }
  return { since: addDays(today, -2), until: today, backfill: false };
}

export async function syncMetaSite(
  ctx: Pick<JobContext, "db" | "env" | "now" | "fetch">,
  conn: Connection<MetaSettings, MetaCursor>,
  siteCurrency: string,
) {
  const { db, env, now } = ctx;
  const campaigns = conn.settings.campaignIds ?? [];
  const accounts = conn.settings.adAccountIds ?? [];
  if (campaigns.length === 0 || accounts.length === 0) return { rows: 0 };
  const { token, credentialsEnc } = await freshToken(env, ctx.fetch, conn, now);
  const cursor: MetaCursor = { ...conn.cursor };
  const w = metaWindow(cursor, now);
  const stmts: D1PreparedStatement[] = [];
  let rows = 0;
  for (const account of accounts.slice(0, 5)) {
    const mapped = conn.settings.campaignAccounts;
    const ids = mapped ? campaigns.filter((id) => mapped[id] === account) : campaigns;
    if (ids.length === 0) continue;
    const insights = await campaignInsights(ctx.fetch, env, token, account, ids, w.since, w.until);
    rows += insights.length;
    stmts.push(...spendUpserts(db, conn.siteId, account, insights, siteCurrency));
  }
  if (w.backfill) {
    cursor.backfilledTo = w.since;
    if (w.since <= addDays(new Date(now).toISOString().slice(0, 10), -BACKFILL_DAYS))
      cursor.backfillDone = true;
  }
  stmts.push(
    syncResultStatement(db, conn.siteId, "meta_ads", { now, cursor, credentialsEnc, error: null }),
  );
  await db.batch(stmts);
  return { rows };
}

export async function syncMeta(
  ctx: Pick<JobContext, "db" | "env" | "now" | "fetch" | "remainingQueries">,
) {
  const conns = await listActiveConnections<MetaSettings, MetaCursor>(
    ctx.db,
    "meta_ads",
    SITES_PER_RUN,
  );
  if (conns.length === 0) return { sites: 0, rows: 0 };
  const currencies = await ctx.db
    .prepare(`SELECT id, currency FROM sites WHERE id IN (${conns.map(() => "?").join(", ")})`)
    .bind(...conns.map((c) => c.siteId))
    .all<{ id: string; currency: string }>();
  const currencyOf = new Map((currencies.results ?? []).map((r) => [r.id, r.currency]));
  let rows = 0;
  for (const conn of conns) {
    if (ctx.remainingQueries() < 3) break;
    try {
      rows += (await syncMetaSite(ctx, conn, currencyOf.get(conn.siteId) ?? "USD")).rows;
    } catch (err) {
      log.warn("meta.sync_failed", { siteId: conn.siteId, ...errorFields(err) });
      await syncResultStatement(ctx.db, conn.siteId, "meta_ads", {
        now: ctx.now,
        error: errorMessage(err),
      }).run();
    }
  }
  return { sites: conns.length, rows };
}
