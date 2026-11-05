/**
 * Realistic fixtures for the analytics pages (W4): visitors and profiles, payments, goals and
 * customizations, funnels, notes and commits. Shapes follow shared/api-types.ts.
 */
import type {
  Funnel,
  FunnelResult,
  GithubCommit,
  GoalCustomization,
  GoalPropertyRow,
  Note,
  PaymentRow,
  Segment,
  TrackedGoal,
  VisitorListRow,
  VisitorProfile,
} from "../../../../shared/api-types";
import { LIVE_PLACES, noise, overviewFor, visitorUuid } from "./model";

/** Mutable per-website mock data (lives in mocks/state.ts, reset between tests). */
export interface AnalyticsMockState {
  notes: Record<string, Note[]>;
  segments: Record<string, Segment[]>;
  funnels: Record<string, Funnel[]>;
  goalCustomizations: Record<string, GoalCustomization[]>;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const PEOPLE = [
  "Maya Chen",
  "Jonas Weber",
  "Priya Raman",
  "Lucas Martin",
  "Sofia Rossi",
  "Ethan Brooks",
  "Aiko Tanaka",
  "Noah Fischer",
  "Leila Haddad",
  "Oliver Smith",
];
const REFS = [
  "Google",
  "Direct / None",
  "Hacker News",
  "X",
  "ChatGPT",
  "Reddit",
  "LinkedIn",
  "Bing",
  "Perplexity",
];
const CHANNEL_OF: Record<string, string> = {
  Google: "Organic Search",
  Bing: "Organic Search",
  "Direct / None": "Direct",
  "Hacker News": "Referral",
  Reddit: "Organic Social",
  X: "Organic Social",
  LinkedIn: "Organic Social",
  ChatGPT: "AI",
  Perplexity: "AI",
};
const SYS: Array<[string, string, string, string]> = [
  ["Chrome", "Mac OS", "desktop", "142.0"],
  ["Safari", "iOS", "mobile", "18.1"],
  ["Chrome", "Windows", "desktop", "142.0"],
  ["Firefox", "Linux", "desktop", "133.0"],
  ["Chrome", "Android", "mobile", "142.0"],
  ["Safari", "Mac OS", "desktop", "18.1"],
  ["Edge", "Windows", "desktop", "141.0"],
];
const PAGES = [
  "/",
  "/pricing",
  "/features",
  "/blog/how-we-hit-10k-mrr",
  "/docs/getting-started",
  "/signup",
  "/integrations/stripe",
];

export function visitorsFor(url: URL, now = Date.now()): VisitorListRow[] {
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const customers =
    url.searchParams.get("isCustomer") === "true" || url.searchParams.get("hasRevenue") === "true";
  const goal = url.searchParams.get("completedGoal") ?? url.searchParams.get("goal");
  const country = url.searchParams.get("country");
  const rows: VisitorListRow[] = Array.from({ length: 140 }, (_, i) => {
    const [city, region, cc] = LIVE_PLACES[
      (i * 7) % LIVE_PLACES.length
    ] as (typeof LIVE_PLACES)[number];
    const [browser, os, device] = SYS[i % SYS.length] as (typeof SYS)[number];
    const session = 1 + Math.floor(noise(`vs${i}`) * 6);
    const identified = i % 4 === 0;
    const ref = REFS[i % REFS.length] as string;
    return {
      visitorId: visitorUuid(i),
      lastSeenAt: iso(now - i * 47 * 60_000 - noise(`ls${i}`) * HOUR),
      visitorFirstSeenAt: iso(now - (3 + i * 1.7) * DAY),
      visitorSessionNumber: session,
      visitorType: session > 1 ? "returning" : "new",
      currentUrl: `example.com${PAGES[i % PAGES.length]}`,
      identity: { country: cc, region, city, browser, os, device },
      acquisition: {
        referrer: ref,
        utm_source: i % 5 === 0 ? "newsletter" : null,
        utm_medium: i % 5 === 0 ? "email" : null,
        utm_campaign: i % 5 === 0 ? "october_digest" : null,
      },
      userId: identified ? `user_${1000 + i}` : null,
      displayName: identified ? (PEOPLE[(i / 4) % PEOPLE.length] ?? null) : null,
      revenue: identified && i % 8 === 0 ? 99 * (1 + (i % 3)) : 0,
    };
  });
  return rows.filter(
    (r) =>
      (!q ||
        r.visitorId.includes(q) ||
        (r.userId ?? "").toLowerCase().includes(q) ||
        (r.displayName ?? "").toLowerCase().includes(q)) &&
      (!customers || (r.revenue ?? 0) > 0) &&
      (!goal || noise(`${goal}${r.visitorId}`) > 0.55) &&
      (!country || r.identity.country === country.toUpperCase()),
  );
}

export function visitorProfileFor(visitorId: string, now = Date.now()): VisitorProfile {
  const i = Math.floor(noise(visitorId) * 1000);
  const [city, region, cc] = LIVE_PLACES[i % LIVE_PLACES.length] as (typeof LIVE_PLACES)[number];
  const [browser, os, device, version] = SYS[i % SYS.length] as (typeof SYS)[number];
  const customer = noise(`cust${visitorId}`) > 0.55;
  const first = now - 38 * DAY - (i % 10) * HOUR;
  const sessionDays = [0, 1, 5, 9, 16, 24, 37.6];
  const sessions = sessionDays.map((d, n) => {
    const start = first + d * DAY;
    const ref = n === 0 ? "Google" : n === 2 ? "Hacker News" : n === 4 ? "X" : null;
    const pageviews = 1 + Math.floor(noise(`pv${visitorId}${n}`) * 6);
    return {
      id: `s${n + 1}`,
      startedAt: iso(start),
      endedAt: iso(start + pageviews * 70_000),
      channel: ref ? (CHANNEL_OF[ref] ?? "Referral") : "Direct",
      referrer: ref,
      entryPath: PAGES[(n * 3) % PAGES.length] ?? "/",
      pageviews,
      // Search Console keyword guesses for the Google session (DG).
      ...(ref === "Google"
        ? {
            searchKeywords: [
              { query: "revenue analytics", probability: 62 },
              { query: "datagoat", probability: 38 },
            ],
          }
        : {}),
    };
  });
  const visitedPages = sessions.flatMap((s, n) =>
    Array.from({ length: s.pageviews }, (_, k) => ({
      url: k === 0 ? s.entryPath : (PAGES[(n + k * 2) % PAGES.length] ?? "/"),
      timestamp: iso(Date.parse(s.startedAt) + k * 70_000),
    })),
  );
  const t = (n: number, offset = 120_000) =>
    iso(Date.parse((sessions[n] as { startedAt: string }).startedAt) + offset);
  const completedGoals: VisitorProfile["activity"]["completedGoals"] = [
    { name: "scroll_to_pricing", origin: "manual", type: "custom", timestamp: t(0, 90_000) },
    { name: "newsletter_subscribe", origin: "manual", type: "custom", timestamp: t(1) },
    { name: "signup", origin: "manual", type: "custom", timestamp: t(2, 200_000) },
    { name: "checkout_started", origin: "manual", type: "custom", timestamp: t(4, 150_000) },
    ...(customer
      ? [
          {
            name: "payment",
            origin: "payment_provider" as const,
            type: "payment" as const,
            timestamp: t(4, 260_000),
          },
          {
            name: "subscription_renewed",
            origin: "payment_provider" as const,
            type: "subscription_lifecycle" as const,
            timestamp: t(6, 30_000),
          },
        ]
      : []),
  ];
  const last = sessions.at(-1) as (typeof sessions)[number];
  return {
    visitorId,
    identity: {
      country: cc === "US" ? "United States" : cc,
      countryCode: cc,
      region,
      city,
      params: {
        utm_source: "google",
        utm_medium: null,
        utm_campaign: null,
        ref: null,
        source: null,
        via: null,
      },
      adClickIds: {},
      browser: { name: browser, version },
      os: { name: os, version: os === "Mac OS" ? "15.1" : os === "iOS" ? "18.1" : "11" },
      device: {
        type: device,
        vendor: device === "mobile" ? "Apple" : null,
        model: device === "mobile" ? "iPhone" : null,
      },
      viewport: device === "mobile" ? { width: 390, height: 844 } : { width: 1512, height: 945 },
    },
    activity: {
      visitCount: sessions.length,
      visitorFirstSeenAt: iso(first),
      visitorSessionNumber: sessions.length,
      visitorType: "returning",
      pageViewCount: visitedPages.length,
      timeSinceFirstVisit: now - first,
      timeSinceCurrentVisit: now - Date.parse(last.startedAt),
      firstVisitAt: iso(first),
      lastVisitAt: last.endedAt,
      currentUrl: last.entryPath,
      completedGoals,
      visitedPages,
    },
    profile: customer
      ? {
          userId: "user_1004",
          metadata: { name: "Maya Chen", plan: "pro", company: "Acme" },
          identifiedAt: t(2, 210_000),
        }
      : undefined,
    prediction: customer
      ? undefined
      : { score: 72, conversionRate: 0.064, expectedValue: 5.24, confidence: 0.81 },
    sessions,
    payments: customer
      ? [
          {
            id: "pay_a1",
            amount: 99,
            currency: "USD",
            kind: "payment",
            provider: "stripe",
            timestamp: t(4, 260_000),
          },
          {
            id: "pay_a2",
            amount: 99,
            currency: "USD",
            kind: "renewal",
            provider: "stripe",
            timestamp: t(6, 30_000),
          },
        ]
      : [],
  };
}

const VIA: PaymentRow["attributedVia"][] = [
  "metadata",
  "metadata",
  "link",
  "customer",
  "email",
  "api",
  "none",
];
const PROVIDERS = ["stripe", "stripe", "stripe", "lemonsqueezy", "polar"];

export function paymentsFor(url: URL, now = Date.now()): PaymentRow[] {
  const attributed = url.searchParams.get("attributed");
  const kind = url.searchParams.get("kind");
  const rows: PaymentRow[] = Array.from({ length: 60 }, (_, i) => {
    const k: PaymentRow["kind"] =
      i % 11 === 5 ? "refund" : i % 4 === 1 ? "renewal" : i % 13 === 7 ? "free_trial" : "payment";
    const via = VIA[i % VIA.length] as PaymentRow["attributedVia"];
    const base = [49, 99, 249, 19, 499][i % 5] as number;
    const amount = k === "refund" ? -base : k === "free_trial" ? 0 : base;
    const eur = i % 6 === 3;
    const ref = REFS[i % REFS.length] as string;
    const person = PEOPLE[i % PEOPLE.length] as string;
    return {
      id: `pay_${i}`,
      provider: PROVIDERS[i % PROVIDERS.length] as string,
      transactionId: `${k === "renewal" ? "in" : "cs"}_live_${(noise(`tx${i}`) * 1e12).toString(36).slice(0, 10)}`,
      kind: k,
      amount,
      currency: "USD",
      originalAmount: eur ? Math.round(amount * 0.92 * 100) / 100 : amount,
      originalCurrency: eur ? "EUR" : "USD",
      visitorId: via === "none" ? null : visitorUuid(i * 4),
      attributedVia: via,
      channel: via === "none" ? null : (CHANNEL_OF[ref] ?? "Direct"),
      customerEmail: `${person.split(" ")[0]?.toLowerCase()}@${["acme.dev", "gmail.com", "startup.io"][i % 3]}`,
      customerName: person,
      timestamp: iso(now - i * 9.5 * HOUR - noise(`pt${i}`) * HOUR),
    };
  });
  return rows.filter(
    (r) =>
      (attributed === null ||
        (attributed === "true" ? r.attributedVia !== "none" : r.attributedVia === "none")) &&
      (!kind || kind.split(",").includes(r.kind)),
  );
}

export const GOAL_NAMES = [
  "scroll_to_pricing",
  "signup",
  "checkout_started",
  "payment",
  "newsletter_subscribe",
  "free_trial",
];

export function goalCustomizationsSeed(now = Date.now()): GoalCustomization[] {
  return [
    {
      goalName: "signup",
      displayName: "Signed up",
      color: "#8dcdff",
      description: "Created an account",
      hidden: false,
      updatedAt: iso(now - 20 * DAY),
    },
    {
      goalName: "checkout_started",
      displayName: "Checkout started",
      color: "#ffbe00",
      description: null,
      hidden: false,
      updatedAt: iso(now - 20 * DAY),
    },
    {
      goalName: "payment",
      displayName: "Payment",
      color: "#e78468",
      description: "Paid via Stripe",
      hidden: false,
      updatedAt: iso(now - 20 * DAY),
    },
    {
      goalName: "scroll_to_pricing",
      displayName: null,
      color: "#a78bfa",
      description: null,
      hidden: false,
      updatedAt: iso(now - 20 * DAY),
    },
  ];
}

export function trackedGoalsFor(
  customizations: GoalCustomization[],
  now = Date.now(),
): TrackedGoal[] {
  const url = new URL("http://mock/?");
  const o = overviewFor(url, now);
  return GOAL_NAMES.map((name, i) => {
    const c = customizations.find((x) => x.goalName === name);
    const uv = Math.round(o.visitors * ([0.21, 0.052, 0.031, 0.02, 0.018, 0.012][i] ?? 0.01));
    return {
      name,
      displayName: c?.displayName ?? null,
      color: c?.color ?? null,
      description: c?.description ?? null,
      hidden: c?.hidden ?? false,
      total: Math.round(uv * 1.15),
      uv,
      conversionRate: o.visitors ? Math.round((uv / o.visitors) * 1000) / 1000 : 0,
      eventType: name === "payment" || name === "free_trial" ? "payment" : "custom",
    };
  });
}

const PROPERTIES: Record<string, Record<string, Array<[string, number]>>> = {
  signup: {
    plan: [
      ["free", 0.62],
      ["pro", 0.29],
      ["team", 0.09],
    ],
    method: [
      ["google", 0.55],
      ["email", 0.35],
      ["github", 0.1],
    ],
    email_domain: [
      ["gmail.com", 0.48],
      ["outlook.com", 0.12],
      ["acme.dev", 0.04],
    ],
  },
  checkout_started: {
    plan: [
      ["pro", 0.66],
      ["team", 0.24],
      ["lifetime", 0.1],
    ],
    billing: [
      ["monthly", 0.58],
      ["yearly", 0.42],
    ],
  },
  newsletter_subscribe: {
    location: [
      ["footer", 0.7],
      ["blog_inline", 0.3],
    ],
  },
};

export function goalPropertiesFor(url: URL, now = Date.now()): GoalPropertyRow[] {
  const goal = url.searchParams.get("eventName") ?? "";
  const property = url.searchParams.get("propertyName");
  const o = overviewFor(url, now);
  const visitors = Math.round(o.visitors * 0.05);
  const props = PROPERTIES[goal] ?? {};
  if (property) {
    return (props[property] ?? []).map(([value, share]) => ({
      value,
      completions: Math.round(visitors * share * 1.12),
      visitors: Math.round(visitors * share),
    }));
  }
  return Object.keys(props).map((p, i) => ({
    property: p,
    completions: Math.round(visitors * (1 - i * 0.1) * 1.12),
    visitors: Math.round(visitors * (1 - i * 0.1)),
  }));
}

export function funnelsSeed(websiteId: string, now = Date.now()): Funnel[] {
  return [
    {
      id: "6728f0a0a1b2c3d4e5f6e001",
      websiteId,
      name: "Signup funnel",
      slug: "signup-funnel",
      steps: [
        {
          id: "landing",
          name: "Landing page",
          type: "pageview",
          url: "/",
          urlMatchType: "equals",
          goalCompletionType: "completed",
        },
        {
          id: "pricing",
          name: "Viewed pricing",
          type: "pageview",
          url: "/pricing",
          urlMatchType: "starts_with",
          goalCompletionType: "completed",
        },
        {
          id: "signup",
          name: "Signed up",
          type: "goal",
          goalName: "signup",
          goalCompletionType: "completed",
        },
        {
          id: "checkout",
          name: "Started checkout",
          type: "goal",
          goalName: "checkout_started",
          goalCompletionType: "completed",
        },
        {
          id: "paid",
          name: "Paid",
          type: "goal",
          goalName: "payment",
          goalCompletionType: "completed",
        },
      ],
      isActive: true,
      createdAt: iso(now - 60 * DAY),
      updatedAt: iso(now - 10 * DAY),
    },
    {
      id: "6728f0a0a1b2c3d4e5f6e002",
      websiteId,
      name: "Blog to newsletter",
      slug: "blog-to-newsletter",
      steps: [
        {
          id: "blog",
          name: "Read a blog post",
          type: "pageview",
          url: "/blog/*",
          urlMatchType: "wildcard",
          goalCompletionType: "completed",
        },
        {
          id: "news",
          name: "Subscribed",
          type: "goal",
          goalName: "newsletter_subscribe",
          goalCompletionType: "completed",
        },
      ],
      isActive: true,
      createdAt: iso(now - 30 * DAY),
      updatedAt: iso(now - 30 * DAY),
    },
  ];
}

export function funnelResultFor(funnel: Funnel, url: URL, now = Date.now()): FunnelResult {
  const o = overviewFor(url, now);
  const rates = [0.62, 0.43, 0.31, 0.52, 0.58, 0.6, 0.5, 0.5, 0.5, 0.5];
  let v = Math.round(o.visitors * 0.62);
  const data = funnel.steps.map((s, i) => {
    const prev = v;
    if (i > 0) v = Math.round(v * (rates[i] ?? 0.5));
    return {
      id: s.id ?? String(i),
      label: s.name,
      value: v,
      stepIndex: i,
      stepType: s.type,
      revenue: Math.round(o.revenue * (0.95 - i * 0.04) * 100) / 100,
      conversionRate: 0,
      dropoffFromPrevious: i === 0 ? 0 : Math.round((1 - v / Math.max(1, prev)) * 10000) / 100,
    };
  });
  const first = data[0]?.value ?? 0;
  for (const d of data) d.conversionRate = first ? Math.round((d.value / first) * 10000) / 100 : 0;
  const last = data.at(-1)?.value ?? 0;
  return {
    funnel: { id: funnel.id, name: funnel.name, slug: funnel.slug, steps: funnel.steps },
    data,
    metrics: {
      totalVisitors: first,
      completions: last,
      overallConversionRate: first ? Math.round((last / first) * 10000) / 100 : 0,
      overallRevenuePerVisitor: first ? Math.round((o.revenue / first) * 100) / 100 : 0,
      timezone: url.searchParams.get("timezone") ?? "UTC",
      startAt: url.searchParams.get("startAt"),
      endAt: url.searchParams.get("endAt"),
      lastUpdated: iso(now),
    },
  };
}

export function notesSeed(websiteId: string, now = Date.now()): Note[] {
  const author = { id: "6728f0a0a1b2c3d4e5f60001", name: "Demo Owner", image: null };
  return [
    {
      id: "6728f0a0a1b2c3d4e5f6f001",
      websiteId,
      text: "Hacker News front page 🚀",
      timestamp: iso(now - 23 * DAY),
      author,
      createdAt: iso(now - 23 * DAY),
      updatedAt: iso(now - 23 * DAY),
    },
    {
      id: "6728f0a0a1b2c3d4e5f6f002",
      websiteId,
      text: "New pricing page",
      timestamp: iso(now - 9 * DAY),
      author,
      createdAt: iso(now - 9 * DAY),
      updatedAt: iso(now - 9 * DAY),
    },
    {
      id: "6728f0a0a1b2c3d4e5f6f003",
      websiteId,
      text: "October newsletter sent",
      timestamp: iso(now - 52 * DAY),
      author,
      createdAt: iso(now - 52 * DAY),
      updatedAt: iso(now - 52 * DAY),
    },
  ];
}

export function segmentsSeed(websiteId: string, now = Date.now()): Segment[] {
  return [
    {
      id: "6728f0a0a1b2c3d4e5f6f101",
      websiteId,
      name: "Customers from USA",
      filters: { filter_goal: "is:payment", filter_country: "is:US" },
      createdAt: iso(now - 40 * DAY),
      updatedAt: iso(now - 40 * DAY),
    },
    {
      id: "6728f0a0a1b2c3d4e5f6f102",
      websiteId,
      name: "Returning visitors",
      filters: { filter_visit_count: "gte:2" },
      createdAt: iso(now - 12 * DAY),
      updatedAt: iso(now - 12 * DAY),
    },
  ];
}

export function commitsFor(now = Date.now()): GithubCommit[] {
  const c = (
    sha: string,
    message: string,
    days: number,
    add: number,
    del: number,
  ): GithubCommit => ({
    sha,
    repo: "example/app",
    branch: "main",
    message,
    author: { name: "Demo Owner", login: "demo", avatar: null },
    additions: add,
    deletions: del,
    url: `https://github.com/example/app/commit/${sha}`,
    timestamp: iso(now - days * DAY),
  });
  return [
    c("a1b2c3d", "feat: new pricing page", 9.2, 420, 61),
    c("b2c3d4e", "feat: annual billing", 17.4, 210, 34),
    c("c3d4e5f", "fix: signup form validation on Safari", 3.1, 18, 7),
    c("d4e5f6a", "feat: onboarding checklist", 31.5, 640, 120),
  ];
}
