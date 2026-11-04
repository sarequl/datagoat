/**
 * The filter compiler (plan §3.5, §9): DataFast's `filter_*` query parameters → SQL predicates.
 *
 *   const filters = parseFilters(new URL(c.req.url).searchParams);
 *   const where = compileFilters(filters, { siteId: site.id, range });
 *   // `where` is a SqlFragment over the `sessions` alias `s`, e.g.
 *   sql`SELECT COUNT(DISTINCT s.visitor_id) FROM sessions s
 *       WHERE s.site_id = ${site.id} AND s.started_at >= ${range.startMs}
 *         AND s.started_at < ${range.endMs} AND ${where}`
 *
 * Value syntax (DataFast): `[operator:]value[,value...]`. Without an operator, `is` applies.
 * Several values match any of them. Examples:
 *   filter_country=US,Canada        filter_country=is_not:France
 *   filter_page=contains:/docs      filter_visit_count=gte:2
 *
 * Semantics:
 * - Session-level filters become WHERE clauses on `sessions` (dimensions of the session's first
 *   pageview): country, region, city, device, browser, os, referrer, entry_page, hostname,
 *   visit_count, utm_*, ref, source, via, channel.
 * - Visitor-level filters (`page`, `goal`) become uncorrelated `s.visitor_id [NOT] IN (SELECT
 *   visitor_id FROM events WHERE ... )` subqueries over the same date range: "visitors who viewed a
 *   page / completed a goal", as DataFast documents. They use the events (site_id, ts) index.
 *   With `eventAlias`, `page` instead filters the event rows themselves (`e.path`).
 * - `is_not` and `does_not_contain` keep rows whose column is NULL (unknown is "not France").
 * - Text comparisons are case-insensitive. Country accepts names or ISO codes. `Safari` also
 *   matches `Mobile Safari`. Referrer matches the source display name or the referrer domain;
 *   `Direct / None` (or `Direct/None`, `direct`, `none`) matches sessions with no referrer.
 */
import { toCountryCode } from "./countries";
import { ApiError } from "./errors";
import { escapeLike, join, list, raw, type SqlFragment, sql } from "./sql";

export const FILTER_KEYS = [
  "country",
  "region",
  "city",
  "device",
  "browser",
  "os",
  "referrer",
  "page",
  "entry_page",
  "hostname",
  "goal",
  "visit_count",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
  "source",
  "via",
  "channel",
] as const;

export type FilterKey = (typeof FILTER_KEYS)[number];
export type FilterOperator = "is" | "is_not" | "contains" | "does_not_contain" | "gte" | "lte";

export interface ParsedFilter {
  key: FilterKey;
  operator: FilterOperator;
  values: string[];
}

export const FILTER_PREFIX = "filter_";
/** DataFast caps comma-separated filter values at 50. */
export const MAX_FILTER_VALUES = 50;
/** Bound-parameter budget for all filters together, leaving room under D1's 100 for the caller. */
export const MAX_FILTER_PARAMS = 70;

const OPERATORS: readonly FilterOperator[] = [
  "is",
  "is_not",
  "contains",
  "does_not_contain",
  "gte",
  "lte",
];

const TEXT_OPS: readonly FilterOperator[] = ["is", "is_not", "contains", "does_not_contain"];
const EXACT_OPS: readonly FilterOperator[] = ["is", "is_not"];

const ALLOWED_OPS: Record<FilterKey, readonly FilterOperator[]> = {
  country: EXACT_OPS,
  region: TEXT_OPS,
  city: TEXT_OPS,
  device: EXACT_OPS,
  browser: EXACT_OPS,
  os: EXACT_OPS,
  referrer: TEXT_OPS,
  page: TEXT_OPS,
  entry_page: TEXT_OPS,
  hostname: TEXT_OPS,
  goal: EXACT_OPS,
  visit_count: ["is", "is_not", "gte", "lte"],
  utm_source: TEXT_OPS,
  utm_medium: TEXT_OPS,
  utm_campaign: TEXT_OPS,
  utm_term: TEXT_OPS,
  utm_content: TEXT_OPS,
  ref: TEXT_OPS,
  source: TEXT_OPS,
  via: TEXT_OPS,
  channel: EXACT_OPS,
};

