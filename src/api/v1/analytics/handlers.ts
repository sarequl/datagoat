/**
 * Analytics endpoint handlers, shared by the authenticated API (`/api/v1/analytics/*`) and the
 * public share links (`/api/share/:token/analytics/*`). Each handler parses DataFast's
 * parameters, builds a QueryContext, computes in src/query and renders DataFast's shapes.
 */
import type { Context } from "hono";
import type { FunnelStep } from "../../../../shared/api-types";
import { countryName } from "../../../lib/countries";
import { parseJsonColumn } from "../../../lib/d1";
import { ApiError } from "../../../lib/errors";
import { isObjectIdLike } from "../../../lib/ids";
import { OVERVIEW_FIELDS, pickFields, TIMESERIES_FIELDS } from "../../../lib/metrics";
import { toMajor } from "../../../lib/money";
import { paginationOf, success } from "../../../lib/response";
import type { Site } from "../../../lib/sites";
import { type DateRange, previousPeriod } from "../../../lib/time";
import { GOAL_NAME_RE, parseFields, parsePagination } from "../../../lib/validate";
import {
  type BreakdownRow,
  type BreakdownSpec,
  DIMENSIONS,
  flagEmoji,
  runBreakdown,
} from "../../../query/breakdowns";
import { withCache } from "../../../query/cache";
import {
  buildQueryContext,
  last30Days,
  type QueryContext,
  withRange,
} from "../../../query/context";
import {
  exitClicks,
  GOAL_PROPERTY_FILTERS,
  goalProperties,
  goalsBreakdown,
  pagesBreakdown,
} from "../../../query/event-breakdowns";
import { computeFunnel, renderFunnelResult } from "../../../query/funnels";
import { pageviewHeatmap } from "../../../query/heatmap";
import { computeTotals } from "../../../query/overview";
import { realtimeMap, realtimeReplay, realtimeVisitors } from "../../../query/realtime";
import {
  computeTimeseries,
  defaultTimeseriesRange,
  effectiveInterval,
  normaliseFields,
  parseInterval,
  renderPoint,
  renderTotals,
  SERIES_FIELDS,
  type SeriesField,
} from "../../../query/timeseries";
import type { AppEnv } from "../../../types";

export interface View {
  publicView: boolean;
  /** Revenue fields are returned (always for members; share links only with public data). */
  showRevenue: boolean;
}

export type AnalyticsHandler = (c: Context<AppEnv>, site: Site, view: View) => Promise<Response>;

const REVENUE_FIELDS = new Set([
  "revenue",
  "payments",
  "revenue_per_visitor",
  "conversion_rate",
  "refunds",
]);

function visibleFields<T extends string>(fields: T[], view: View): T[] {
  return view.showRevenue ? fields : fields.filter((f) => !REVENUE_FIELDS.has(f));
}

function pick(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f in row) out[f] = row[f];
  return out;
}

function parseCompare(c: Context<AppEnv>, range: DateRange | null): DateRange | null {
  const compare = c.req.query("compare");
  if (compare === undefined || compare === "" || compare === "false") return null;
  if (compare !== "previous" && compare !== "true") {
    throw new ApiError(400, "Invalid compare value: use compare=previous");
  }
  if (!range) throw new ApiError(400, "compare needs startAt and endAt");
  return previousPeriod(range);
}

function extraFlags(approximate: boolean): Record<string, unknown> {
  return approximate ? { approximate: true } : {};
}

// ---------------------------------------------------------------------------
// Overview, timeseries, metadata, realtime
// ---------------------------------------------------------------------------

