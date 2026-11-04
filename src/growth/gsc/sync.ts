/**
 * `gsc.sync` (hourly at :17): Google Search Console daily sync and backfill.
 *
 * - Daily: once per UTC day, re-fetch the three most recent days Search Console may still revise
 *   (today-4 … today-2).
 * - Backfill: BACKFILL_DAYS_PER_RUN older days per run, back to Search Console's 16-month limit,
 *   so a new connection fills in over a few days without blowing the Free plan's write budget.
 *
 * Each day stores at most GSC_ROWS_PER_DAY (default 500) query × page rows (Search Console sorts by
 * clicks, so these are the top ones) plus one totals row (`query = '' AND page = ''`) from a
 * date-dimension request, which also covers anonymised queries. Upserts write only changed rows.
 */
import type { JobContext } from "../../jobs/registry";
import { chunk } from "../../lib/d1";
import { errorFields, log } from "../../lib/log";
import { addDays } from "../../lib/time";
import { freshToken } from "../integrations/tokens";
import { type Connection, listActiveConnections, syncResultStatement } from "../shared/connections";
import { errorMessage } from "../shared/http";
import { querySearchAnalytics } from "./client";

export const SITES_PER_RUN = 3;
export const BACKFILL_DAYS_PER_RUN = 2;
export const MAX_HISTORY_DAYS = 486; // ~16 months
const DEFAULT_ROWS_PER_DAY = 500;

export interface GscSettings {
  property?: string;
}

export interface GscCursor {
  lastDaily?: string;
  backfillBefore?: string;
  backfillDone?: boolean;
}

export function rowsPerDay(env: Cloudflare.Env): number {
  const n = Number.parseInt(env.GSC_ROWS_PER_DAY ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 25_000) : DEFAULT_ROWS_PER_DAY;
}

interface StoredRow {
  day: string;
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

export function upsertStatements(db: D1Database, siteId: string, rows: readonly StoredRow[]) {
  return chunk(rows, 14).map((part) =>
    db
      .prepare(
        `INSERT INTO gsc_daily (site_id, day, query, page, clicks, impressions, position)
         VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}
         ON CONFLICT (site_id, day, query, page) DO UPDATE SET clicks = excluded.clicks,
           impressions = excluded.impressions, position = excluded.position
         WHERE gsc_daily.clicks != excluded.clicks OR gsc_daily.impressions != excluded.impressions
           OR gsc_daily.position IS NOT excluded.position`,
      )
      .bind(
        ...part.flatMap((r) => [
          siteId,
          r.day,
          r.query.slice(0, 500),
          r.page.slice(0, 1000),
          Math.round(r.clicks),
          Math.round(r.impressions),
          r.position === null ? null : Math.round(r.position * 100) / 100,
        ]),
      ),
  );
}

export function daysToFetch(
  cursor: GscCursor,
  now: number,
): { daily: string[]; backfill: string[] } {
  const today = new Date(now).toISOString().slice(0, 10);
  const daily =
    cursor.lastDaily === today ? [] : [addDays(today, -4), addDays(today, -3), addDays(today, -2)];
  const backfill: string[] = [];
  if (!cursor.backfillDone) {
    const oldest = addDays(today, -MAX_HISTORY_DAYS);
    let before = cursor.backfillBefore ?? addDays(today, -4);
    for (let i = 0; i < BACKFILL_DAYS_PER_RUN; i++) {
      const day = addDays(before, -1);
      if (day < oldest) break;
      backfill.push(day);
      before = day;
    }
  }
  return { daily, backfill };
}

export async function syncSearchConsoleSite(
  ctx: Pick<JobContext, "db" | "env" | "now" | "fetch">,
  conn: Connection<GscSettings, GscCursor>,
) {
  const { db, env, now } = ctx;
  const property = conn.settings.property;
  if (!property) return { rows: 0 };
  const { token, credentialsEnc } = await freshToken(env, ctx.fetch, conn, now);
  const cursor: GscCursor = { ...conn.cursor };
  const { daily, backfill } = daysToFetch(cursor, now);
  const days = [...daily, ...backfill];
  if (days.length === 0) return { rows: 0 };
  const limit = rowsPerDay(env);
  const rows: StoredRow[] = [];
  const sorted = [...days].sort();
  const totals = await querySearchAnalytics(ctx.fetch, token, property, {
    startDate: sorted[0] as string,
    endDate: sorted[sorted.length - 1] as string,
    dimensions: ["date"],
    rowLimit: 1000,
  });
  const wanted = new Set(days);
  for (const t of totals) {
    const day = t.keys?.[0];
    if (!day || !wanted.has(day)) continue;
    rows.push({
      day,
      query: "",
      page: "",
      clicks: t.clicks ?? 0,
      impressions: t.impressions ?? 0,
      position: t.position ?? null,
    });
  }
  for (const day of days) {
    const detail = await querySearchAnalytics(ctx.fetch, token, property, {
      startDate: day,
      endDate: day,
      dimensions: ["query", "page"],
      rowLimit: limit,
    });
    for (const r of detail) {
      const [query, page] = r.keys ?? [];
      if (!query || !page) continue;
      rows.push({
        day,
        query,
        page,
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        position: r.position ?? null,
      });
    }
  }
  if (daily.length) cursor.lastDaily = new Date(now).toISOString().slice(0, 10);
  if (backfill.length) cursor.backfillBefore = backfill[backfill.length - 1];
  if (backfill.length < BACKFILL_DAYS_PER_RUN) cursor.backfillDone = true;
  await db.batch([
    ...upsertStatements(db, conn.siteId, rows),
    syncResultStatement(db, conn.siteId, "gsc", { now, cursor, credentialsEnc, error: null }),
  ]);
  return { rows: rows.length };
}

export async function syncSearchConsole(
  ctx: Pick<JobContext, "db" | "env" | "now" | "fetch" | "remainingQueries">,
) {
  const conns = await listActiveConnections<GscSettings, GscCursor>(ctx.db, "gsc", SITES_PER_RUN);
  let rows = 0;
  for (const conn of conns) {
    if (ctx.remainingQueries() < 3) break;
    try {
      rows += (await syncSearchConsoleSite(ctx, conn)).rows;
    } catch (err) {
      log.warn("gsc.sync_failed", { siteId: conn.siteId, ...errorFields(err) });
      await syncResultStatement(ctx.db, conn.siteId, "gsc", {
        now: ctx.now,
        error: errorMessage(err),
      }).run();
    }
  }
  return { sites: conns.length, rows };
}
