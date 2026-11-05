/** Extra W6 (growth) fixtures, typed with shared/api-types.ts. The rest live in growth.ts. */
import type {
  AdsSummary,
  AlertChannels,
  AlertHistoryEntry,
  AttackModeState,
  BotTrafficPage,
  BotTrafficSettings,
  BotTrafficSummary,
  GrowthIntegrationStatus,
  MetaAdAccount,
  SearchConsoleOverview,
  SearchConsoleRow,
  SearchConsoleStatus,
} from "../../../../shared/api-types";
import { NOW } from "./core";

export const alertChannels: AlertChannels = {
  email: { configured: true, provider: "resend", defaultRecipients: ["demo@datagoat.dev"] },
  telegram: { configured: true, hasDefaultBotToken: false },
  webhook: { configured: true },
  dailyLimit: 100,
  variables: [
    "website",
    "goal",
    "amount",
    "country",
    "city",
    "device",
    "referrer",
    "page",
    "visitors",
  ],
};

export const alertHistory: AlertHistoryEntry[] = [
  {
    alertId: "6728f0a0a1b2c3d4e5f6a101",
    alertName: "New signup",
    goalName: "signup",
    status: "sent",
    error: null,
    visitorId: "a3ab2331-989f-4cfa-91c6-2461c9e3c6bd",
    triggeredAt: NOW,
    channel: "email",
    triggerType: "goal",
    summary: "signup from United States",
  },
  {
    alertId: "6728f0a0a1b2c3d4e5f6a101",
    alertName: "New signup",
    goalName: "signup",
    status: "failed",
    error: "Telegram: Bad Request: chat not found",
    visitorId: null,
    triggeredAt: "2026-11-03T09:00:00.000Z",
    channel: "telegram",
    triggerType: "goal",
    summary: "signup from France",
  },
];

const CATALOG: Array<{ company: string; agents: Array<[string, string, string]> }> = [
  {
    company: "OpenAI",
    agents: [
      ["ChatGPT-User", "answer_fetch", "Fetches pages when a ChatGPT user asks about them."],
      ["OAI-SearchBot", "search_index", "Indexes pages for ChatGPT search."],
      ["GPTBot", "training", "Crawls public content that may be used for training."],
    ],
  },
  {
    company: "Anthropic",
    agents: [
      ["Claude-User", "answer_fetch", "Fetches pages when a Claude user asks about them."],
      ["ClaudeBot", "training", "Collects public web content for training."],
    ],
  },
  { company: "Google", agents: [["Googlebot", "search_index", "Google Search's crawler."]] },
  {
    company: "Meta",
    agents: [["meta-externalagent", "training", "Crawls content for AI training."]],
  },
];

export function agentIds(company: string): string[] {
  return (CATALOG.find((c) => c.company === company)?.agents ?? []).map(
    ([ua, cat]) => `${company}::${ua}::${cat}`,
  );
}

export function catalog(settings: BotTrafficSettings) {
  const excluded = new Set(settings.excludedCrawlerIds);
  return CATALOG.map((c) => {
    const agents = c.agents.map(([userAgent, category, description]) => {
      const id = `${c.company}::${userAgent}::${category}`;
      return { id, userAgent, category, description, enabled: !excluded.has(id) };
    });
    const enabled = agents.filter((a) => a.enabled).length;
    return {
      company: c.company,
      status: enabled === agents.length ? "enabled" : enabled === 0 ? "disabled" : "partial",
      enabledAgentCount: enabled,
      totalAgentCount: agents.length,
      agents,
    };
  });
}

const DAYS = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 9, 6 + i));
  return d.toISOString().slice(0, 10);
});