export const overview: AnalyticsHandler = async (c, site, view) => {
  const fields = visibleFields(parseFields(c.req.query("fields"), OVERVIEW_FIELDS), view);
  const qc = buildQueryContext(c, site, { publicView: view.publicView });
  const previous = parseCompare(c, qc.range);
  return withCache(c, qc, async () => {
    const [totals, prev] = await Promise.all([
      computeTotals(qc),
      previous ? computeTotals(withRange(qc, previous)) : Promise.resolve(null),
    ]);
    const extra: Record<string, unknown> = extraFlags(
      totals.approximate || Boolean(prev?.approximate),
    );
    if (prev && previous) {
      extra.previous = pickFields(prev.metrics, fields);
      extra.previousRange = {
        startAt: new Date(previous.startMs).toISOString(),
        endAt: new Date(previous.endMs - 1).toISOString(),
      };
    }
    return success(c, [pickFields(totals.metrics, fields)], { extra });
  });
};

export const timeseries: AnalyticsHandler = async (c, site, view) => {
  const requested = parseInterval(c.req.query("interval"));
  // Omitted `fields` returns DataFast's fields; DataGoat's extras are opt-in.
  const rawFields = c.req.query("fields");
  const fields = normaliseFields(
    visibleFields(
      rawFields ? parseFields(rawFields, SERIES_FIELDS) : [...TIMESERIES_FIELDS],
      view,
    ) as SeriesField[],
  );
  const goals = fields.includes("goals");
  const base = buildQueryContext(c, site, {
    publicView: view.publicView,
    defaultRange: defaultTimeseriesRange(requested),
  });
  const range = base.range as DateRange;
  const interval = effectiveInterval(requested, range);
  const { limit, offset } = parsePagination(c.req.query(), { max: 1000 });
  const previous = parseCompare(c, range);
  const qc = { ...base, range };
  return withCache(c, qc, async () => {
    const [result, prev] = await Promise.all([
      computeTimeseries(qc, interval, { goals }),
      previous
        ? computeTimeseries({ ...qc, range: previous }, interval, { goals })
        : Promise.resolve(null),
    ]);
    const page = result.buckets.slice(offset, offset + limit);
    const extra: Record<string, unknown> = {
      fields,
      interval,
      timezone: qc.timezone,
      currency: site.currency,
      totals: renderTotals(result, fields, qc),
      ...extraFlags(result.approximate),
    };
    if (prev) {
      extra.previous = {
        data: prev.buckets
          .slice(offset, offset + limit)
          .map((b) => renderPoint(b, fields, interval, qc)),
        totals: renderTotals(prev, fields, qc),
      };
    }
    return success(
      c,
      page.map((b) => renderPoint(b, fields, interval, qc)),
      { extra, pagination: paginationOf(limit, offset, result.buckets.length) },
    );
  });
};

const METADATA_FIELDS = [
  "domain",
  "timezone",
  "name",
  "logo",
  "kpiColorScheme",
  "kpi",
  "currency",
] as const;

export const metadata: AnalyticsHandler = async (c, site) => {
  const fields = parseFields(c.req.query("fields"), METADATA_FIELDS);
  const row = {
    domain: site.domain,
    timezone: site.timezone,
    name: site.name ?? "",
    logo: site.logo,
    kpiColorScheme: site.kpiColorScheme ?? "orange",
    kpi: site.kpi,
    currency: site.currency,
  };
  return success(c, [pick(row, fields)]);
};

export const realtime: AnalyticsHandler = async (c, site) => {
  parseFields(c.req.query("fields"), ["visitors"] as const);
  return success(c, [{ visitors: await realtimeVisitors(c.env.DB, site.id, Date.now()) }]);
};

export const realtimeMapHandler: AnalyticsHandler = async (c, site, view) => {
  const qc = buildQueryContext(c, site, { publicView: view.publicView });
  const map = await realtimeMap({ ...qc, filters: [] });
  if (view.publicView) {
    for (const v of map.visitors) {
      v.profileData = { displayName: null, userId: null, hasProfile: false, isRandomName: true };
      v.customerName = null;
      v.customerEmail = null;
    }
    if (!view.showRevenue) map.recentPayments = [];
  }
  return success(c, map);
};

