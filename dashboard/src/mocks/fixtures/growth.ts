/** Revenue (W3), growth (W6) and MCP (W7) fixtures. */
import type {
  AdCampaignRow,
  Alert,
  AlertHistoryEntry,
  BotTokenStatus,
  BotTrafficPage,
  BotTrafficSettings,
  BotTrafficSummary,
  GithubCommit,
  GrowthIntegrationStatus,
  ImportJob,
  IntegrationsStatus,
  Mention,
  OAuthConnection,
  PathToPurchase,
  PaymentRow,
  RevenueSourceRow,
  RevenueSummary,
  SearchConsoleRow,
  XLinkRow,
} from "../../../../shared/api-types";
import { NOW } from "./core";

export const integrations: IntegrationsStatus = {
  stripe: { connected: true },
  lemonsqueezy: { connected: false },
  polar: { connected: false },
  paddle: { connected: false, keyExpiresAt: null },
  shopify: { connected: false },
  woocommerce: { connected: false },
  dodo: { connected: false },
  creem: { connected: false },
  currency: "USD",
  details: [
    {
      provider: "stripe",
      status: "active",
      accountName: "Example Inc.",
      lastSyncedAt: NOW,
      lastError: null,
      backfillComplete: true,
    },
  ],
};

export const payments: PaymentRow[] = [
  {
    id: "pay1",
    provider: "stripe",
    transactionId: "cs_test_123",
    kind: "payment",
    amount: 49,
    currency: "USD",
    originalAmount: 49,
    originalCurrency: "USD",
    visitorId: "a3ab2331-989f-4cfa-91c6-2461c9e3c6bd",
    attributedVia: "metadata",
    channel: "Organic Search",
    customerEmail: "alex@example.net",
    customerName: "Alex Customer",
    timestamp: NOW,
  },
  {
    id: "pay2",
    provider: "stripe",
    transactionId: "in_456",
    kind: "renewal",
    amount: 49,
    currency: "USD",
    originalAmount: 45,
    originalCurrency: "EUR",
    visitorId: null,
    attributedVia: "none",
    channel: null,
    timestamp: NOW,
  },
];

export const revenueSummary: RevenueSummary = {
  currency: "USD",
  revenue: 28450,
  newRevenue: 21000,
  renewalRevenue: 8150,
  refunds: -700,
  payments: 328,
  customers: 301,
  attribution: {
    attributedRevenue: 25100,
    unattributedRevenue: 3350,
    coveragePercentage: 88.22,
    byMethod: { metadata: 18000, link: 3100, customer: 2600, email: 900, api: 500, none: 3350 },
  },
  lifetimeValueByChannel: [
    { channel: "Organic Search", customers: 120, revenue: 11000, averageValue: 91.67 },
    { channel: "Direct", customers: 98, revenue: 8100, averageValue: 82.65 },
  ],
};

export const revenueSources: RevenueSourceRow[] = [
  {
    value: "Organic Search",
    revenue: 11000,
    newRevenue: 8400,
    renewalRevenue: 2900,
    refunds: -300,
    payments: 131,
    customers: 120,
    share: 38.66,
  },
  {
    value: "Direct",
    revenue: 8100,
    newRevenue: 5900,
    renewalRevenue: 2400,
    refunds: -200,
    payments: 101,
    customers: 98,
    share: 28.47,
  },
  {
    value: "Unattributed",
    revenue: 3350,
    newRevenue: 2600,
    renewalRevenue: 750,
    refunds: 0,
    payments: 40,
    customers: 0,
    share: 11.78,
  },
];

