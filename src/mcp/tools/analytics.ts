/** Read tools over `/api/v1/analytics/*`, visitors, mentions and bot traffic. */
import { z } from "zod";
import type { Permission } from "../../../shared/permissions";
import { resolvePeriod } from "../periods";
import {
  type Args,
  enc,
  filterQuery,
  type Owner,
  paginationArgs,
  rangeArgs,
  rangeQuery,
  type ToolContext,
  type ToolDef,
  zFields,
  zFilters,
  zWebsiteId,
} from "./kit";

const A = "/api/v1/analytics";

interface AnalyticsToolOptions {
  name: string;
  title: string;
  description: string;
  path: string;
  owner?: Owner;
  range?: boolean;
  filters?: boolean;
  pagination?: boolean;
  fields?: boolean;
  oauth?: string[];
  permission?: Permission;
  extra?: z.ZodRawShape;
  query?: (args: Args) => Record<string, string | number | boolean | undefined>;
  pathOf?: (args: Args) => string;
}

function analyticsTool(o: AnalyticsToolOptions): ToolDef {
  const shape: Record<string, z.ZodType> = { websiteId: zWebsiteId.optional() };
  if (o.range !== false) Object.assign(shape, rangeArgs);
  if (o.filters !== false) shape.filters = zFilters;
  if (o.fields) shape.fields = zFields;
  if (o.pagination) Object.assign(shape, paginationArgs);
  Object.assign(shape, o.extra ?? {});
  return {
    name: o.name,
    title: o.title,
    description: o.description,
    input: z.object(shape).strict(),
    access: "read",
    permission: o.permission ?? "analytics:read",
    oauth: o.oauth ?? ["analytics:read"],
    owner: o.owner ?? "W2",
    site: true,
    request: async (args: Args, tc: ToolContext) => ({
      method: "GET",
      path: o.pathOf ? o.pathOf(args) : o.path,
      query: {
        websiteId: tc.siteRef(args),
        ...(o.range !== false ? await rangeQuery(args, tc, resolvePeriod) : {}),
        ...(o.filters !== false ? filterQuery(args.filters) : {}),
        fields: args.fields,
        limit: args.limit,
        offset: args.offset,
        ...(o.query ? o.query(args) : {}),
      },
    }),
  };
}

const BREAKDOWNS: Array<[name: string, slug: string, label: string, dg?: boolean]> = [
  ["pages", "pages", "Top pages by visitors, with attributed revenue and payments"],
  ["entry_pages", "entry-pages", "Landing pages (first page of each session)", true],
  ["exit_pages", "exit-pages", "Exit pages (last page of each session)", true],
  ["exit_clicks", "exit-clicks", "Outbound link destinations by unique visitors and clicks"],
  ["referrers", "referrers", "Traffic sources (referrer display name or domain)"],
  ["channels", "channels", "Acquisition channels (organic search, social, paid, …)", true],
  ["campaigns", "campaigns", "UTM campaigns and ref/source/via parameters"],
  ["countries", "countries", "Countries"],
  ["regions", "regions", "Regions and states"],
  ["cities", "cities", "Cities"],
  ["devices", "devices", "Device types (desktop, mobile, tablet)"],
  ["browsers", "browsers", "Browsers"],
  ["operating_systems", "operating-systems", "Operating systems"],
  ["hostnames", "hostnames", "Hostnames (multi-domain websites)"],
];