export const realtimeReplayHandler: AnalyticsHandler = async (c, site, view) => {
  const qc = buildQueryContext(c, site, { publicView: view.publicView });
  const replay = await realtimeReplay({ ...qc, filters: [], range: null });
  if (!view.showRevenue) for (const f of replay.frames) f.payments = 0;
  return success(c, replay);
};

// ---------------------------------------------------------------------------
// Session-dimension breakdowns
// ---------------------------------------------------------------------------

type Renderer = (row: BreakdownRow, qc: QueryContext) => Record<string, unknown>;

function money(row: { revenueMinor: number; payments: number }, qc: QueryContext) {
  return { revenue: toMajor(row.revenueMinor, qc.site.currency), payments: row.payments };
}

function breakdownHandler(
  spec: BreakdownSpec,
  validFields: readonly string[],
  render: Renderer,
): AnalyticsHandler {
  return async (c, site, view) => {
    const fields = visibleFields(parseFields(c.req.query("fields"), validFields), view);
    const page = parsePagination(c.req.query(), { max: 1000 });
    const qc = buildQueryContext(c, site, { publicView: view.publicView });
    return withCache(c, qc, async () => {
      const result = await runBreakdown(qc, spec, page);
      return success(
        c,
        result.rows.map((r) =>
          pick(render(r, qc), fields.includes("country") ? [...fields, "code"] : fields),
        ),
        {
          pagination: paginationOf(page.limit, page.offset, result.total),
          extra: extraFlags(result.approximate),
        },
      );
    });
  };
}

const simple =
  (key: string): Renderer =>
  (r, qc) => ({
    [key]: r.values[0] ?? "",
    visitors: r.visitors,
    ...money(r, qc),
  });

const M = ["visitors", "revenue", "payments"] as const;

export const referrers = breakdownHandler(
  DIMENSIONS.referrers,
  ["referrer", ...M],
  simple("referrer"),
);
export const channels = breakdownHandler(DIMENSIONS.channels, ["channel", ...M], simple("channel"));
export const regions = breakdownHandler(DIMENSIONS.regions, ["region", ...M], simple("region"));
export const cities = breakdownHandler(DIMENSIONS.cities, ["city", ...M], simple("city"));
export const devices = breakdownHandler(DIMENSIONS.devices, ["device", ...M], simple("device"));
export const browsers = breakdownHandler(DIMENSIONS.browsers, ["browser", ...M], simple("browser"));
export const operatingSystems = breakdownHandler(
  DIMENSIONS.os,
  ["operating_system", ...M],
  simple("operating_system"),
);
export const hostnames = breakdownHandler(
  DIMENSIONS.hostnames,
  ["hostname", ...M],
  simple("hostname"),
);
export const countries = breakdownHandler(
  DIMENSIONS.countries,
  ["country", "image", ...M],
  (r, qc) => {
    const code = r.values[0] ?? "";
    return {
      country: countryName(code),
      image: flagEmoji(code),
      code,
      visitors: r.visitors,
      ...money(r, qc),
    };
  },
);
const pageRenderer: Renderer = (r, qc) => ({
  hostname: r.values[0] ?? "",
  path: r.values[1] ?? "",
  visitors: r.visitors,
  ...money(r, qc),
});
export const entryPages = breakdownHandler(
  DIMENSIONS.entryPages,
  ["hostname", "path", ...M],
  pageRenderer,
);
export const exitPages = breakdownHandler(
  DIMENSIONS.exitPages,
  ["hostname", "path", ...M],
  pageRenderer,
);

const CAMPAIGN_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
  "source",
  "via",
] as const;

