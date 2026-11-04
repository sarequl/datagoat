/**
 * Deterministic traffic model behind the analytics mocks, so mock-mode screenshots look like a
 * real product: ~210 visitors/day with weekly seasonality and slow growth, a Hacker News spike,
 * ~42% bounce, ~2% conversion at ~$80 per payment, channels led by Organic Search. Every endpoint
 * (overview, timeseries, breakdowns, revenue) derives from the same daily numbers, so KPIs, chart
 * and cards agree for any range, and filters scale them down.
 */
import type {
  Overview,
  RealtimeMap,
  RealtimeReplay,
  RevenueSummary,
  TimeseriesPoint,
} from "../../../../shared/api-types";
import { seeded } from "./analytics";

export const MOCK_TZ = "America/New_York";
const DAY = 86_400_000;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stable noise in [0, 1) for a key. */
export function noise(key: string): number {
  return seeded(hash(key))();
}

function tzOffset(ms: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return (
    Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) - ms
  );
}

/** UTC instant of local midnight of `day` (YYYY-MM-DD) in `tz`. */
export function localMidnight(day: string, tz: string): number {
  const guess = Date.parse(`${day}T00:00:00Z`);
  return guess - tzOffset(guess - tzOffset(guess, tz), tz);
}

export function localDay(ms: number, tz: string): string {
  return new Date(ms + tzOffset(ms, tz)).toISOString().slice(0, 10);
}

const addDay = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** The demo website's creation day (fixtures/core.ts). */
const SITE_START = "2026-01-01";

/** Days before "today" of the Hacker News front-page spike. */
const SPIKE_DAYS_AGO = 23;

export interface DayStats {
  visitors: number;
  pageviews: number;
  sessions: number;
  bounces: number;
  durationSum: number;
  payments: number;
  revenue: number;
  newVisitors: number;
}

export function dayStats(day: string, now = Date.now()): DayStats {
  const today = localDay(now, MOCK_TZ);
  const ago = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY);
  if (ago < 0 || day < SITE_START)
    return {
      visitors: 0,
      pageviews: 0,
      sessions: 0,
      bounces: 0,
      durationSum: 0,
      payments: 0,
      revenue: 0,
      newVisitors: 0,
    };
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
  const weekday = wd === 0 ? 0.68 : wd === 6 ? 0.74 : wd === 1 ? 1.08 : 1;
  const growth = 1 - Math.min(ago, 400) * 0.0012;
  const n = 0.85 + noise(`v${day}`) * 0.3;
  const spike =
    ago === SPIKE_DAYS_AGO
      ? 2350
      : ago === SPIKE_DAYS_AGO - 1
        ? 780
        : ago === SPIKE_DAYS_AGO - 2
          ? 240
          : 0;
  let visitors = Math.round(228 * weekday * growth * n + spike);
  // "today" is still in progress
  if (ago === 0) {
    const elapsed = (now - localMidnight(today, MOCK_TZ)) / DAY;
    visitors = Math.round(visitors * Math.max(0.05, Math.min(1, elapsed)));
  }
  const bounceRate = (spike ? 0.58 : 0.4) + noise(`b${day}`) * 0.05;
  const sessions = Math.round(visitors * (1.16 + noise(`s${day}`) * 0.06));
  const payRate = spike ? 0.007 : 0.019 + noise(`c${day}`) * 0.008;
  const payments = Math.round(visitors * payRate + (noise(`p${day}`) > 0.6 ? 1 : 0));
  const avg = 62 + noise(`a${day}`) * 34;
  return {
    visitors,
    pageviews: Math.round(sessions * (1.55 + noise(`pv${day}`) * 0.25)),
    sessions,
    bounces: Math.round(sessions * bounceRate),
    durationSum: Math.round(sessions * (spike ? 41 : 84)),
    payments,
    revenue: Math.round(payments * avg * 100) / 100,
    newVisitors: Math.round(visitors * (spike ? 0.86 : 0.36 + noise(`n${day}`) * 0.08)),
  };
}

/** Diurnal share of a day's traffic for local hour `h` (sums to 1). */
const HOUR_WEIGHTS = (() => {
  const w = Array.from(
    { length: 24 },
    (_, h) => 0.25 + Math.exp(-((h - 14.5) ** 2) / 18) + 0.35 * Math.exp(-((h - 9.5) ** 2) / 6),
  );
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / total);
})();