export const pathToPurchase: PathToPurchase = {
  currency: "USD",
  model: "first_touch",
  customers: 218,
  averageDaysToPurchase: 6.4,
  medianDaysToPurchase: 2,
  averageSessionsToPurchase: 2.7,
  medianSessionsToPurchase: 2,
  averagePageviewsToPurchase: 7.9,
  timeToPurchase: [
    { bucket: "same_day", customers: 86, percentage: 39.45 },
    { bucket: "1_7_days", customers: 71, percentage: 32.57 },
    { bucket: "8_30_days", customers: 43, percentage: 19.72 },
    { bucket: "31_90_days", customers: 15, percentage: 6.88 },
    { bucket: "over_90_days", customers: 3, percentage: 1.38 },
  ],
  sessionsToPurchase: [
    { sessions: "1", customers: 80, percentage: 36.7 },
    { sessions: "2", customers: 62, percentage: 28.44 },
    { sessions: "3", customers: 35, percentage: 16.06 },
    { sessions: "4", customers: 18, percentage: 8.26 },
    { sessions: "5+", customers: 23, percentage: 10.55 },
  ],
  paths: [
    { firstChannel: "Organic Search", lastChannel: "Direct", customers: 64, revenue: 5800 },
    { firstChannel: "Organic Search", lastChannel: "Organic Search", customers: 41, revenue: 3600 },
    { firstChannel: "Referral", lastChannel: "Direct", customers: 22, revenue: 1900 },
  ],
};

export function alerts(websiteId: string): Alert[] {
  return [
    {
      id: "6728f0a0a1b2c3d4e5f6a101",
      websiteId,
      name: "New signup",
      trigger: { type: "goal", goalName: "signup" },
      destination: { type: "email", email: "demo@datagoat.dev" },
      template: { subject: "New signup", message: "A visitor signed up." },
      isEnabled: true,
      triggerCount: 18,
      monthlyCount: 4,
      monthlyCountResetAt: "2026-11-01T00:00:00.000Z",
      dailyCount: 1,
      dailyCountResetAt: "2026-11-04T00:00:00.000Z",
      lastTriggeredAt: NOW,
      recentLogs: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: NOW,
    },
  ];
}

export const alertHistory: AlertHistoryEntry[] = [
  {
    alertId: "6728f0a0a1b2c3d4e5f6a101",
    alertName: "New signup",
    goalName: "signup",
    status: "sent",
    error: null,
    visitorId: "a3ab2331-989f-4cfa-91c6-2461c9e3c6bd",
    triggeredAt: NOW,
  },
];

const crawler = {
  id: "OpenAI::ChatGPT-User::answer_fetch",
  company: "OpenAI",
  userAgent: "ChatGPT-User",
  category: "answer_fetch" as const,
};

export function botSummary(websiteId: string, domain: string): BotTrafficSummary {
  return {
    websiteId,
    domain,
    range: {
      startAt: "2026-10-06T00:00:00.000Z",
      endAt: "2026-11-04T23:59:59.999Z",
      timezone: "UTC",
      interval: "day",
    },
    filters: { category: "all", verification: "all", company: "all", crawlerId: null },
    totalRequests: 12840,
    aiAnswerRequests: 8840,
    indexingRequests: 3000,
    trainingRequests: 1000,
    otherCrawlerRequests: 0,
    ipVerifiedRequests: 12000,
    userAgentOnlyRequests: 840,
    companies: [
      {
        company: "OpenAI",
        requestCount: 8840,
        aiAnswerRequests: 8840,
        ipVerifiedRequests: 8840,
        percentage: 68.85,
      },
    ],
    crawlers: [
      {
        ...crawler,
        requestCount: 8840,
        ipVerifiedRequests: 8840,
        userAgentOnlyRequests: 0,
        percentage: 68.85,
      },
    ],
    timeseries: [
      { date: "2026-11-04", requestCount: 420, aiAnswerRequests: 300, ipVerifiedRequests: 400 },
    ],
  };
}

export const botPages: BotTrafficPage[] = [
  {
    id: "example.com::/llms.txt",
    hostname: "example.com",
    path: "/llms.txt",
    requestCount: 42,
    ipVerifiedRequests: 42,
    userAgentOnlyRequests: 0,
    statusCodes: [{ statusCode: 200, requestCount: 42 }],
    crawlers: [{ ...crawler, requestCount: 30 }],
  },
];