export const analyticsTools: ToolDef[] = [
  analyticsTool({
    name: "analytics_overview",
    title: "Analytics overview",
    description:
      "Visitors, sessions, pageviews, bounce rate, average session duration, revenue, payments, revenue per visitor and conversion rate for a date range (default: all time).",
    path: `${A}/overview`,
    fields: true,
  }),
  analyticsTool({
    name: "analytics_timeseries",
    title: "Analytics time series",
    description:
      "Metrics bucketed by hour, day, week or month for charts. Default fields: name, visitors, sessions, pageviews, revenue, payments, conversion_rate. Without a range the API uses 24 h (hour), 30 days (day/week) or 12 months (month).",
    path: `${A}/timeseries`,
    fields: true,
    pagination: true,
    extra: {
      interval: z
        .enum(["hour", "day", "week", "month"])
        .optional()
        .describe("Bucket size (default day)."),
    },
    query: (args) => ({
      interval: args.interval ?? "day",
      fields: args.fields ?? "name,visitors,sessions,pageviews,revenue,payments,conversion_rate",
    }),
  }),
  analyticsTool({
    name: "analytics_realtime",
    title: "Realtime visitors",
    description: "Number of visitors active in the last 10 minutes.",
    path: `${A}/realtime`,
    range: false,
    filters: false,
  }),
  analyticsTool({
    name: "analytics_realtime_map",
    title: "Realtime map",
    description:
      "Active visitors in the last ~10 minutes with location, current page, recent events and payments.",
    path: `${A}/realtime/map`,
    range: false,
    filters: false,
    oauth: ["analytics:read", "visitors:read", "visitors:details"],
  }),
  analyticsTool({
    name: "analytics_metadata",
    title: "Website metadata",
    description: "Display metadata for a website: domain, name, timezone, currency and KPI.",
    path: `${A}/metadata`,
    range: false,
    filters: false,
    fields: true,
  }),
  ...BREAKDOWNS.map(([name, slug, label, dg]) =>
    analyticsTool({
      name: `analytics_${name}`,
      title: `Breakdown: ${name.replace(/_/g, " ")}`,
      description: `${label}, sorted by visitors. Revenue on breakdown rows is attributed revenue.${dg ? " (DataGoat extension.)" : ""}`,
      path: `${A}/${slug}`,
      fields: true,
      pagination: true,
    }),
  ),
  analyticsTool({
    name: "analytics_goals_breakdown",
    title: "Goals breakdown",
    description:
      "Completions and unique visitors per custom goal, with revenue and conversion rate.",
    path: `${A}/goals`,
    fields: true,
    pagination: true,
  }),
  analyticsTool({
    name: "analytics_goal_properties",
    title: "Goal parameter breakdown",
    description:
      "Breakdown of a custom goal's parameters. Without propertyName, lists the parameters recorded for the goal; with it, counts completions per value. Filters entry_page, hostname, visit_count, channel and goal are not accepted.",
    path: `${A}/goals/properties`,
    pagination: true,
    extra: {
      eventName: z.string().min(1).max(64).describe("Goal name, e.g. signup."),
      propertyName: z.string().min(1).max(64).optional().describe("Parameter to break down."),
    },
    query: (args) => ({ eventName: args.eventName, propertyName: args.propertyName }),
  }),
  analyticsTool({
    name: "analytics_funnel",
    title: "Funnel results",
    description:
      "Step-by-step visitors, conversion and drop-off for one funnel (ids from funnels_list).",
    path: `${A}/funnels`,
    pathOf: (args) => `${A}/funnels/${enc(args.funnelId)}`,
    extra: { funnelId: z.string().min(1).max(64).describe("Funnel id.") },
  }),
  analyticsTool({
    name: "analytics_revenue",
    title: "Revenue summary",
    description:
      "Revenue totals for a range: new vs renewal revenue, refunds, payments, MRR-style figures and the unattributed share. (DataGoat extension.)",
    path: `${A}/revenue`,
    owner: "W3",
  }),
  {
    name: "visitors_search",
    title: "Search visitors",
    description:
      "Find visitors by visited page, completed goal, geography, device, referrer, UTM or customer status. Returns visitor ids for visitors_get. Names and emails appear only for credentials allowed to see personal data.",
    input: z
      .object({
        websiteId: zWebsiteId.optional(),
        ...rangeArgs,
        limit: z.number().int().min(1).max(250).optional().describe("Default 100, max 250."),
        offset: z.number().int().min(0).optional(),
        visitedPage: z
          .string()
          .max(2000)
          .optional()
          .describe("Exact page path(s), comma-separated."),
        visitedPageContains: z.string().max(500).optional().describe("Partial page path match."),
        completedGoal: z.string().max(64).optional().describe("Visitors who completed this goal."),
        visitCount: z.number().int().min(1).optional().describe("All-time session number."),
        country: z.string().max(500).optional(),
        region: z.string().max(500).optional(),
        city: z.string().max(500).optional(),
        browser: z.string().max(500).optional(),
        os: z.string().max(500).optional(),
        device: z.string().max(100).optional(),
        referrer: z.string().max(500).optional(),
        hostname: z.string().max(500).optional(),
        utm_source: z.string().max(500).optional(),
        utm_medium: z.string().max(500).optional(),
        utm_campaign: z.string().max(500).optional(),
        utm_term: z.string().max(500).optional(),
        utm_content: z.string().max(500).optional(),
        ref: z.string().max(500).optional(),
        source: z.string().max(500).optional(),
        via: z.string().max(500).optional(),
        isCustomer: z.boolean().optional().describe("true: only visitors with payments."),
        q: z.string().max(200).optional().describe("Search user id, name or email (DataGoat)."),
      })
      .strict(),
    access: "read",
    permission: "analytics:read",
    oauth: ["analytics:read", "visitors:read"],
    owner: "W2",
    site: true,
    request: async (args, tc) => {
      const { websiteId: _w, period: _p, startAt: _s, endAt: _e, timezone: _t, ...rest } = args;
      return {
        method: "GET",
        path: "/api/v1/visitors",
        query: {
          websiteId: tc.siteRef(args),
          ...(await rangeQuery(args, tc, resolvePeriod)),
          ...rest,
        },
      };
    },
  },
  {
    name: "visitors_get",
    title: "Get visitor",
    description:
      "Full detail for one visitor: identity, acquisition, activity and completed goals timeline, sessions, payments, identify profile and conversion prediction.",
    input: z
      .object({
        websiteId: zWebsiteId.optional(),
        visitorId: z.string().min(1).max(128).describe("datafast_visitor_id (UUID v4)."),
      })
      .strict(),
    access: "read",
    permission: "analytics:read",
    oauth: ["analytics:read", "visitors:read"],
    owner: "W2",
    site: true,
    request: (args, tc) => ({
      method: "GET",
      path: `/api/v1/visitors/${enc(args.visitorId)}`,
      query: { websiteId: tc.siteRef(args) },
    }),
  },
  analyticsTool({
    name: "mentions_list",
    title: "Social mentions",
    description:
      "X and Reddit mentions of the website by date, text/author/URL search and platform. Defaults to the last 30 days.",
    path: "/api/v1/mentions",
    owner: "W6",
    filters: false,
    pagination: true,
    extra: {
      q: z.string().max(200).optional().describe("Search text, author or URL."),
      platform: z.enum(["x", "reddit"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    query: (args) => ({ q: args.q, platform: args.platform, order: args.order }),
  }),
  analyticsTool({
    name: "bot_traffic_summary",
    title: "Bot traffic summary",
    description:
      "AI answer, indexing, training and other crawler requests with verification, company and agent totals and a time series. Defaults to the last 30 days.",
    path: `${A}/bot-traffic`,
    owner: "W6",
    filters: false,
    extra: {
      interval: z.enum(["hour", "day", "week", "month"]).optional(),
      category: z.string().max(40).optional(),
      verification: z.string().max(40).optional(),
      company: z.string().max(100).optional(),
      crawlerId: z.string().max(100).optional(),
    },
    query: (args) => ({
      interval: args.interval,
      category: args.category,
      verification: args.verification,
      company: args.company,
      crawlerId: args.crawlerId,
    }),
  }),
  analyticsTool({
    name: "bot_traffic_pages",
    title: "Bot traffic pages",
    description: "Pages requested by crawlers with status-code and crawler breakdowns.",
    path: `${A}/bot-traffic/pages`,
    owner: "W6",
    filters: false,
    extra: {
      pageSearch: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
      category: z.string().max(40).optional(),
      verification: z.string().max(40).optional(),
      company: z.string().max(100).optional(),
      crawlerId: z.string().max(100).optional(),
    },
    query: (args) => ({
      pageSearch: args.pageSearch,
      category: args.category,
      verification: args.verification,
      company: args.company,
      crawlerId: args.crawlerId,
    }),
  }),
];
