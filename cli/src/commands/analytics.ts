/** analytics <report>, visitors, and the short aliases stats / breakdown / live / visitor. */
import type { FlagSpec } from "../args";
import { type Command, type Ctx, UsageError } from "../context";
import type { Column } from "../output";
import { ANALYTICS_FLAGS, filterParams, pageParams, RANGE_FLAGS, rangeParams } from "../segment";

interface Report {
  name: string;
  aliases?: string[];
  path: string;
  summary: string;
  range?: boolean;
  filters?: boolean;
  breakdown?: boolean;
  flags?: Record<string, FlagSpec>;
  query?: (ctx: Ctx) => Record<string, string | undefined>;
  columns?: Column[];
}

const money = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : v == null ? "-" : String(v));

const BREAKDOWN: Array<[string, string, string, string[]?]> = [
  ["pages", "pages", "Top pages"],
  ["entry-pages", "entry-pages", "Landing pages"],
  ["exit-pages", "exit-pages", "Exit pages"],
  ["exit-clicks", "exit-clicks", "Outbound link clicks"],
  ["referrers", "referrers", "Traffic sources"],
  ["channels", "channels", "Acquisition channels"],
  ["campaigns", "campaigns", "UTM campaigns"],
  ["countries", "countries", "Countries"],
  ["regions", "regions", "Regions"],
  ["cities", "cities", "Cities"],
  ["devices", "devices", "Devices"],
  ["browsers", "browsers", "Browsers"],
  ["os", "operating-systems", "Operating systems", ["operating-systems"]],
  ["hostnames", "hostnames", "Hostnames"],
  ["goals", "goals", "Custom goals"],
];

export const REPORTS: Report[] = [
  {
    name: "overview",
    path: "overview",
    summary: "Visitors, sessions, bounce rate, revenue, conversion rate",
  },
  {
    name: "timeseries",
    path: "timeseries",
    summary: "Metrics over time (--interval hour|day|week|month)",
    flags: {
      interval: {
        type: "string",
        value: "<interval>",
        description: "hour, day (default), week, month",
      },
    },
    query: (ctx) => ({
      interval: ctx.flags.string("interval") ?? "day",
      fields:
        ctx.flags.string("fields") ??
        "name,visitors,sessions,pageviews,revenue,payments,conversion_rate",
    }),
    columns: [
      { key: "name", label: "period" },
      { key: "visitors" },
      { key: "sessions" },
      { key: "pageviews" },
      { key: "revenue", format: money },
      { key: "payments" },
      { key: "conversion_rate", label: "conv %" },
    ],
  },
  {
    name: "realtime",
    aliases: ["live"],
    path: "realtime",
    summary: "Visitors active now",
    range: false,
    filters: false,
  },
  {
    name: "realtime-map",
    aliases: ["map"],
    path: "realtime/map",
    summary: "Active visitors with location and current page",
    range: false,
    filters: false,
  },
  {
    name: "metadata",
    path: "metadata",
    summary: "Website display metadata",
    range: false,
    filters: false,
  },
  ...BREAKDOWN.map(([name, path, summary, aliases]) => ({
    name,
    path,
    summary: `${summary} (attributed revenue)`,
    breakdown: true,
    ...(aliases ? { aliases } : {}),
  })),
  {
    name: "goal-properties",
    path: "goals/properties",
    summary: "Parameters of a goal, or counts per value (--event, --property)",
    breakdown: true,
    flags: {
      event: { type: "string", value: "<goal>", description: "Goal name (required)" },
      property: { type: "string", value: "<name>", description: "Parameter to break down" },
    },
    query: (ctx) => {
      const event = ctx.flags.string("event");
      if (!event) throw new UsageError("--event <goal name> is required");
      return { eventName: event, propertyName: ctx.flags.string("property") };
    },
  },
  { name: "revenue", path: "revenue", summary: "Revenue summary: new, renewals, refunds" },
];

async function runReport(report: Report, ctx: Ctx): Promise<void> {
  const site = await ctx.siteQuery();
  const query = {
    ...(report.range === false ? {} : await rangeParams(ctx, site)),
    ...(report.filters === false ? {} : filterParams(ctx)),
    ...(report.breakdown ? pageParams(ctx, 50) : pageParams(ctx)),
    fields: ctx.flags.string("fields"),
    ...(report.query ? report.query(ctx) : {}),
  };
  const res = await ctx.client().analytics(report.path, site, query);
  if (ctx.json) return ctx.out(`${JSON.stringify(res.data)}\n`);
  ctx.print(res.data, report.columns);
  const totals = (res as { totals?: Record<string, unknown> }).totals;
  if (totals) ctx.out(`\nTotals: ${JSON.stringify(totals)}\n`);
  if (res.pagination?.hasMore) {
    ctx.info(`More rows: --offset ${(res.pagination.offset ?? 0) + (res.pagination.limit ?? 0)}`);
  }
}

function reportCommand(report: Report): Command {
  const flags: Record<string, FlagSpec> =
    report.range === false && report.filters === false
      ? {}
      : { ...ANALYTICS_FLAGS, ...(report.flags ?? {}) };
  return {
    name: report.name,
    ...(report.aliases ? { aliases: report.aliases } : {}),
    summary: report.summary,
    flags,
    run: (ctx) => runReport(report, ctx),
  };
}