export interface Range {
  startMs: number;
  endMs: number;
  days: string[];
}

function parseBound(v: string | null, tz: string, end: boolean): number | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v))
    return end ? localMidnight(addDay(v, 1), tz) - 1 : localMidnight(v, tz);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

export function rangeFrom(url: URL, fallbackDays = 30, now = Date.now()): Range {
  const tz = url.searchParams.get("timezone") || MOCK_TZ;
  let startMs = parseBound(url.searchParams.get("startAt"), tz, false);
  let endMs = parseBound(url.searchParams.get("endAt"), tz, true);
  if (startMs === null || endMs === null) {
    endMs = now;
    startMs = localMidnight(addDay(localDay(now, tz), -(fallbackDays - 1)), tz);
  }
  endMs = Math.min(endMs, now);
  const days: string[] = [];
  for (
    let d = localDay(startMs, tz);
    localMidnight(d, tz) <= endMs && days.length < 2000;
    d = addDay(d, 1)
  )
    days.push(d);
  return { startMs, endMs, days };
}

/** Filters shrink the numbers so filtered views look filtered. */
export function filterFactor(url: URL): number {
  let f = 1;
  for (const [k, v] of url.searchParams) {
    if (!k.startsWith("filter_")) continue;
    const not = v.startsWith("is_not:") || v.startsWith("does_not_contain:");
    f *= not ? 0.82 : 0.18 + noise(`${k}=${v}`) * 0.3;
  }
  return f;
}

function sumDays(days: string[], now: number): DayStats {
  const t: DayStats = {
    visitors: 0,
    pageviews: 0,
    sessions: 0,
    bounces: 0,
    durationSum: 0,
    payments: 0,
    revenue: 0,
    newVisitors: 0,
  };
  for (const d of days) {
    const s = dayStats(d, now);
    for (const k of Object.keys(t) as (keyof DayStats)[]) t[k] += s[k];
  }
  return t;
}

/** Partial-day fraction of a range covering instants (Now, Last 24 hours). */
function instantFraction(range: Range, url: URL): number {
  const start = url.searchParams.get("startAt");
  if (!start || /^\d{4}-\d{2}-\d{2}$/.test(start)) return 1;
  return Math.min(1, (range.endMs - range.startMs) / (range.days.length * DAY));
}

export function overviewFor(url: URL, now = Date.now()): Overview {
  const range = rangeFrom(url, 3650, now);
  const f = filterFactor(url) * instantFraction(range, url);
  const s = sumDays(range.days, now);
  const unique = range.days.length > 1 ? 0.86 : 1;
  const visitors = Math.round(s.visitors * f * unique);
  const newV = Math.round(s.newVisitors * f * unique);
  const revenue = Math.round(s.revenue * f * 100) / 100;
  const payments = Math.round(s.payments * f);
  return {
    visitors,
    new_visitors: newV,
    returning_visitors: visitors - newV,
    visitorBreakdown: {
      new: newV,
      returning: visitors - newV,
      newPercentage: visitors ? Math.round((newV / visitors) * 10000) / 100 : 0,
      returningPercentage: visitors ? Math.round(((visitors - newV) / visitors) * 10000) / 100 : 0,
    },
    pageviews: Math.round(s.pageviews * f),
    sessions: Math.round(s.sessions * f),
    bounce_rate: s.sessions ? Math.round((s.bounces / s.sessions) * 10000) / 100 : 0,
    avg_session_duration: s.sessions ? Math.round(s.durationSum / s.sessions) : 0,
    currency: "USD",
    revenue,
    payments,
    revenue_per_visitor: visitors ? Math.round((revenue / visitors) * 100) / 100 : 0,
    conversion_rate: visitors ? Math.round((payments / visitors) * 10000) / 100 : 0,
  };
}

const GOAL_RATES: Record<string, number> = {
  signup: 0.052,
  checkout_started: 0.031,
  newsletter_subscribe: 0.018,
  scroll_to_pricing: 0.21,
  free_trial: 0.012,
};

