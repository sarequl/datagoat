/** Analytics, visitors, goals, funnels fixtures (docs/api/contract.md §Analytics, §Visitors). */
import type {
  BrowserRow,
  CampaignRow,
  ChannelRow,
  CityRow,
  CountryRow,
  DeviceRow,
  EntryPageRow,
  ExitClickRow,
  Funnel,
  FunnelResult,
  GoalCustomization,
  GoalPropertyRow,
  GoalRow,
  HostnameRow,
  Metadata,
  Note,
  OperatingSystemRow,
  Overview,
  PageRow,
  RealtimeMap,
  ReferrerRow,
  RegionRow,
  Segment,
  ShareLink,
  TimeseriesPoint,
  TrackedGoal,
  Usage,
  VisitorListRow,
  VisitorProfile,
} from "../../../../shared/api-types";
import { NOW } from "./core";

/** Deterministic pseudo-random numbers so screenshots and tests are stable. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export const overview: Overview = {
  visitors: 12450,
  new_visitors: 3840,
  returning_visitors: 8610,
  visitorBreakdown: {
    new: 3840,
    returning: 8610,
    newPercentage: 30.84,
    returningPercentage: 69.16,
  },
  pageviews: 16890,
  sessions: 15120,
  bounce_rate: 42.1,
  avg_session_duration: 68,
  currency: "USD",
  revenue: 28450,
  payments: 328,
  revenue_per_visitor: 2.29,
  conversion_rate: 2.63,
};

export function timeseries(days = 30, start = Date.UTC(2026, 9, 6)): TimeseriesPoint[] {
  const rand = seeded(days);
  return Array.from({ length: days }, (_, i) => {
    const visitors = Math.round(300 + 200 * Math.sin(i / 3) + rand() * 120);
    const payments = Math.round(rand() * 14);
    return {
      timestamp: new Date(start + i * 86_400_000).toISOString(),
      visitors,
      new_visitors: Math.round(visitors * 0.3),
      returning_visitors: Math.round(visitors * 0.7),
      pageviews: Math.round(visitors * 1.4),
      sessions: Math.round(visitors * 1.2),
      revenue: payments * 87,
      payments,
      conversion_rate: Math.round((payments / visitors) * 10_000) / 100,
    };
  });
}

const m = (visitors: number, revenue: number, payments: number) => ({
  visitors,
  revenue,
  payments,
});

export const pages: PageRow[] = [
  { hostname: "example.com", path: "/", ...m(6120, 9800, 110) },
  { hostname: "example.com", path: "/pricing", ...m(2150, 8934, 96) },
  { hostname: "example.com", path: "/blog/launch", ...m(1310, 1200, 14) },
  { hostname: "app.example.com", path: "/signup", ...m(980, 6100, 70) },
];
export const entryPages: EntryPageRow[] = pages.map((p) => ({
  ...p,
  visitors: Math.round(p.visitors * 0.7),
}));
export const exitPages: EntryPageRow[] = pages.map((p) => ({
  ...p,
  visitors: Math.round(p.visitors * 0.5),
}));
export const referrers: ReferrerRow[] = [
  { referrer: "Direct / None", ...m(4200, 9100, 104) },
  { referrer: "Google", ...m(3800, 7400, 85) },
  { referrer: "Hacker News", ...m(1240, 4210, 41) },
  { referrer: "X", ...m(830, 2200, 30) },
];
export const channels: ChannelRow[] = [
  { channel: "Direct", ...m(4200, 9100, 104) },
  { channel: "Organic Search", ...m(3900, 7600, 87) },
  { channel: "Referral", ...m(1600, 5100, 52) },
  { channel: "Organic Social", ...m(1100, 2700, 36) },
  { channel: "Paid Search", ...m(700, 2400, 30) },
  { channel: "AI", ...m(310, 1100, 12) },
];
export const campaigns: CampaignRow[] = [
  {
    campaign: {
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "launch",
      utm_term: "",
      utm_content: "",
      ref: "",
      source: "",
      via: "",
    },
    ...m(430, 1700, 21),
  },
  {
    campaign: {
      utm_source: "",
      utm_medium: "",
      utm_campaign: "",
      utm_term: "",
      utm_content: "",
      ref: "producthunt",
      source: "",
      via: "",
    },
    ...m(310, 900, 9),
  },
];
export const countries: CountryRow[] = [
  { country: "United States", image: "🇺🇸", code: "US", ...m(4240, 12890, 152) },
  { country: "Germany", image: "🇩🇪", code: "DE", ...m(1310, 3100, 34) },
  { country: "France", image: "🇫🇷", code: "FR", ...m(980, 2600, 27) },
  { country: "India", image: "🇮🇳", code: "IN", ...m(870, 400, 6) },
];
export const regions: RegionRow[] = [
  { region: "California", ...m(1540, 5100, 58) },
  { region: "New York", ...m(990, 3300, 37) },
];
export const cities: CityRow[] = [
  { city: "San Francisco", ...m(720, 2980, 32) },
  { city: "Berlin", ...m(610, 1400, 15) },
];
export const devices: DeviceRow[] = [
  { device: "desktop", ...m(7980, 22000, 250) },
  { device: "mobile", ...m(4100, 6000, 74) },
  { device: "tablet", ...m(370, 450, 4) },
];
export const browsers: BrowserRow[] = [
  { browser: "Chrome", ...m(6760, 15840, 179) },
  { browser: "Safari", ...m(3900, 9100, 110) },
  { browser: "Firefox", ...m(1100, 2800, 29) },
];
export const operatingSystems: OperatingSystemRow[] = [
  { operating_system: "Mac OS", ...m(5640, 17200, 197) },
  { operating_system: "Windows", ...m(3300, 6400, 70) },
  { operating_system: "iOS", ...m(2600, 3900, 48) },
];
export const hostnames: HostnameRow[] = [
  { hostname: "example.com", ...m(11240, 22560, 258) },
  { hostname: "app.example.com", ...m(2980, 5890, 70) },
];
export const exitClicks: ExitClickRow[] = [
  { url: "https://github.com/example/repo", visitors: 184, clicks: 213 },
  { url: "https://partner.example/pricing", visitors: 84, clicks: 113 },
];
export const goals: GoalRow[] = [
  { goal: "signup", completions: 482, visitors: 391, revenue: 8100, conversion_rate: 3.14 },
  {
    goal: "checkout_started",
    completions: 211,
    visitors: 190,
    revenue: 7200,
    conversion_rate: 1.53,
  },
  { goal: "payment", completions: 328, visitors: 301, revenue: 28450, conversion_rate: 2.42 },
];
export const goalProperties: GoalPropertyRow[] = [
  { property: "plan", completions: 420, visitors: 350 },
  { property: "button_location", completions: 300, visitors: 280 },
];
export const goalPropertyValues: GoalPropertyRow[] = [
  { value: "free", completions: 80, visitors: 73 },
  { value: "pro", completions: 25, visitors: 24 },
];

export const metadata: Metadata = {
  domain: "example.com",
  timezone: "America/New_York",
  name: "Example SaaS",
  logo: null,
  kpiColorScheme: "orange",
  kpi: "signup",
  currency: "USD",
};

export function realtimeMap(): RealtimeMap {
  return {
    count: 2,
    visitors: [
      {
        visitorId: "a3ab2331-989f-4cfa-91c6-2461c9e3c6bd",
        location: { city: "Paris", region: "Île-de-France", countryCode: "FR" },
        system: {
          browser: { name: "Chrome" },
          os: { name: "Mac OS" },
          device: { type: "desktop" },
        },
        currentUrl: "/pricing",
        referrer: "Google",
        sessionStartTime: NOW,
        visitCount: 2,
        params: {
          utm_source: "google",
          utm_medium: null,
          utm_campaign: null,
          ref: null,
          source: null,
          via: null,
        },
        latitude: 48.8566,
        longitude: 2.3522,
        isCustomer: false,
        customerName: null,
        customerEmail: null,
        profileData: { displayName: null, userId: null, hasProfile: false, isRandomName: true },
        conversionLikelihood: {
          score: 64,
          confidence: 0.7,
          raw: { conversionRate: 0.031, averageValue: 87, expectedValue: 2.7 },
        },
      },
      {
        visitorId: "b2c3d4e5-1111-4222-8333-444455556666",
        location: { city: "Austin", region: "Texas", countryCode: "US" },
        system: { browser: { name: "Safari" }, os: { name: "iOS" }, device: { type: "mobile" } },
        currentUrl: "/",
        referrer: "Direct / None",
        sessionStartTime: NOW,
        visitCount: 1,
        params: {},
        latitude: 30.2672,
        longitude: -97.7431,
        isCustomer: true,
        customerName: "Alex Customer",
        customerEmail: "alex@example.net",
        profileData: {
          displayName: "Alex Customer",
          userId: "user_42",
          hasProfile: true,
          isRandomName: false,
        },
        conversionLikelihood: { score: 100, confidence: 1, isCustomer: true },
      },
    ],
    conversionMetrics: { baselineConversionRate: 0.0263, baselineAverageValue: 86.7 },
    hasConversionPredictions: true,
    recentEvents: [
      {
        _id: "e1",
        type: "custom",
        visitorId: "a3ab2331-989f-4cfa-91c6-2461c9e3c6bd",
        timestamp: NOW,
        path: "/pricing",
        countryCode: "FR",
        extraData: { eventName: "checkout_started", plan: "pro" },
        referrer: "Google",
        customerName: null,
        amount: null,
        displayName: null,
      },
    ],
    recentPayments: [
      {
        _id: "p1",
        type: "payment_received",
        timestamp: NOW,
        name: "Alex Customer",
        email: "alex@example.net",
        amount: 49,
        currency: "USD",
        renewal: false,
        displayName: null,
        isNew: false,
        visible: true,
      },
    ],
  };
}

export const funnels: Funnel[] = [
  {
    id: "6728f0a0a1b2c3d4e5f6e001",
    websiteId: "6728f0a0a1b2c3d4e5f6a001",
    name: "Signup funnel",
    slug: "signup-funnel",
    steps: [
      {
        id: "landing",
        name: "Landing",
        type: "pageview",
        url: "/",
        urlMatchType: "equals",
        goalCompletionType: "completed",
      },
      {
        id: "pricing",
        name: "Pricing",
        type: "pageview",
        url: "/pricing",
        urlMatchType: "equals",
        goalCompletionType: "completed",
      },
      {
        id: "signup",
        name: "Signed up",
        type: "goal",
        goalName: "signup",
        goalCompletionType: "completed",
      },
    ],
    isActive: true,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  },
];

export function funnelResult(funnel: Funnel): FunnelResult {
  const values = [1000, 420, 214];
  return {
    funnel: { id: funnel.id, name: funnel.name, slug: funnel.slug, steps: funnel.steps },
    data: funnel.steps.map((s, i) => ({
      id: s.id ?? String(i),
      label: s.name,
      value: values[i] ?? 100,
      stepIndex: i,
      stepType: s.type,
      revenue: (values[i] ?? 100) * 2.4,
      conversionRate: ((values[i] ?? 100) / 1000) * 100,
      dropoffFromPrevious:
        i === 0 ? 0 : Math.round((1 - (values[i] ?? 0) / (values[i - 1] ?? 1)) * 10_000) / 100,
    })),
    metrics: {
      totalVisitors: 1000,
      completions: 214,
      overallConversionRate: 21.4,
      overallRevenuePerVisitor: 2.4,
      timezone: "UTC",
      startAt: null,
      endAt: null,
      lastUpdated: NOW,
    },
  };
}

export function visitorsList(count = 25): VisitorListRow[] {
  const rand = seeded(7);
  return Array.from({ length: count }, (_, i) => ({
    visitorId: `0000000${i}-989f-4cfa-91c6-2461c9e3c6bd`.slice(-36).padStart(36, "0"),
    lastSeenAt: new Date(Date.parse(NOW) - i * 3_600_000).toISOString(),
    visitorFirstSeenAt: "2026-10-01T09:20:00.000Z",
    visitorSessionNumber: 1 + Math.floor(rand() * 5),
    visitorType: i % 3 === 0 ? "new" : "returning",
    currentUrl: "example.com/pricing",
    identity: {
      country: "US",
      region: "CA",
      city: "San Francisco",
      browser: "Chrome",
      os: "Mac OS",
      device: "desktop",
    },
    acquisition: { referrer: "Google", utm_source: i % 2 ? "google" : null, utm_campaign: null },
    userId: i % 4 === 0 ? `user_${i}` : null,
    displayName: i % 4 === 0 ? `Customer ${i}` : null,
    revenue: i % 4 === 0 ? 49 : 0,
  }));
}

export function visitorProfile(visitorId: string): VisitorProfile {
  return {
    visitorId,
    identity: {
      country: "US",
      countryCode: "US",
      region: "California",
      city: "San Francisco",
      params: { utm_source: "google", ref: null },
      adClickIds: {},
      browser: { name: "Chrome", version: "142.0" },
      os: { name: "Mac OS", version: "15.1" },
      device: { type: "desktop", vendor: null, model: null },
      viewport: { width: 1440, height: 900 },
    },
    activity: {
      visitCount: 3,
      visitorFirstSeenAt: "2026-10-01T09:20:00.000Z",
      visitorSessionNumber: 3,
      visitorType: "returning",
      pageViewCount: 8,
      timeSinceFirstVisit: 2_900_000_000,
      timeSinceCurrentVisit: 120_000,
      firstVisitAt: "2026-10-01T09:20:00.000Z",
      lastVisitAt: NOW,
      currentUrl: "/pricing",
      completedGoals: [
        { name: "signup", origin: "manual", type: "custom", timestamp: "2026-10-02T10:00:00.000Z" },
      ],
      visitedPages: [
        { url: "/", timestamp: "2026-10-01T09:20:00.000Z" },
        { url: "/pricing", timestamp: NOW },
      ],
    },
    profile: {
      userId: "user_123",
      metadata: { plan: "pro" },
      identifiedAt: "2026-10-02T10:00:00.000Z",
    },
    sessions: [
      {
        id: "s1",
        startedAt: "2026-10-01T09:20:00.000Z",
        endedAt: "2026-10-01T09:31:00.000Z",
        channel: "Organic Search",
        referrer: "Google",
        entryPath: "/",
        pageviews: 4,
        searchKeywords: [
          { query: "revenue analytics", probability: 62 },
          { query: "datagoat", probability: 38 },
        ],
      },
      {
        id: "s2",
        startedAt: NOW,
        endedAt: NOW,
        channel: "Direct",
        referrer: null,
        entryPath: "/pricing",
        pageviews: 1,
      },
    ],
    payments: [
      {
        id: "pay1",
        amount: 49,
        currency: "USD",
        kind: "payment",
        provider: "stripe",
        timestamp: "2026-10-03T12:00:00.000Z",
      },
    ],
  };
}

export const trackedGoals: TrackedGoal[] = goals.map((g) => ({
  name: g.goal,
  displayName: g.goal === "signup" ? "Signup" : null,
  color: g.goal === "signup" ? "#8dcdff" : null,
  description: null,
  hidden: false,
  total: g.completions,
  uv: g.visitors,
  conversionRate: Math.round((g.visitors / overview.visitors) * 1000) / 1000,
  eventType: g.goal === "payment" ? "payment" : "custom",
}));

export const goalCustomizations: GoalCustomization[] = [
  {
    goalName: "signup",
    displayName: "Signup",
    color: "#8dcdff",
    description: "Visitor created an account",
    hidden: false,
    updatedAt: NOW,
  },
];

export const goalColors = [
  { color: "#ef4444", family: "red", label: "Red" },
  { color: "#f59e0b", family: "amber", label: "Amber" },
  { color: "#10b981", family: "green", label: "Green" },
  { color: "#8dcdff", family: "blue", label: "Sky" },
  { color: "#6366f1", family: "indigo", label: "Indigo" },
];

export function notes(websiteId: string): Note[] {
  return [
    {
      id: "6728f0a0a1b2c3d4e5f6f001",
      websiteId,
      text: "Launched the new landing page",
      timestamp: "2026-10-20T10:00:00.000Z",
      author: { id: "6728f0a0a1b2c3d4e5f60001", name: "Demo Owner", image: null },
      createdAt: "2026-10-20T10:01:00.000Z",
      updatedAt: "2026-10-20T10:01:00.000Z",
    },
  ];
}

export function segments(websiteId: string): Segment[] {
  return [
    {
      id: "6728f0a0a1b2c3d4e5f6f101",
      websiteId,
      name: "Customers from USA",
      filters: { filter_goal: "is:payment", filter_country: "is:US" },
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
}

export function shareLink(token: string | null): ShareLink {
  return {
    enabled: token !== null,
    token,
    url: token ? `/share/${token}` : null,
    isPublicDataEnabled: false,
  };
}

export const usage: Usage = {
  databaseSizeBytes: 86_000_000,
  databaseLimitBytes: 500_000_000,
  databasePercentUsed: 17.2,
  plan: "free",
  rows: { events: 412_000, sessions: 180_000, visitors: 120_000, payments: 2_100 },
  last24h: { events: 5_400, sessions: 2_300, estimatedRowsWritten: 21_800 },
  estimatedDailyWriteLimit: 100_000,
  retentionDays: null,
  oldestEventAt: "2026-01-01T00:00:00.000Z",
};