export const campaigns: AnalyticsHandler = async (c, site, view) => {
  const fields = visibleFields(parseFields(c.req.query("fields"), [...CAMPAIGN_KEYS, ...M]), view);
  const page = parsePagination(c.req.query(), { max: 1000 });
  const qc = buildQueryContext(c, site, { publicView: view.publicView });
  const campaignKeys = CAMPAIGN_KEYS.filter((k) => (fields as string[]).includes(k));
  return withCache(c, qc, async () => {
    const result = await runBreakdown(qc, DIMENSIONS.campaigns, page);
    const data = result.rows.map((r) => {
      const campaign: Record<string, string> = {};
      CAMPAIGN_KEYS.forEach((k, i) => {
        if (campaignKeys.includes(k)) campaign[k] = r.values[i] ?? "";
      });
      const row: Record<string, unknown> = campaignKeys.length ? { campaign } : {};
      return { ...row, ...pick({ visitors: r.visitors, ...money(r, qc) }, fields) };
    });
    return success(c, data, { pagination: paginationOf(page.limit, page.offset, result.total) });
  });
};

// ---------------------------------------------------------------------------
// Event breakdowns
// ---------------------------------------------------------------------------

export const pages: AnalyticsHandler = async (c, site, view) => {
  const fields = visibleFields(
    parseFields(c.req.query("fields"), ["hostname", "path", ...M, "pageviews"]),
    view,
  );
  const page = parsePagination(c.req.query(), { max: 1000 });
  const qc = buildQueryContext(c, site, { publicView: view.publicView });
  return withCache(c, qc, async () => {
    const result = await pagesBreakdown(qc, page);
    const data = result.rows.map((r) =>
      pick(
        {
          hostname: r.hostname,
          path: r.path,
          visitors: r.visitors,
          ...money(r, qc),
          pageviews: r.pageviews,
        },
        fields,
      ),
    );
    return success(c, data, {
      pagination: paginationOf(page.limit, page.offset, result.total),
      extra: extraFlags(result.approximate),
    });
  });
};

export const exitClicksHandler: AnalyticsHandler = async (c, site, view) => {
  const fields = parseFields(c.req.query("fields"), ["url", "visitors", "clicks"] as const);
  const page = parsePagination(c.req.query(), { max: 1000 });
  const qc = buildQueryContext(c, site, { publicView: view.publicView });
  return withCache(c, qc, async () => {
    const result = await exitClicks(qc, page);
    return success(
      c,
      result.rows.map((r) => pick(r, fields)),
      { pagination: paginationOf(page.limit, page.offset, result.total) },
    );
  });
};

export const goals: AnalyticsHandler = async (c, site, view) => {
  const rawFields = c.req.query("fields");
  const fields = parseFields(rawFields, ["name", "completions", "visitors"] as const);
  const withExtras = !rawFields;
  const page = parsePagination(c.req.query(), { max: 1000 });
  const qc = buildQueryContext(c, site, { publicView: view.publicView });
  return withCache(c, qc, async () => {
    const result = await goalsBreakdown(qc, page, withExtras);
    const data = result.rows.map((r) => {
      const row: Record<string, unknown> = {};
      if (fields.includes("name")) row.goal = r.goal;
      if (fields.includes("completions")) row.completions = r.completions;
      if (fields.includes("visitors")) row.visitors = r.visitors;
      if (withExtras) {
        if (view.showRevenue) row.revenue = toMajor(r.revenueMinor, site.currency);
        row.conversion_rate =
          result.totalVisitors > 0
            ? Math.round(
                (10000 * Math.min(r.visitors, result.totalVisitors)) / result.totalVisitors,
              ) / 100
            : 0;
      }
      return row;
    });
    return success(c, data, {
      pagination: paginationOf(page.limit, page.offset, result.total),
      extra: extraFlags(result.approximate),
    });
  });
};

const GOAL_PROPERTY_PARAMS = new Set([
  "websiteId",
  "eventName",
  "propertyName",
  "startAt",
  "endAt",
  "timezone",
  "limit",
  "offset",
  "fields",
]);