function point(
  timestamp: number,
  s: DayStats,
  share: number,
  f: number,
  key: string,
): TimeseriesPoint {
  const visitors = Math.round(s.visitors * share * f);
  const newV = Math.round(s.newVisitors * share * f);
  const payments =
    share >= 0.5
      ? Math.round(s.payments * share * f)
      : noise(`pay${key}`) < s.payments * share * f
        ? 1
        : 0;
  const revenue = s.payments ? Math.round((s.revenue / s.payments) * payments * 100) / 100 : 0;
  const goals: Record<string, number> = { payment: payments };
  for (const [g, r] of Object.entries(GOAL_RATES))
    goals[g] = Math.round(visitors * r * (0.8 + noise(`${g}${key}`) * 0.4));
  return {
    timestamp: new Date(timestamp).toISOString(),
    visitors,
    new_visitors: newV,
    returning_visitors: visitors - newV,
    pageviews: Math.round(s.pageviews * share * f),
    sessions: Math.round(s.sessions * share * f),
    revenue,
    payments,
    conversion_rate: visitors ? Math.round((payments / visitors) * 10000) / 100 : 0,
    bounce_rate: s.sessions ? Math.round((s.bounces / s.sessions) * 10000) / 100 : 0,
    avg_session_duration: s.sessions ? Math.round(s.durationSum / s.sessions) : 0,
    goals,
  };
}

export function timeseriesFor(url: URL, now = Date.now()): TimeseriesPoint[] {
  const interval = url.searchParams.get("interval") ?? "day";
  const tz = url.searchParams.get("timezone") || MOCK_TZ;
  const range = rangeFrom(url, interval === "hour" ? 1 : interval === "month" ? 365 : 30, now);
  const f = filterFactor(url);
  const out: TimeseriesPoint[] = [];
  if (interval === "minute" || interval === "hour") {
    const step = interval === "minute" ? 60_000 : 3_600_000;
    const start = Math.floor(range.startMs / step) * step;
    for (let t = start; t <= range.endMs && out.length < 1000; t += step) {
      const day = localDay(t, tz);
      const hour = new Date(t + tzOffset(t, tz)).getUTCHours();
      const s = dayStats(day, now);
      const elapsedShare =
        day === localDay(now, tz) ? Math.max(0.05, (now - localMidnight(day, tz)) / DAY) : 1;
      let share = (HOUR_WEIGHTS[hour] ?? 0) / elapsedShare;
      if (interval === "minute") share = share / 60;
      if (t > now) share = 0;
      out.push(point(t, s, share, f, `${interval}${t}`));
    }
    return out;
  }
  const groups: Array<{ start: string; days: string[] }> = [];
  for (const d of range.days) {
    const last = groups.at(-1);
    const sameBucket =
      last &&
      ((interval === "week" && last.days.length < 7) ||
        (interval === "month" && last.start.slice(0, 7) === d.slice(0, 7)));
    if (sameBucket) last.days.push(d);
    else groups.push({ start: d, days: [d] });
  }
  for (const g of groups) {
    const s = sumDays(g.days, now);
    out.push(
      point(localMidnight(g.start, tz), s, g.days.length > 1 ? 0.9 : 1, f, `${interval}${g.start}`),
    );
  }
  return out;
}

// Breakdowns -----------------------------------------------------------------

type Share = [string, number, number?];