/** Session columns for session-level filters (alias added at compile time). */
const SESSION_COLUMN: Partial<Record<FilterKey, string>> = {
  country: "country",
  region: "region",
  city: "city",
  device: "device",
  browser: "browser",
  os: "os",
  entry_page: "entry_path",
  hostname: "hostname",
  visit_count: "session_number",
  utm_source: "utm_source",
  utm_medium: "utm_medium",
  utm_campaign: "utm_campaign",
  utm_term: "utm_term",
  utm_content: "utm_content",
  ref: "ref",
  source: "source_param",
  via: "via",
  channel: "channel",
};

const DIRECT_VALUES = new Set([
  "direct / none",
  "direct/none",
  "direct",
  "none",
  "(none)",
  "(direct)",
]);

/** Browser filter aliases: DataFast merges Mobile Safari into Safari. */
const BROWSER_ALIASES: Record<string, string[]> = {
  safari: ["Safari", "Mobile Safari"],
};

export function isFilterKey(value: string): value is FilterKey {
  return (FILTER_KEYS as readonly string[]).includes(value);
}

/** Parse one `filter_<key>` value. Throws 400 on invalid syntax or operator. */
export function parseFilterValue(key: FilterKey, rawValue: string): ParsedFilter {
  let operator: FilterOperator = "is";
  let rest = rawValue.trim();
  const colon = rest.indexOf(":");
  if (colon > 0) {
    const prefix = rest.slice(0, colon).trim().toLowerCase();
    if ((OPERATORS as readonly string[]).includes(prefix)) {
      operator = prefix as FilterOperator;
      rest = rest.slice(colon + 1);
    }
  }
  if (!ALLOWED_OPS[key].includes(operator)) {
    throw new ApiError(400, `Invalid filter_${key}: operator "${operator}" is not supported`);
  }
  const values = rest
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  if (values.length === 0) throw new ApiError(400, `Invalid filter_${key}: missing value`);
  if (values.length > MAX_FILTER_VALUES) {
    throw new ApiError(400, `Invalid filter_${key}: at most ${MAX_FILTER_VALUES} values`);
  }
  if (values.some((v) => v.length > 500))
    throw new ApiError(400, `Invalid filter_${key}: value too long`);
  if (key === "visit_count") {
    if (values.some((v) => !/^\d{1,9}$/.test(v))) {
      throw new ApiError(400, "Invalid filter_visit_count: values must be non-negative integers");
    }
    if ((operator === "gte" || operator === "lte") && values.length !== 1) {
      throw new ApiError(400, `Invalid filter_visit_count: ${operator} takes exactly one value`);
    }
  }
  if (key === "country") {
    const codes = values.map((v) => {
      const code = toCountryCode(v);
      if (!code) throw new ApiError(400, `Invalid filter_country: unknown country "${v}"`);
      return code;
    });
    return { key, operator, values: [...new Set(codes)] };
  }
  return { key, operator, values };
}

export interface ParseFiltersOptions {
  /** Restrict to these keys; others fail with 400 (e.g. goal properties disallow entry_page). */
  allowed?: readonly FilterKey[];
}

type ParamSource =
  | URLSearchParams
  | Record<string, string | undefined>
  | Iterable<[string, string]>;

function entriesOf(source: ParamSource): Array<[string, string]> {
  if (source instanceof URLSearchParams) return [...source.entries()];
  if (Symbol.iterator in Object(source)) return [...(source as Iterable<[string, string]>)];
  return Object.entries(source as Record<string, string | undefined>).filter(
    (e): e is [string, string] => typeof e[1] === "string",
  );
}

/**
 * Collect every `filter_*` parameter. Unknown `filter_*` keys and repeated keys fail with 400.
 * Non-filter parameters are ignored. Also used for saved segments (`{ "filter_country": "US" }`).
 */