export const goalPropertiesHandler: AnalyticsHandler = async (c, site, view) => {
  const params = new URL(c.req.url).searchParams;
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) throw new ApiError(400, `Duplicate query parameter: ${key}`);
    seen.add(key);
    if (!GOAL_PROPERTY_PARAMS.has(key) && !key.startsWith("filter_")) {
      throw new ApiError(400, `Unsupported query parameter: ${key}`);
    }
  }
  const eventName = params.get("eventName") ?? "";
  if (!eventName) throw new ApiError(400, "eventName is required");
  if (!GOAL_NAME_RE.test(eventName)) {
    throw new ApiError(400, "Invalid eventName: 1-64 lowercase letters, digits, _, - or :");
  }
  const propertyName = params.get("propertyName");
  if (propertyName !== null && (propertyName.length < 1 || propertyName.length > 200)) {
    throw new ApiError(400, "Invalid propertyName: 1-200 characters");
  }
  const label = propertyName ? "value" : "property";
  const fields = parseFields(params.get("fields") ?? undefined, [label, "completions", "visitors"]);
  const page = parsePagination(c.req.query(), { max: 1000 });
  const qc = buildQueryContext(c, site, {
    publicView: view.publicView,
    allowedFilters: GOAL_PROPERTY_FILTERS,
  });
  return withCache(c, qc, async () => {
    const result = await goalProperties(qc, eventName, propertyName, page);
    return success(
      c,
      result.rows.map((r) =>
        pick({ [label]: r.value, completions: r.completions, visitors: r.visitors }, fields),
      ),
      {
        pagination: paginationOf(page.limit, page.offset, result.total),
        extra: {
          meta: {
            eventName,
            propertyName: propertyName ?? null,
            timezone: qc.timezone,
            startAt: qc.range ? new Date(qc.range.startMs).toISOString() : null,
            endAt: qc.range ? new Date(qc.range.endMs - 1).toISOString() : null,
          },
        },
      },
    );
  });
};

export const heatmap: AnalyticsHandler = async (c, site, view) => {
  const qc = buildQueryContext(c, site, { publicView: view.publicView, defaultRange: last30Days });
  const range = qc.range as DateRange;
  return withCache(c, qc, async () => {
    const cells = await pageviewHeatmap({ ...qc, range });
    return success(c, cells, {
      extra: {
        timezone: qc.timezone,
        startAt: new Date(range.startMs).toISOString(),
        endAt: new Date(range.endMs - 1).toISOString(),
      },
    });
  });
};

export const funnelResults: AnalyticsHandler = async (c, site, view) => {
  const funnelId = c.req.param("funnelId") ?? "";
  if (!isObjectIdLike(funnelId)) throw new ApiError(400, "Invalid funnelId");
  const qc = buildQueryContext(c, site, { publicView: view.publicView });
  const row = await c.env.DB.prepare(
    "SELECT id, name, slug, steps FROM funnels WHERE id = ? AND site_id = ? AND is_active = 1",
  )
    .bind(funnelId, site.id)
    .first<{ id: string; name: string; slug: string; steps: string }>();
  if (!row) throw new ApiError(404, "Funnel not found");
  const steps = parseJsonColumn<FunnelStep[]>(row.steps, []);
  return withCache(c, qc, async () => {
    const results = await computeFunnel(qc, steps);
    const rendered = renderFunnelResult(
      qc,
      { id: row.id, name: row.name, slug: row.slug, steps },
      results,
    );
    if (!view.showRevenue) {
      for (const d of rendered.data) d.revenue = 0;
      rendered.metrics.overallRevenuePerVisitor = 0;
    }
    return success(c, [rendered]);
  });
};

/** Endpoints served by public share links (name → handler). */
export const SHARED_ENDPOINTS: Record<string, AnalyticsHandler> = {
  overview,
  timeseries,
  realtime,
  "realtime/map": realtimeMapHandler,
  "realtime/replay": realtimeReplayHandler,
  pages,
  "entry-pages": entryPages,
  "exit-pages": exitPages,
  "exit-clicks": exitClicksHandler,
  referrers,
  channels,
  campaigns,
  countries,
  regions,
  cities,
  devices,
  browsers,
  "operating-systems": operatingSystems,
  hostnames,
  goals,
  heatmap,
};