/** [label, visitor share, revenue share (defaults to visitor share)] */
export const SHARES: Record<string, Share[]> = {
  channels: [
    ["Organic Search", 0.34, 0.37],
    ["Direct", 0.24, 0.27],
    ["Referral", 0.16, 0.12],
    ["Organic Social", 0.11, 0.07],
    ["AI", 0.06, 0.09],
    ["Paid Search", 0.04, 0.05],
    ["Email", 0.025, 0.03],
    ["Newsletter", 0.015, 0.008],
    ["Affiliate", 0.01, 0.002],
  ],
  referrers: [
    ["Google", 0.29, 0.32],
    ["Direct / None", 0.24, 0.27],
    ["Hacker News", 0.08, 0.035],
    ["X", 0.055, 0.03],
    ["ChatGPT", 0.035, 0.055],
    ["Reddit", 0.03, 0.02],
    ["Bing", 0.028, 0.03],
    ["Product Hunt", 0.022, 0.02],
    ["LinkedIn", 0.02, 0.025],
    ["DuckDuckGo", 0.018, 0.015],
    ["Perplexity", 0.014, 0.022],
    ["GitHub", 0.014, 0.01],
    ["Claude", 0.01, 0.013],
    ["indiehackers.com", 0.009, 0.006],
  ],
  pages: [
    ["/", 0.62, 0.3],
    ["/pricing", 0.27, 0.34],
    ["/blog/how-we-hit-10k-mrr", 0.15, 0.04],
    ["/features", 0.12, 0.06],
    ["/docs/getting-started", 0.09, 0.08],
    ["/signup", 0.08, 0.12],
    ["/blog/cloudflare-d1-analytics", 0.07, 0.02],
    ["/integrations/stripe", 0.05, 0.03],
    ["/changelog", 0.04, 0.005],
    ["/about", 0.025, 0.003],
  ],
  "entry-pages": [
    ["/", 0.48, 0.41],
    ["/blog/how-we-hit-10k-mrr", 0.13, 0.05],
    ["/pricing", 0.11, 0.24],
    ["/blog/cloudflare-d1-analytics", 0.06, 0.03],
    ["/docs/getting-started", 0.05, 0.08],
    ["/features", 0.04, 0.06],
    ["/integrations/stripe", 0.03, 0.04],
  ],
  "exit-pages": [
    ["/", 0.36, 0.1],
    ["/pricing", 0.17, 0.2],
    ["/blog/how-we-hit-10k-mrr", 0.12, 0.03],
    ["/signup", 0.06, 0.35],
    ["/docs/getting-started", 0.05, 0.07],
    ["/features", 0.04, 0.04],
  ],
  countries: [
    ["US", 0.37, 0.46],
    ["GB", 0.08, 0.09],
    ["DE", 0.07, 0.08],
    ["IN", 0.065, 0.02],
    ["CA", 0.045, 0.06],
    ["FR", 0.04, 0.045],
    ["NL", 0.025, 0.03],
    ["BR", 0.024, 0.01],
    ["AU", 0.022, 0.03],
    ["ES", 0.02, 0.015],
    ["JP", 0.018, 0.02],
    ["SE", 0.014, 0.02],
    ["PL", 0.012, 0.008],
    ["SG", 0.01, 0.015],
  ],
  regions: [
    ["California", 0.11, 0.15],
    ["New York", 0.06, 0.08],
    ["England", 0.065, 0.07],
    ["Texas", 0.035, 0.04],
    ["Bavaria", 0.022, 0.025],
    ["Île-de-France", 0.02, 0.025],
    ["Ontario", 0.02, 0.025],
    ["Maharashtra", 0.018, 0.005],
    ["Washington", 0.017, 0.022],
  ],
  cities: [
    ["San Francisco", 0.065, 0.1],
    ["New York", 0.05, 0.065],
    ["London", 0.048, 0.055],
    ["Berlin", 0.024, 0.026],
    ["Austin", 0.018, 0.022],
    ["Paris", 0.017, 0.02],
    ["Toronto", 0.016, 0.02],
    ["Bengaluru", 0.015, 0.004],
    ["Seattle", 0.014, 0.019],
    ["Amsterdam", 0.012, 0.014],
  ],
  devices: [
    ["desktop", 0.64, 0.79],
    ["mobile", 0.33, 0.19],
    ["tablet", 0.03, 0.02],
  ],
  browsers: [
    ["Chrome", 0.55, 0.52],
    ["Safari", 0.26, 0.29],
    ["Firefox", 0.08, 0.08],
    ["Edge", 0.06, 0.07],
    ["Arc", 0.03, 0.035],
    ["Brave", 0.015, 0.01],
  ],
  "operating-systems": [
    ["Mac OS", 0.39, 0.52],
    ["Windows", 0.27, 0.24],
    ["iOS", 0.17, 0.13],
    ["Android", 0.13, 0.06],
    ["Linux", 0.04, 0.05],
  ],
  hostnames: [
    ["example.com", 0.93, 0.62],
    ["app.example.com", 0.24, 0.38],
    ["docs.example.com", 0.08, 0.03],
  ],
};

const CAMPAIGNS: Array<[Record<string, string>, number, number]> = [
  [
    {
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "brand",
      utm_term: "analytics revenue",
    },
    0.025,
    0.035,
  ],
  [
    {
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "october_digest",
      utm_content: "hero",
    },
    0.016,
    0.02,
  ],
  [{ utm_source: "x", utm_medium: "social", utm_campaign: "launch_week" }, 0.014, 0.008],
  [{ utm_source: "producthunt", utm_medium: "referral", utm_campaign: "launch" }, 0.012, 0.01],
  [{ ref: "indiehackers" }, 0.009, 0.006],
  [{ via: "marc" }, 0.007, 0.004],
  [{ source: "github_readme" }, 0.006, 0.003],
  [
    {
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "competitor",
      utm_term: "datafast alternative",
    },
    0.006,
    0.01,
  ],
];