export function botSummary(websiteId: string, domain: string, category: string): BotTrafficSummary {
  const crawlers = [
    {
      id: "OpenAI::ChatGPT-User::answer_fetch",
      company: "OpenAI",
      userAgent: "ChatGPT-User",
      category: "answer_fetch" as const,
      requestCount: 8840,
      ipVerifiedRequests: 8840,
      userAgentOnlyRequests: 0,
      percentage: 68.85,
    },
    {
      id: "Google::Googlebot::search_index",
      company: "Google",
      userAgent: "Googlebot",
      category: "search_index" as const,
      requestCount: 3000,
      ipVerifiedRequests: 2900,
      userAgentOnlyRequests: 100,
      percentage: 23.36,
    },
    {
      id: "Anthropic::ClaudeBot::training",
      company: "Anthropic",
      userAgent: "ClaudeBot",
      category: "training" as const,
      requestCount: 1000,
      ipVerifiedRequests: 0,
      userAgentOnlyRequests: 1000,
      percentage: 7.79,
    },
  ].filter((c) => category === "all" || c.category === category);
  const total = crawlers.reduce((s, c) => s + c.requestCount, 0);
  const by = (cat: string) =>
    crawlers.filter((c) => c.category === cat).reduce((s, c) => s + c.requestCount, 0);
  return {
    websiteId,
    domain,
    range: {
      startAt: "2026-10-06T00:00:00.000Z",
      endAt: "2026-11-04T23:59:59.999Z",
      timezone: "UTC",
      interval: "day",
    },
    filters: { category, verification: "all", company: "all", crawlerId: null },
    totalRequests: total,
    aiAnswerRequests: by("answer_fetch"),
    indexingRequests: by("search_index"),
    trainingRequests: by("training"),
    otherCrawlerRequests: 0,
    ipVerifiedRequests: crawlers.reduce((s, c) => s + c.ipVerifiedRequests, 0),
    userAgentOnlyRequests: crawlers.reduce((s, c) => s + c.userAgentOnlyRequests, 0),
    companies: crawlers.map((c) => ({
      company: c.company,
      requestCount: c.requestCount,
      aiAnswerRequests: c.category === "answer_fetch" ? c.requestCount : 0,
      ipVerifiedRequests: c.ipVerifiedRequests,
      percentage: c.percentage,
    })),
    crawlers,
    timeseries: DAYS.map((date, i) => ({
      date,
      requestCount: Math.round(total / 30 + (i % 7) * 12),
      aiAnswerRequests: Math.round(by("answer_fetch") / 30),
      ipVerifiedRequests: Math.round(total / 35),
    })),
  };
}

export const botPages: BotTrafficPage[] = [
  {
    id: "example.com::/pricing",
    hostname: "example.com",
    path: "/pricing",
    requestCount: 410,
    ipVerifiedRequests: 400,
    userAgentOnlyRequests: 10,
    statusCodes: [{ statusCode: 200, requestCount: 410 }],
    crawlers: [
      {
        id: "OpenAI::ChatGPT-User::answer_fetch",
        company: "OpenAI",
        userAgent: "ChatGPT-User",
        category: "answer_fetch",
        requestCount: 380,
      },
    ],
  },
  {
    id: "example.com::/llms.txt",
    hostname: "example.com",
    path: "/llms.txt",
    requestCount: 42,
    ipVerifiedRequests: 42,
    userAgentOnlyRequests: 0,
    statusCodes: [{ statusCode: 200, requestCount: 42 }],
    crawlers: [
      {
        id: "OpenAI::GPTBot::training",
        company: "OpenAI",
        userAgent: "GPTBot",
        category: "training",
        requestCount: 30,
      },
    ],
  },
  {
    id: "example.com::/free-trial",
    hostname: "example.com",
    path: "/free-trial",
    requestCount: 17,
    ipVerifiedRequests: 17,
    userAgentOnlyRequests: 0,
    statusCodes: [{ statusCode: 404, requestCount: 17 }],
    crawlers: [
      {
        id: "Anthropic::Claude-User::answer_fetch",
        company: "Anthropic",
        userAgent: "Claude-User",
        category: "answer_fetch",
        requestCount: 17,
      },
    ],
  },
];

