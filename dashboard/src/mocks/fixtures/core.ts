/**
 * Core fixtures: users, websites, keys, tokens, team. Shapes are the contract types in
 * shared/api-types.ts (docs/api/contract.md); TypeScript fails the build when they drift.
 */
import type {
  AccessToken,
  Account,
  PendingInvite,
  TeamMember,
  User,
  Website,
  WebsiteKey,
  WebsiteSummary,
} from "../../../../shared/api-types";

export const MOCK_PASSWORD = "demo-password";
export const NOW = "2026-11-04T12:00:00.000Z";

export const demoUser: User = {
  id: "6728f0a0a1b2c3d4e5f60001",
  email: "demo@datagoat.dev",
  name: "Demo Owner",
  image: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

export const websites: Website[] = [
  {
    _id: "6728f0a0a1b2c3d4e5f6a001",
    domain: "example.com",
    name: "Example SaaS",
    logo: null,
    trackingId: "dfid_ExampleSaaS0001",
    timezone: "America/New_York",
    currency: "USD",
    kpi: "signup",
    kpiColorScheme: "orange",
    revenueMetric: "revenue",
    isCookieless: false,
    isAttackModeEnabled: false,
    includeRenewalRevenue: true,
    allowedHostnames: ["app.example.com"],
    isAllHostnamesAllowed: false,
    excludedIps: [],
    excludedPaths: ["/admin/*"],
    excludedCountries: [],
    excludedHostnames: [],
    sendWeeklyReports: true,
    sendViralTrafficAlerts: false,
    isPublicDashboardEnabled: true,
    isPublicDataEnabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    privacyMode: "cookie",
    attributionModel: "first_touch",
    botLevel: "standard",
    honorGpc: true,
    datafastCompat: false,
    storeCustomerEmails: true,
    retentionDays: null,
    shareToken: "share_demo_token_000000",
    updatedAt: NOW,
    role: "owner",
  },
  {
    _id: "6728f0a0a1b2c3d4e5f6a002",
    domain: "blog.example.org",
    name: "Indie blog",
    logo: null,
    trackingId: "dfid_IndieBlog000002",
    timezone: "Europe/Paris",
    currency: "EUR",
    kpi: null,
    kpiColorScheme: null,
    revenueMetric: "revenue",
    isCookieless: true,
    isAttackModeEnabled: false,
    includeRenewalRevenue: true,
    allowedHostnames: [],
    isAllHostnamesAllowed: false,
    excludedIps: [],
    excludedPaths: [],
    excludedCountries: [],
    excludedHostnames: [],
    sendWeeklyReports: false,
    sendViralTrafficAlerts: false,
    isPublicDashboardEnabled: false,
    isPublicDataEnabled: false,
    createdAt: "2026-03-01T00:00:00.000Z",
    privacyMode: "cookieless",
    attributionModel: "first_touch",
    botLevel: "standard",
    honorGpc: true,
    datafastCompat: false,
    storeCustomerEmails: true,
    retentionDays: 365,
    shareToken: null,
    updatedAt: NOW,
    role: "member",
  },
];

export function summary(w: Website): WebsiteSummary {
  return {
    _id: w._id,
    domain: w.domain,
    name: w.name,
    logo: w.logo,
    trackingId: w.trackingId,
    timezone: w.timezone,
    currency: w.currency,
    role: w.role ?? "owner",
    createdAt: w.createdAt,
  };
}

export const account: Account = {
  _id: demoUser.id,
  name: demoUser.name,
  email: demoUser.email,
  image: null,
  hasAccess: true,
  planType: "self_hosted",
  isFreeTrialActive: false,
  freeTrialStartAt: null,
  billingCycleStartAt: null,
  billingCycleEndAt: null,
  createdAt: demoUser.createdAt,
};

export const accessTokens: AccessToken[] = [
  {
    id: "6728f0a0a1b2c3d4e5f6b001",
    userId: demoUser.id,
    name: "Read only agent",
    displayKey: "dft_Ab1...xyz9",
    scope: "user",
    websiteId: null,
    permissions: ["analytics:read", "websites:read"],
    websiteIds: [],
    keyPrefix: "dft_Ab1c",
    lastUsedAt: NOW,
    usageCount: 42,
    expiresAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  },
];

export function websiteKeys(websiteId: string): WebsiteKey[] {
  return [
    {
      id: "6728f0a0a1b2c3d4e5f6c001",
      userId: demoUser.id,
      name: "Production backend",
      displayKey: "df_Ab...wxyz",
      websiteId,
      keyPrefix: "df_Ab123",
      lastUsedAt: null,
      usageCount: 0,
      isMobile: false,
      includePii: false,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
  ];
}

export const team: TeamMember[] = [
  {
    userId: demoUser.id,
    name: demoUser.name,
    email: demoUser.email,
    image: null,
    role: "owner",
    joinedAt: demoUser.createdAt,
  },
  {
    userId: "6728f0a0a1b2c3d4e5f60002",
    name: "Sam Member",
    email: "sam@example.com",
    image: null,
    role: "member",
    joinedAt: "2026-02-01T00:00:00.000Z",
  },
  {
    userId: "6728f0a0a1b2c3d4e5f60003",
    name: null,
    email: "viewer@example.com",
    image: null,
    role: "viewer",
    joinedAt: "2026-03-01T00:00:00.000Z",
  },
];

export const pendingInvites: PendingInvite[] = [
  {
    invitationId: "6728f0a0a1b2c3d4e5f6d001",
    email: "new@example.com",
    role: "viewer",
    createdAt: NOW,
    expiresAt: "2026-11-11T12:00:00.000Z",
  },
];