const COUNTRY_NAMES: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  DE: "Germany",
  IN: "India",
  CA: "Canada",
  FR: "France",
  NL: "Netherlands",
  BR: "Brazil",
  AU: "Australia",
  ES: "Spain",
  JP: "Japan",
  SE: "Sweden",
  PL: "Poland",
  SG: "Singapore",
};

const flag = (code: string) =>
  String.fromCodePoint(...code.split("").map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

export function breakdownFor(
  endpoint: string,
  url: URL,
  now = Date.now(),
): Record<string, unknown>[] | null {
  const o = overviewFor(url, now);
  const m = (share: number, rev = share) => ({
    visitors: Math.max(0, Math.round(o.visitors * share)),
    revenue: Math.round(o.revenue * rev * 100) / 100,
    payments: Math.round(o.payments * rev),
  });
  const rows = SHARES[endpoint];
  switch (endpoint) {
    case "channels":
      return rows?.map(([l, s, r]) => ({ channel: l, ...m(s, r) })) ?? [];
    case "referrers":
      return rows?.map(([l, s, r]) => ({ referrer: l, ...m(s, r) })) ?? [];
    case "pages":
    case "entry-pages":
    case "exit-pages":
      return [
        ...(rows?.map(([l, s, r]) => ({ hostname: "example.com", path: l, ...m(s, r) })) ?? []),
        ...(endpoint === "pages"
          ? [
              { hostname: "app.example.com", path: "/dashboard", ...m(0.11, 0.05) },
              { hostname: "app.example.com", path: "/billing", ...m(0.03, 0.18) },
            ]
          : []),
      ].sort((a, b) => b.visitors - a.visitors);
    case "countries":
      return (
        rows?.map(([c, s, r]) => ({
          country: COUNTRY_NAMES[c] ?? c,
          image: flag(c),
          code: c,
          ...m(s, r),
        })) ?? []
      );
    case "regions":
      return rows?.map(([l, s, r]) => ({ region: l, ...m(s, r) })) ?? [];
    case "cities":
      return rows?.map(([l, s, r]) => ({ city: l, ...m(s, r) })) ?? [];
    case "devices":
      return rows?.map(([l, s, r]) => ({ device: l, ...m(s, r) })) ?? [];
    case "browsers":
      return rows?.map(([l, s, r]) => ({ browser: l, ...m(s, r) })) ?? [];
    case "operating-systems":
      return rows?.map(([l, s, r]) => ({ operating_system: l, ...m(s, r) })) ?? [];
    case "hostnames":
      return rows?.map(([l, s, r]) => ({ hostname: l, ...m(s, r) })) ?? [];
    case "campaigns":
      return CAMPAIGNS.map(([c, s, r]) => ({
        campaign: {
          utm_source: "",
          utm_medium: "",
          utm_campaign: "",
          utm_term: "",
          utm_content: "",
          ref: "",
          source: "",
          via: "",
          ...c,
        },
        ...m(s, r),
      }));
    case "exit-clicks":
      return [
        {
          url: "https://github.com/example/example",
          visitors: Math.round(o.visitors * 0.031),
          clicks: Math.round(o.visitors * 0.04),
        },
        {
          url: "https://x.com/example",
          visitors: Math.round(o.visitors * 0.012),
          clicks: Math.round(o.visitors * 0.014),
        },
        {
          url: "https://discord.gg/example",
          visitors: Math.round(o.visitors * 0.009),
          clicks: Math.round(o.visitors * 0.011),
        },
        {
          url: "https://stripe.com/docs",
          visitors: Math.round(o.visitors * 0.005),
          clicks: Math.round(o.visitors * 0.006),
        },
      ];
    case "goals": {
      const goals = [
        ["scroll_to_pricing", GOAL_RATES.scroll_to_pricing, 0.6],
        ["signup", GOAL_RATES.signup, 0.75],
        ["checkout_started", GOAL_RATES.checkout_started, 0.82],
        ["payment", o.visitors ? o.payments / o.visitors : 0, 1],
        ["newsletter_subscribe", GOAL_RATES.newsletter_subscribe, 0.2],
        ["free_trial", GOAL_RATES.free_trial, 0.55],
      ] as const;
      return goals
        .map(([goal, rate, rev]) => {
          const visitors = Math.round(o.visitors * (rate ?? 0));
          return {
            goal,
            completions: Math.round(visitors * (goal === "scroll_to_pricing" ? 1.4 : 1.12)),
            visitors,
            revenue: Math.round(o.revenue * rev * 100) / 100,
            conversion_rate: o.visitors ? Math.round((visitors / o.visitors) * 10000) / 100 : 0,
          };
        })
        .sort((a, b) => b.visitors - a.visitors);
    }
    default:
      return null;
  }
}

// Revenue ------------------------------------------------------------------

export function revenueFor(url: URL, now = Date.now()): RevenueSummary {
  const o = overviewFor(url, now);
  const renewal = Math.round(o.revenue * 0.27 * 100) / 100;
  const refunds = -Math.round(o.revenue * 0.025 * 100) / 100;
  const attributed = Math.round(o.revenue * 0.884 * 100) / 100;
  const customers = Math.round(o.payments * 0.86);
  const ltv = (SHARES.channels ?? []).slice(0, 7).map(([channel, , r]) => {
    const rev = Math.round(o.revenue * 1.9 * (r ?? 0) * 100) / 100;
    const c = Math.max(1, Math.round(customers * 1.4 * (r ?? 0)));
    return { channel, customers: c, revenue: rev, averageValue: Math.round((rev / c) * 100) / 100 };
  });
  return {
    currency: "USD",
    revenue: o.revenue,
    newRevenue: Math.round((o.revenue - renewal - refunds) * 100) / 100,
    renewalRevenue: renewal,
    refunds,
    payments: o.payments,
    customers,
    attribution: {
      attributedRevenue: attributed,
      unattributedRevenue: Math.round((o.revenue - attributed) * 100) / 100,
      coveragePercentage: 88.4,
      byMethod: {
        metadata: Math.round(attributed * 0.66),
        link: Math.round(attributed * 0.12),
        customer: Math.round(attributed * 0.1),
        email: Math.round(attributed * 0.08),
        api: Math.round(attributed * 0.04),
        none: Math.round((o.revenue - attributed) * 100) / 100,
      },
    },
    lifetimeValueByChannel: ltv.sort((a, b) => b.averageValue - a.averageValue),
    pathToPurchase: {
      customers,
      averageDaysToPurchase: 6.4,
      averageSessionsToPurchase: 2.8,
      averagePageviewsToPurchase: 9.1,
      topPaths: [
        {
          channels: ["Organic Search", "Direct"],
          customers: Math.round(customers * 0.21),
          revenue: Math.round(o.revenue * 0.23),
        },
        {
          channels: ["Direct"],
          customers: Math.round(customers * 0.17),
          revenue: Math.round(o.revenue * 0.16),
        },
        {
          channels: ["Organic Search"],
          customers: Math.round(customers * 0.14),
          revenue: Math.round(o.revenue * 0.13),
        },
        {
          channels: ["Referral", "Organic Search", "Direct"],
          customers: Math.round(customers * 0.08),
          revenue: Math.round(o.revenue * 0.09),
        },
        {
          channels: ["AI", "Direct"],
          customers: Math.round(customers * 0.06),
          revenue: Math.round(o.revenue * 0.08),
        },
        {
          channels: ["Organic Social", "Direct"],
          customers: Math.round(customers * 0.05),
          revenue: Math.round(o.revenue * 0.04),
        },
      ],
    },
  };
}

// Realtime -------------------------------------------------------------------

export const LIVE_PLACES: Array<[string, string, string, number, number]> = [
  ["San Francisco", "California", "US", 37.7749, -122.4194],
  ["New York", "New York", "US", 40.7128, -74.006],
  ["Austin", "Texas", "US", 30.2672, -97.7431],
  ["London", "England", "GB", 51.5072, -0.1276],
  ["Berlin", "Berlin", "DE", 52.52, 13.405],
  ["Paris", "Île-de-France", "FR", 48.8566, 2.3522],
  ["Toronto", "Ontario", "CA", 43.6532, -79.3832],
  ["Bengaluru", "Karnataka", "IN", 12.9716, 77.5946],
  ["São Paulo", "São Paulo", "BR", -23.5505, -46.6333],
  ["Sydney", "New South Wales", "AU", -33.8688, 151.2093],
  ["Tokyo", "Tokyo", "JP", 35.6762, 139.6503],
  ["Amsterdam", "North Holland", "NL", 52.3676, 4.9041],
  ["Stockholm", "Stockholm", "SE", 59.3293, 18.0686],
  ["Singapore", "Singapore", "SG", 1.3521, 103.8198],
  ["Seattle", "Washington", "US", 47.6062, -122.3321],
  ["Madrid", "Madrid", "ES", 40.4168, -3.7038],
];

const LIVE_PAGES = [
  "/",
  "/pricing",
  "/blog/how-we-hit-10k-mrr",
  "/features",
  "/docs/getting-started",
  "/signup",
  "/integrations/stripe",
];
const LIVE_REFS = [
  "Google",
  "Direct / None",
  "Hacker News",
  "X",
  "ChatGPT",
  "Reddit",
  "LinkedIn",
  "Perplexity",
];
const LIVE_SYS: Array<[string, string, string]> = [
  ["Chrome", "Mac OS", "desktop"],
  ["Safari", "iOS", "mobile"],
  ["Chrome", "Windows", "desktop"],
  ["Firefox", "Linux", "desktop"],
  ["Chrome", "Android", "mobile"],
  ["Safari", "Mac OS", "desktop"],
  ["Edge", "Windows", "desktop"],
  ["Arc", "Mac OS", "desktop"],
];

const uuid = (i: number) => {
  const h = (n: number) => (hash(`visitor${i}:${n}`) >>> 0).toString(16).padStart(8, "0");
  const a = h(1);
  const b = h(2);
  const c = h(3);
  const d = h(4);
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-${"89ab"[i % 4]}${c.slice(1, 4)}-${c.slice(4)}${d}`;
};

export const visitorUuid = uuid;

export function realtimeMapFor(now = Date.now()): RealtimeMap {
  const minute = Math.floor(now / 60_000);
  const count = 11 + (minute % 3);
  const visitors: RealtimeMap["visitors"] = Array.from({ length: count }, (_, i) => {
    const [city, region, cc, lat, lng] = LIVE_PLACES[
      (i * 5 + 3) % LIVE_PLACES.length
    ] as (typeof LIVE_PLACES)[number];
    const [browser, os, device] = LIVE_SYS[i % LIVE_SYS.length] as [string, string, string];
    const isCustomer = i === 2 || i === 7;
    const score = isCustomer ? 100 : Math.round(8 + noise(`score${i}`) * 85);
    const named = isCustomer || i === 4;
    return {
      visitorId: uuid(i),
      location: { city, region, countryCode: cc },
      system: { browser: { name: browser }, os: { name: os }, device: { type: device } },
      currentUrl: LIVE_PAGES[(i + minute) % LIVE_PAGES.length] ?? "/",
      referrer: LIVE_REFS[i % LIVE_REFS.length] ?? null,
      sessionStartTime: new Date(now - (60 + i * 97) * 1000).toISOString(),
      visitCount: 1 + (i % 4),
      params:
        i % 5 === 0
          ? {
              utm_source: "newsletter",
              utm_medium: "email",
              utm_campaign: "october_digest",
              ref: null,
              source: null,
              via: null,
            }
          : ({} as Record<string, string | null>),
      latitude: lat + (noise(`lat${i}`) - 0.5) * 0.6,
      longitude: lng + (noise(`lng${i}`) - 0.5) * 0.6,
      isCustomer,
      customerName: isCustomer ? (i === 2 ? "Maya Chen" : "Jonas Weber") : null,
      customerEmail: isCustomer ? (i === 2 ? "maya@acme.dev" : "jonas@weber.io") : null,
      profileData: {
        displayName: named
          ? i === 2
            ? "Maya Chen"
            : i === 7
              ? "Jonas Weber"
              : "Priya Raman"
          : null,
        userId: named ? `user_${100 + i}` : null,
        hasProfile: named,
        isRandomName: !named,
      },
      conversionLikelihood: isCustomer
        ? { score: 100, confidence: 1, isCustomer: true }
        : {
            score,
            confidence: 0.55 + noise(`conf${i}`) * 0.4,
            dimensionMatches: [
              {
                dimension: "referrer",
                value: LIVE_REFS[i % LIVE_REFS.length] ?? "",
                conversionRate: 0.01 + noise(`dm${i}`) * 0.05,
              },
              { dimension: "country", value: cc, conversionRate: 0.015 + noise(`dc${i}`) * 0.03 },
            ],
            raw: {
              conversionRate: score / 1000,
              averageValue: 82,
              expectedValue: Math.round(score * 0.82) / 10,
            },
          },
    };
  });
  const recentEvents: RealtimeMap["recentEvents"] = Array.from({ length: 18 }, (_, i) => {
    const v = visitors[i % visitors.length] as RealtimeMap["visitors"][number];
    const goal = i % 6 === 2 ? "signup" : i % 6 === 4 ? "checkout_started" : null;
    return {
      _id: `ev${minute}-${i}`,
      type: goal ? "custom" : "pageview",
      visitorId: v.visitorId,
      timestamp: new Date(now - i * 41_000).toISOString(),
      path: LIVE_PAGES[(i * 3) % LIVE_PAGES.length] ?? "/",
      countryCode: v.location.countryCode,
      extraData: goal
        ? { eventName: goal, ...(goal === "checkout_started" ? { plan: "pro" } : {}) }
        : {},
      referrer: v.referrer,
      customerName: v.customerName,
      amount: null,
      displayName: v.profileData.displayName,
    };
  });
  return {
    count,
    visitors,
    conversionMetrics: { baselineConversionRate: 0.021, baselineAverageValue: 81.4 },
    hasConversionPredictions: true,
    recentEvents,
    recentPayments: [
      {
        _id: "rp1",
        type: "payment_received",
        timestamp: new Date(now - 4 * 60_000).toISOString(),
        name: "Maya Chen",
        email: "maya@acme.dev",
        amount: 99,
        currency: "USD",
        renewal: false,
        displayName: null,
        isNew: true,
        visible: true,
      },
      {
        _id: "rp2",
        type: "payment_received",
        timestamp: new Date(now - 38 * 60_000).toISOString(),
        name: "Jonas Weber",
        email: "jonas@weber.io",
        amount: 49,
        currency: "USD",
        renewal: true,
        displayName: null,
        isNew: false,
        visible: true,
      },
      {
        _id: "rp3",
        type: "payment_received",
        timestamp: new Date(now - 2.6 * 3_600_000).toISOString(),
        name: null,
        email: null,
        amount: 249,
        currency: "USD",
        renewal: false,
        displayName: null,
        isNew: false,
        visible: true,
      },
    ],
  };
}

export function replayFor(now = Date.now()): RealtimeReplay {
  const step = 15 * 60_000;
  const end = Math.floor(now / step) * step;
  const start = end - 32 * step;
  const frames: RealtimeReplay["frames"] = [];
  for (let i = 0; i < 32; i++) {
    const at = start + (i + 1) * step;
    const hour = new Date(at + tzOffset(at, MOCK_TZ)).getUTCHours();
    const n = Math.max(
      3,
      Math.round(4 + (HOUR_WEIGHTS[hour] ?? 0) * 400 * (0.7 + noise(`rf${i}`) * 0.6)),
    );
    frames.push({
      at: new Date(at).toISOString(),
      visitors: Array.from({ length: n }, (_, j) => {
        const [city, , cc, lat, lng] = LIVE_PLACES[
          (i * 7 + j * 3) % LIVE_PLACES.length
        ] as (typeof LIVE_PLACES)[number];
        return {
          visitorId: uuid(1000 + i * 40 + j),
          latitude: lat + (noise(`rl${i}${j}`) - 0.5) * 1.2,
          longitude: lng + (noise(`rg${i}${j}`) - 0.5) * 1.2,
          countryCode: cc,
          city,
          isCustomer: noise(`rc${i}${j}`) > 0.93,
          conversionScore: Math.round(noise(`rs${i}${j}`) * 100),
        };
      }),
      pageviews: n * 3,
      goals: Math.round(n * 0.2),
      payments: noise(`rp${i}`) > 0.75 ? 1 : 0,
    });
  }
  return {
    stepMinutes: 15,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    frames,
  };
}