export const attackMode: AttackModeState = {
  enabled: false,
  autoEnable: false,
  multiplier: 5,
  minHits: 100,
  durationMinutes: 240,
  autoActiveUntil: null,
  events: [],
};

export function integrationStatus(
  siteId: string,
  kind: GrowthIntegrationStatus["kind"],
): GrowthIntegrationStatus {
  const slug = { github: "github", gsc: "google-search-console", meta_ads: "meta-ads", x: "x" }[
    kind
  ];
  const base: GrowthIntegrationStatus = {
    kind,
    connected: false,
    status: null,
    settings: {},
    lastSyncedAt: null,
    lastError: null,
    oauthConfigured: true,
    connectUrl: `/api/connect/${slug}/start?websiteId=${siteId}`,
    hasCredentials: false,
  };
  if (kind === "x") {
    return {
      ...base,
      connected: true,
      status: "active",
      settings: {
        keywords: ["DataGoat"],
        handles: ["datagoat"],
        redditEnabled: true,
        usesServerToken: true,
      },
      lastSyncedAt: NOW,
    };
  }
  if (kind === "github") {
    return {
      ...base,
      connected: true,
      status: "active",
      settings: {
        repo: "example/app",
        webhookUrl: `https://datagoat.example/webhooks/github/${siteId}`,
        webhookSecret: "3f9a1c0d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
      },
      lastSyncedAt: NOW,
    };
  }
  return base;
}

export function searchConsoleStatus(
  siteId: string,
  connected: boolean,
  property: string | null,
): SearchConsoleStatus {
  return {
    connected,
    oauthConfigured: true,
    connectUrl: `/api/connect/google-search-console/start?websiteId=${siteId}&returnTo=search-console`,
    status: connected ? "active" : null,
    property: connected ? (property ?? "sc-domain:example.com") : null,
    properties: connected
      ? [
          { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
          { siteUrl: "https://www.example.com/", permissionLevel: "siteFullUser" },
        ]
      : null,
    propertiesError: null,
    lastSyncedAt: connected ? NOW : null,
    lastError: null,
    oldestDay: connected ? "2025-07-01" : null,
    newestDay: connected ? "2026-11-01" : null,
    backfillComplete: connected,
  };
}

export const searchConsoleOverview: SearchConsoleOverview = {
  currency: "USD",
  clicks: 200,
  impressions: 5200,
  ctr: 3.85,
  position: 6.8,
  estimatedRevenue: 850,
  timeseries: DAYS.map((date, i) => ({
    date,
    clicks: 4 + (i % 5),
    impressions: 160 + i * 2,
    ctr: 3.1,
    position: 7,
  })),
  previous: { clicks: 160, impressions: 4800, ctr: 3.33, position: 7.4, estimatedRevenue: 600 },
};

export const searchConsolePages: SearchConsoleRow[] = [
  {
    page: "https://example.com/",
    clicks: 140,
    impressions: 2000,
    ctr: 7,
    position: 3.2,
    estimatedRevenue: 600,
  },
  {
    page: "https://example.com/blog/privacy-analytics",
    clicks: 60,
    impressions: 3200,
    ctr: 1.88,
    position: 9.1,
    estimatedRevenue: 250,
  },
];

export const adAccounts: MetaAdAccount[] = [
  {
    id: "act_1",
    name: "Example Ads",
    currency: "USD",
    accountStatus: 1,
    campaigns: [
      { id: "120200", name: "Launch - US", status: "ACTIVE" },
      { id: "120201", name: "Retargeting", status: "PAUSED" },
    ],
  },
];

export const adsSummary: AdsSummary = {
  currency: "USD",
  spend: 500,
  revenue: 1400,
  roas: 2.8,
  campaigns: 1,
  impressions: 120000,
  clicks: 2400,
  visitors: 1900,
  payments: 18,
  currencyConverted: true,
};