export const analyticsCommand: Command = {
  name: "analytics",
  summary: "Query analytics: overview, timeseries, breakdowns, realtime",
  sub: REPORTS.map(reportCommand),
};

const VISITOR_FLAGS: Record<string, FlagSpec> = {
  ...RANGE_FLAGS,
  limit: { type: "string", value: "<n>", description: "Max rows (default 100, max 250)" },
  offset: { type: "string", value: "<n>", description: "Rows to skip" },
  "visited-page": { type: "string", value: "<path>", description: "Visited this exact page" },
  "visited-page-contains": {
    type: "string",
    value: "<text>",
    description: "Visited a page containing",
  },
  "completed-goal": { type: "string", value: "<goal>", description: "Completed this goal" },
  "visit-count": { type: "multi", value: "<n>", description: "All-time session number" },
  "is-customer": { type: "boolean", description: "Only visitors with payments" },
  search: { type: "string", value: "<text>", description: "Search user id, name or email" },
  ...Object.fromEntries(
    [
      "country",
      "region",
      "city",
      "browser",
      "os",
      "device",
      "referrer",
      "hostname",
      "utm-source",
      "utm-medium",
      "utm-campaign",
      "utm-term",
      "utm-content",
      "ref",
      "source",
      "via",
    ].map((k) => [k, { type: "multi" as const, value: "<value>", description: `Filter by ${k}` }]),
  ),
};

const visitorsList: Command = {
  name: "list",
  aliases: ["search"],
  summary: "Search visitors by page, goal, source, location, device, customer status",
  flags: VISITOR_FLAGS,
  run: async (ctx) => {
    const site = await ctx.siteQuery();
    const join = (k: string) =>
      ctx.flags.list(k).length ? ctx.flags.list(k).join(",") : undefined;
    const query = {
      ...(await rangeParams(ctx, site)),
      limit: ctx.flags.int("limit", { min: 1, max: 250 }),
      offset: ctx.flags.int("offset", { min: 0 }),
      visitedPage: ctx.flags.string("visited-page"),
      visitedPageContains: ctx.flags.string("visited-page-contains"),
      completedGoal: ctx.flags.string("completed-goal"),
      visitCount: ctx.flags.list("visit-count")[0],
      isCustomer: ctx.flags.bool("is-customer") ? true : undefined,
      q: ctx.flags.string("search"),
      country: join("country"),
      region: join("region"),
      city: join("city"),
      browser: join("browser"),
      os: join("os"),
      device: join("device"),
      referrer: join("referrer"),
      hostname: join("hostname"),
      utm_source: join("utm-source"),
      utm_medium: join("utm-medium"),
      utm_campaign: join("utm-campaign"),
      utm_term: join("utm-term"),
      utm_content: join("utm-content"),
      ref: join("ref"),
      source: join("source"),
      via: join("via"),
    };
    const res = await ctx.client().visitors(site, query);
    if (ctx.json) return ctx.out(`${JSON.stringify(res.data)}\n`);
    ctx.print(res.data, [
      { key: "visitorId", label: "visitor" },
      { key: "lastSeenAt", label: "last seen" },
      { key: "visitorType", label: "type" },
      { key: "identity.country", label: "country" },
      { key: "identity.device", label: "device" },
      { key: "currentUrl", label: "page" },
    ]);
    if (res.pagination?.total !== undefined) ctx.info(`${res.pagination.total} visitors match.`);
  },
};

const visitorsGet: Command = {
  name: "get",
  summary: "Identity, activity, goals, payments and prediction for one visitor",
  usage: "<visitorId>",
  run: async (ctx) => {
    const site = await ctx.siteQuery();
    const id = await ctx.arg(0, "<visitorId>", "Visitor id");
    const profile = await ctx.client().visitor(site, id);
    if (ctx.json) return ctx.out(`${JSON.stringify(profile)}\n`);
    ctx.out(`${JSON.stringify(profile, null, 2)}\n`);
  },
};

export const visitorsCommand: Command = {
  name: "visitors",
  summary: "Search visitors and inspect one",
  sub: [visitorsList, visitorsGet],
};

const byName = (name: string) => REPORTS.find((r) => r.name === name) as Report;

/** Short aliases from the plan: stats, breakdown <dimension>, live, visitor <id>. */
export const aliasCommands: Command[] = [
  {
    ...reportCommand(byName("overview")),
    name: "stats",
    summary: "Alias of analytics overview",
    hidden: true,
  },
  {
    name: "breakdown",
    summary: "Alias of analytics <dimension>",
    hidden: true,
    flags: ANALYTICS_FLAGS,
    run: async (ctx) => {
      const dim = await ctx.arg(0, "<dimension>", "Dimension (pages, referrers, countries, …)");
      const report = REPORTS.find(
        (r) => r.breakdown && (r.name === dim || r.aliases?.includes(dim)),
      );
      if (!report) {
        throw new UsageError(
          `Unknown dimension ${dim}. Use one of: ${REPORTS.filter((r) => r.breakdown)
            .map((r) => r.name)
            .join(", ")}`,
        );
      }
      await runReport(report, ctx);
    },
  },
  {
    ...reportCommand(byName("realtime")),
    name: "live",
    aliases: [],
    summary: "Alias of analytics realtime",
    hidden: true,
  },
  { ...visitorsGet, name: "visitor", summary: "Alias of visitors get", hidden: true },
];