export function parseFilters(
  source: ParamSource,
  options: ParseFiltersOptions = {},
): ParsedFilter[] {
  const seen = new Set<string>();
  const out: ParsedFilter[] = [];
  for (const [name, value] of entriesOf(source)) {
    if (!name.startsWith(FILTER_PREFIX)) continue;
    const key = name.slice(FILTER_PREFIX.length);
    if (!isFilterKey(key)) throw new ApiError(400, `Unknown filter: ${name}`);
    if (options.allowed && !options.allowed.includes(key)) {
      throw new ApiError(400, `Filter ${name} is not supported on this endpoint`);
    }
    if (seen.has(key)) throw new ApiError(400, `Duplicate filter: ${name}`);
    seen.add(key);
    out.push(parseFilterValue(key, value));
  }
  return out;
}

/** Serialise parsed filters back to query parameters (segments, share links, echoing). */
export function filtersToParams(filters: readonly ParsedFilter[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of filters) {
    out[`${FILTER_PREFIX}${f.key}`] = `${f.operator}:${f.values.join(",")}`;
  }
  return out;
}

export interface CompileOptions {
  siteId: string;
  /** Date range for visitor-level subqueries; null means all time. */
  range: { startMs: number; endMs: number } | null;
  /** SQL alias of the sessions table in the caller's query (default `s`). */
  sessionAlias?: string;
  /**
   * When set, `page` filters the caller's event rows (`<eventAlias>.path`) instead of selecting
   * visitors who viewed the page. Use for event-level queries such as goal properties.
   */
  eventAlias?: string;
}

const ALIAS_RE = /^[a-z_][a-z0-9_]*$/i;

function textPredicate(column: string, f: ParsedFilter): SqlFragment {
  const col = raw(column);
  switch (f.operator) {
    case "is":
      return sql`${col} COLLATE NOCASE IN ${list(f.values)}`;
    case "is_not":
      return sql`(${col} IS NULL OR ${col} COLLATE NOCASE NOT IN ${list(f.values)})`;
    case "contains":
      return join(
        f.values.map((v) => sql`${col} LIKE ${`%${escapeLike(v)}%`} ESCAPE '\\'`),
        " OR ",
      );
    case "does_not_contain":
      return sql`(${col} IS NULL OR NOT (${join(
        f.values.map((v) => sql`${col} LIKE ${`%${escapeLike(v)}%`} ESCAPE '\\'`),
        " OR ",
      )}))`;
    default:
      throw new ApiError(400, `Invalid filter_${f.key}: operator "${f.operator}" is not supported`);
  }
}

function visitCountPredicate(column: string, f: ParsedFilter): SqlFragment {
  const col = raw(column);
  const nums = f.values.map((v) => Number(v));
  switch (f.operator) {
    case "is":
      return sql`${col} IN ${list(nums)}`;
    case "is_not":
      return sql`${col} IS NOT NULL AND ${col} NOT IN ${list(nums)}`;
    case "gte":
      return sql`${col} >= ${nums[0] ?? 0}`;
    case "lte":
      return sql`${col} <= ${nums[0] ?? 0}`;
    default:
      throw new ApiError(
        400,
        `Invalid filter_visit_count: operator "${f.operator}" is not supported`,
      );
  }
}