export const botSettings: BotTrafficSettings = {
  hiddenCrawlers: [],
  excludedCrawlerIds: ["Meta::meta-externalagent::training"],
  verifiedOnly: true,
  hideDashboardCard: false,
  groupBy: "crawlers",
  pageFilterIds: [],
  requireAuthToken: false,
};

export function botToken(websiteId: string, domain: string): BotTokenStatus {
  return {
    websiteId,
    domain,
    hasToken: false,
    displayToken: null,
    createdAt: null,
    requireAuthToken: false,
  };
}

export function mentions(websiteId: string): Mention[] {
  return [
    {
      id: "m1",
      websiteId,
      platform: "x",
      timestamp: NOW,
      text: "We launched our new website: example.com",
      url: "https://x.com/example/status/123",
      author: { name: "Alex", username: "example", image: null },
      engagement: { likes: 12, replies: 2, reposts: 1, quotes: 0 },
      media: [],
      isRetweet: false,
    },
    {
      id: "m2",
      websiteId,
      platform: "reddit",
      timestamp: NOW,
      text: "Anyone tried example.com for analytics?",
      url: "https://reddit.com/r/SaaS/comments/abc",
      author: { name: null, username: "founder42", image: null },
      engagement: { score: 31, comments: 9 },
      subreddit: "SaaS",
    },
  ];
}

export const xLinks: XLinkRow[] = [
  {
    tweetId: "123",
    tweetUrl: "https://x.com/example/status/123",
    authorUsername: "example",
    text: "We launched…",
    visitors: 310,
    revenue: 900,
    payments: 9,
  },
];

export const commits: GithubCommit[] = [
  {
    sha: "a1b2c3d",
    repo: "example/app",
    branch: "main",
    message: "feat: new pricing page",
    author: { name: "Demo Owner", login: "demo", avatar: null },
    additions: 120,
    deletions: 14,
    url: "https://github.com/example/app/commit/a1b2c3d",
    timestamp: "2026-10-20T09:00:00.000Z",
  },
];

export const searchConsole: SearchConsoleRow[] = [
  {
    query: "privacy analytics",
    clicks: 120,
    impressions: 4300,
    ctr: 2.79,
    position: 7.4,
    estimatedRevenue: 310,
  },
  {
    query: "datafast alternative",
    clicks: 80,
    impressions: 900,
    ctr: 8.89,
    position: 3.1,
    estimatedRevenue: 540,
  },
];

export const adCampaigns: AdCampaignRow[] = [
  {
    platform: "meta",
    accountId: "act_1",
    campaignId: "120200",
    campaignName: "Launch - US",
    spend: 500,
    impressions: 120000,
    clicks: 2400,
    visitors: 1900,
    revenue: 1400,
    payments: 18,
    roas: 2.8,
  },
];

export function imports(websiteId: string): ImportJob[] {
  return [
    {
      id: "6728f0a0a1b2c3d4e5f6a201",
      websiteId,
      source: "plausible",
      status: "completed",
      fileName: "plausible-export.zip",
      rangeStart: "2024-01-01",
      rangeEnd: "2025-12-31",
      rowsTotal: 14000,
      rowsImported: 14000,
      error: null,
      createdAt: "2026-01-02T00:00:00.000Z",
      finishedAt: "2026-01-02T00:03:00.000Z",
    },
  ];
}

export function growthIntegration(kind: GrowthIntegrationStatus["kind"]): GrowthIntegrationStatus {
  return {
    kind,
    connected: kind === "github",
    status: kind === "github" ? "active" : null,
    settings: {},
    lastSyncedAt: null,
    lastError: null,
  };
}

export const oauthConnections: OAuthConnection[] = [
  {
    id: "conn1",
    client: { id: "client1", name: "Claude Code" },
    scopes: ["analytics:read", "websites:read"],
    websiteIds: ["6728f0a0a1b2c3d4e5f6a001"],
    createdAt: NOW,
    expiresAt: "2027-02-02T12:00:00.000Z",
    lastUsedAt: NOW,
  },
];
