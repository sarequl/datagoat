/**
 * The query context every analytics computation receives: the website, the resolved date range
 * and timezone (DataFast `startAt`/`endAt`/`timezone` semantics), the parsed `filter_*`
 * parameters and who is asking (PII access, public share view).
 *
 *   const qc = buildQueryContext(c, site, { defaultRange: last30Days });
 *   const rows = await prepare(qc.db, sql`... WHERE ${sessionScope(qc)}`).all();
 */
import type { Context } from "hono";
import { compileFilters, type FilterKey, type ParsedFilter, parseFilters } from "../lib/filters";
import type { Site } from "../lib/sites";
import { raw, type SqlFragment, sql } from "../lib/sql";
import { type DateRange, lastNDays, parseRange } from "../lib/time";
import type { AppEnv } from "../types";

export interface QueryContext {
  db: D1Database;
  env: Cloudflare.Env;
  site: Site;
  /** Resolved range, or null for all time. */
  range: DateRange | null;
  timezone: string;
  filters: ParsedFilter[];
  now: number;
  /** Caller may read customer names and emails. */
  includePii: boolean;
  /** Request comes from a public share link (no PII, revenue only when the site allows it). */
  publicView: boolean;
}

export interface ContextOptions {
  defaultRange?: (timezone: string, nowMs: number) => DateRange;
  allowedFilters?: readonly FilterKey[];
  publicView?: boolean;
  /** Filters from another source (segments, visitors-list parameters) merged with `filter_*`. */
  extraFilters?: ParsedFilter[];
  now?: number;
}

export const last30Days = (timezone: string, nowMs: number): DateRange =>
  lastNDays(30, timezone, nowMs);

export function buildQueryContext(
  c: Context<AppEnv>,
  site: Site,
  options: ContextOptions = {},
): QueryContext {
  const now = options.now ?? Date.now();
  const q = c.req.query();
  const range = parseRange(
    { startAt: q.startAt, endAt: q.endAt, timezone: q.timezone },
    site.timezone,
    options.defaultRange,
    now,
  );
  const filters = [
    ...parseFilters(new URL(c.req.url).searchParams, { allowed: options.allowedFilters }),
    ...(options.extraFilters ?? []),
  ];
  const auth = c.get("auth");
  return {
    db: c.env.DB,
    env: c.env,
    site,
    range,
    timezone: range?.timezone ?? (q.timezone || site.timezone),
    filters,
    now,
    includePii: options.publicView ? false : (auth?.includePii ?? false),
    publicView: options.publicView ?? false,
  };
}

/** A copy of the context over another range (previous-period comparisons). */
export function withRange(qc: QueryContext, range: DateRange | null): QueryContext {
  return { ...qc, range };
}

// ---------------------------------------------------------------------------
// SQL scopes
// ---------------------------------------------------------------------------

/** Predicate that selects only non-pageview events, so the partial activity indexes apply. */
export const ACTIVITY = "type <> 'pageview'";

const ALIAS_RE = /^[a-z_][a-z0-9_]*$/i;
function alias(a: string): string {
  if (!ALIAS_RE.test(a)) throw new Error(`Invalid SQL alias ${a}`);
  return a;
}

/** `<col> >= start AND <col> < end` for the context range, or `1=1` for all time. */
export function rangeOn(column: string, range: DateRange | null): SqlFragment {
  if (!range) return raw("1=1");
  const col = raw(column);
  return sql`${col} >= ${range.startMs} AND ${col} < ${range.endMs}`;
}

/** The compiled `filter_*` predicate over a sessions alias. */
export function filterSql(qc: QueryContext, sessionAlias = "s"): SqlFragment {
  return compileFilters(qc.filters, {
    siteId: qc.site.id,
    range: qc.range,
    sessionAlias: alias(sessionAlias),
  });
}

/** Sessions of the site started in the range that match the filters. */
export function sessionScope(qc: QueryContext, sessionAlias = "s"): SqlFragment {
  const s = alias(sessionAlias);
  return sql`${raw(s)}.site_id = ${qc.site.id} AND ${rangeOn(`${s}.started_at`, qc.range)} AND ${filterSql(qc, s)}`;
}

/** Events of the site in the range (no filters). */
export function eventScope(qc: QueryContext, eventAlias = "e"): SqlFragment {
  const e = alias(eventAlias);
  return sql`${raw(e)}.site_id = ${qc.site.id} AND ${rangeOn(`${e}.ts`, qc.range)}`;
}

export function hasFilters(qc: QueryContext): boolean {
  return qc.filters.length > 0;
}