function referrerPredicate(alias: string, f: ParsedFilter): SqlFragment {
  const direct = f.values.some((v) => DIRECT_VALUES.has(v.toLowerCase()));
  const named = f.values.filter((v) => !DIRECT_VALUES.has(v.toLowerCase()));
  const source = `${alias}.source`;
  const domain = `${alias}.referrer_domain`;
  const isDirect = raw(`(${source} IS NULL AND ${domain} IS NULL)`);
  if (f.operator === "is" || f.operator === "is_not") {
    const parts: SqlFragment[] = [];
    if (named.length) {
      parts.push(
        sql`(${raw(source)} COLLATE NOCASE IN ${list(named)} OR ${raw(domain)} COLLATE NOCASE IN ${list(named)})`,
      );
    }
    if (direct) parts.push(isDirect);
    const any = join(parts, " OR ");
    return f.operator === "is" ? any : sql`NOT (${any})`;
  }
  const likeAny = join(
    f.values.flatMap((v) => {
      const pattern = `%${escapeLike(v)}%`;
      return [
        sql`${raw(source)} LIKE ${pattern} ESCAPE '\\'`,
        sql`${raw(domain)} LIKE ${pattern} ESCAPE '\\'`,
      ];
    }),
    " OR ",
  );
  return f.operator === "contains" ? likeAny : sql`NOT (${likeAny})`;
}

function rangeClause(options: CompileOptions): SqlFragment {
  if (!options.range) return sql`site_id = ${options.siteId}`;
  return sql`site_id = ${options.siteId} AND ts >= ${options.range.startMs} AND ts < ${options.range.endMs}`;
}

function visitorSubquery(
  alias: string,
  negate: boolean,
  options: CompileOptions,
  eventWhere: SqlFragment,
): SqlFragment {
  const sub = sql`SELECT visitor_id FROM events WHERE ${rangeClause(options)} AND ${eventWhere}`;
  return negate
    ? sql`${raw(alias)}.visitor_id NOT IN (${sub})`
    : sql`${raw(alias)}.visitor_id IN (${sub})`;
}

function compileOne(f: ParsedFilter, options: CompileOptions): SqlFragment {
  const s = options.sessionAlias ?? "s";
  switch (f.key) {
    case "page": {
      if (options.eventAlias) return textPredicate(`${options.eventAlias}.path`, f);
      const positive: ParsedFilter = {
        ...f,
        operator:
          f.operator === "is_not"
            ? "is"
            : f.operator === "does_not_contain"
              ? "contains"
              : f.operator,
      };
      const negate = f.operator === "is_not" || f.operator === "does_not_contain";
      return visitorSubquery(
        s,
        negate,
        options,
        sql`type = 'pageview' AND ${textPredicate("path", positive)}`,
      );
    }
    case "goal": {
      const negate = f.operator === "is_not";
      const names = f.values.map((v) => v.toLowerCase());
      return visitorSubquery(s, negate, options, sql`type = 'custom' AND name IN ${list(names)}`);
    }
    case "referrer":
      return referrerPredicate(s, f);
    case "visit_count":
      return visitCountPredicate(`${s}.session_number`, f);
    case "browser": {
      const expanded = f.values.flatMap((v) => BROWSER_ALIASES[v.toLowerCase()] ?? [v]);
      return textPredicate(`${s}.browser`, { ...f, values: [...new Set(expanded)] });
    }
    default: {
      const column = SESSION_COLUMN[f.key];
      if (!column) throw new ApiError(400, `Unsupported filter: filter_${f.key}`);
      return textPredicate(`${s}.${column}`, f);
    }
  }
}

/**
 * Compile parsed filters to one SQL predicate (AND of all filters). Returns `1=1` when empty.
 * Throws 400 when the filters would need more than MAX_FILTER_PARAMS bound parameters.
 */
export function compileFilters(
  filters: readonly ParsedFilter[],
  options: CompileOptions,
): SqlFragment {
  const alias = options.sessionAlias ?? "s";
  if (
    !ALIAS_RE.test(alias) ||
    (options.eventAlias !== undefined && !ALIAS_RE.test(options.eventAlias))
  ) {
    throw new Error("Invalid SQL alias");
  }
  const fragment = join(filters.map((f) => compileOne(f, options)));
  if (fragment.params.length > MAX_FILTER_PARAMS) {
    throw new ApiError(400, "Too many filter values in one request");
  }
  return fragment;
}

/** True when any filter needs the events table (visitor-level). */
export function hasVisitorLevelFilters(filters: readonly ParsedFilter[]): boolean {
  return filters.some((f) => f.key === "page" || f.key === "goal");
}
