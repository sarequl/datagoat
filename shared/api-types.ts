/**
 * TypeScript shapes of the DataGoat HTTP API. This file is the machine-checked half of
 * docs/api/contract.md: the dashboard's API client and its mock fixtures are typed against it,
 * and Worker handlers should return these shapes. Change both files together.
 *
 * Conventions: timestamps are ISO 8601 strings (UTC), money is in major units of the website
 * currency, ids are strings. Field names follow DataFast where DataFast has the endpoint.
 */
import type { Grant, Role } from "./permissions";

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface Pagination {
  limit: number;
  offset: number;
  total: number;
  hasMore?: boolean;
  nextOffset?: number | null;
}

/** `{status: "success", data, pagination?}` plus endpoint-specific top-level fields. */
export type ApiSuccess<T, Extra extends object = Record<never, never>> = {
  status: "success";
  data: T;
  pagination?: Pagination;
} & Extra;

export interface ApiErrorBody {
  status: "error";
  error: { code: number; message: string };
}

/** DataFast's 429 body (sent with X-RateLimit-* headers). */
export interface RateLimitErrorBody {
  error: "Too many requests";
  message: string;
  limit: number;
  remaining: number;
  reset: number;
}

export type PrivacyMode = "cookie" | "cookieless" | "consent";
export type AttributionModel = "first_touch" | "last_touch" | "last_non_direct";
export type BotLevel = "off" | "standard" | "strict";
export type Interval = "hour" | "day" | "week" | "month";

// ---------------------------------------------------------------------------
// Setup and dashboard auth (F0)
// ---------------------------------------------------------------------------

export interface SetupStatus {
  needsSetup: boolean;
  configErrors: string[];
}

export interface SetupRequest {
  token: string;
  email: string;
  password: string;
  name?: string | null;
  website?: { domain: string; timezone?: string; name?: string | null; currency?: string };
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  createdAt: string;
}

export interface Me {
  user: User;
  websites: WebsiteSummary[];
  authKind?: "session" | "site_key" | "account_token" | "oauth";
}

export interface SetupResult extends Me {
  website: { websiteId: string; domain: string; trackingId: string } | null;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface InviteInfo {
  email: string;
  role: "member" | "viewer";
  website: { id: string; domain: string; name: string | null };
  invitedBy: { name: string | null; email: string } | null;
  expiresAt: string;
  userExists: boolean;
  signedInAs: string | null;
}

export interface AcceptInviteRequest {
  name?: string | null;
  password?: string;
}

// ---------------------------------------------------------------------------
// Account API (/api/v1/admin) — F0
// ---------------------------------------------------------------------------

export interface Account {
  _id: string;
  name: string | null;
  email: string;
  image: string | null;
  hasAccess: boolean;
  planType: string | null;
  isFreeTrialActive: boolean;
  freeTrialStartAt: string | null;
  billingCycleStartAt: string | null;
  billingCycleEndAt: string | null;
  createdAt: string;
  websiteId?: string;
}

export interface AccessToken {
  id: string;
  userId: string;
  name: string | null;
  displayKey: string;
  scope: "user";
  websiteId: null;
  permissions: Grant[];
  websiteIds: string[];
  keyPrefix: string;
  lastUsedAt: string | null;
  usageCount: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Only in the create response. */
  key?: string;
}

export interface CreateAccessTokenRequest {
  name?: string | null;
  permissions?: Grant[];
  websiteIds?: string[];
  includePii?: boolean;
  expiresInDays?: number | null;
}

export interface WebsiteKey {
  id: string;
  userId: string;
  name: string | null;
  displayKey: string;
  websiteId: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  usageCount: number;
  isMobile: boolean;
  includePii: boolean;
  createdAt: string;
  updatedAt: string;
  key?: string;
}

export interface WebsiteSummary {
  _id: string;
  domain: string;
  name: string | null;
  logo: string | null;
  trackingId: string;
  timezone: string;
  currency: string;
  role: Role;
  createdAt: string;
}

export interface Website {
  _id: string;
  domain: string;
  name: string | null;
  logo: string | null;
  trackingId: string;
  timezone: string;
  currency: string;
  kpi: string | null;
  kpiColorScheme: string | null;
  revenueMetric: string;
  isCookieless: boolean;
  isAttackModeEnabled: boolean;
  includeRenewalRevenue: boolean;
  allowedHostnames: string[];
  isAllHostnamesAllowed: boolean;
  excludedIps: string[];
  excludedPaths: string[];
  excludedCountries: string[];
  excludedHostnames: string[];
  sendWeeklyReports: boolean;
  sendViralTrafficAlerts: boolean;
  isPublicDashboardEnabled: boolean;
  isPublicDataEnabled: boolean;
  createdAt: string;
  privacyMode: PrivacyMode;
  attributionModel: AttributionModel;
  botLevel: BotLevel;
  honorGpc: boolean;
  storeCustomerEmails: boolean;
  retentionDays: number | null;
  shareToken: string | null;
  updatedAt: string;
  role?: Role;
  /**
   * Proposed (W5 → F0/W1): substrings of User-Agent to drop at ingest. The dashboard shows the
   * editor only when the server returns this field; see docs/api/contract.md §3.
   */
  excludedUserAgents?: string[];
}

export type WebsiteUpdate = Partial<
  Pick<
    Website,
    | "domain"
    | "name"
    | "logo"
    | "timezone"
    | "currency"
    | "kpi"
    | "kpiColorScheme"
    | "sendWeeklyReports"
    | "sendViralTrafficAlerts"
    | "isPublicDashboardEnabled"
    | "isPublicDataEnabled"
    | "isCookieless"
    | "isAttackModeEnabled"
    | "includeRenewalRevenue"
    | "allowedHostnames"
    | "isAllHostnamesAllowed"
    | "excludedIps"
    | "excludedPaths"
    | "excludedCountries"
    | "excludedHostnames"
    | "excludedUserAgents"
    | "privacyMode"
    | "attributionModel"
    | "botLevel"
    | "honorGpc"
    | "storeCustomerEmails"
    | "retentionDays"
  > & { revenueMetric: "revenue" | "mrr" }
>;

export interface CreateWebsiteRequest {
  domain: string;
  timezone: string;
  name?: string | null;
  currency?: string;
}

export interface CreatedWebsite {
  websiteId: string;
  domain: string;
  trackingId: string;
}

export interface TeamMember {
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  role: Role;
  joinedAt: string;
}

export interface CreatedInvite {
  message: string;
  invitationId: string;
  email: string;
  role: "member" | "viewer";
  inviteUrl: string;
  expiresAt: string;
}

export interface PendingInvite {
  invitationId: string;
  email: string;
  role: "member" | "viewer";
  createdAt: string;
  expiresAt: string;
}

export interface MessageResult {
  message: string;
}

// ---------------------------------------------------------------------------
// Analytics (/api/v1/analytics) — W2
// ---------------------------------------------------------------------------

export interface VisitorBreakdown {
  new: number;
  returning: number;
  newPercentage: number;
  returningPercentage: number;
}

export interface Overview {
  visitors: number;
  new_visitors: number;
  returning_visitors: number;
  visitorBreakdown: VisitorBreakdown;
  pageviews: number;
  sessions: number;
  bounce_rate: number;
  avg_session_duration: number;
  currency: string;
  revenue: number;
  payments: number;
  revenue_per_visitor: number;
  conversion_rate: number;
}

export interface TimeseriesPoint {
  timestamp: string;
  name?: string;
  visitors?: number;
  new_visitors?: number;
  returning_visitors?: number;
  visitorBreakdown?: VisitorBreakdown;
  pageviews?: number;
  sessions?: number;
  revenue?: number;
  payments?: number;
  conversion_rate?: number;
  /** DataGoat extensions (`fields=bounce_rate,avg_session_duration,goals`). */
  bounce_rate?: number;
  avg_session_duration?: number;
  /** Completions per goal name in the bucket (`fields=goals`). */
  goals?: Record<string, number>;
}

export interface RevenueBreakdown {
  new: number;
  renewal: number;
  refunds: number;
}

export interface TimeseriesExtra {
  fields: string[];
  interval: Interval;
  timezone: string;
  currency: string;
  totals: Omit<TimeseriesPoint, "timestamp" | "name"> & { revenueBreakdown?: RevenueBreakdown };
}

export interface Metadata {
  domain: string;
  timezone: string;
  name: string;
  logo: string | null;
  kpiColorScheme: string;
  kpi: string | null;
  currency: string;
}

export interface BreakdownMetrics {
  visitors: number;
  revenue: number;
  payments: number;
}

export interface PageRow extends BreakdownMetrics {
  hostname: string;
  path: string;
}
export interface ReferrerRow extends BreakdownMetrics {
  referrer: string;
}
export interface ChannelRow extends BreakdownMetrics {
  channel: string;
}
export interface CampaignRow extends BreakdownMetrics {
  campaign: {
    utm_source: string;
    utm_medium: string;
    utm_campaign: string;
    utm_term: string;
    utm_content: string;
    ref: string;
    source: string;
    via: string;
  };
}
export interface CountryRow extends BreakdownMetrics {
  country: string;
  image: string | null;
  /** DataGoat extension: ISO 3166-1 alpha-2 code. */
  code?: string;
}
export interface RegionRow extends BreakdownMetrics {
  region: string;
}
export interface CityRow extends BreakdownMetrics {
  city: string;
}
export interface DeviceRow extends BreakdownMetrics {
  device: string;
}
export interface BrowserRow extends BreakdownMetrics {
  browser: string;
}
export interface OperatingSystemRow extends BreakdownMetrics {
  operating_system: string;
}
export interface HostnameRow extends BreakdownMetrics {
  hostname: string;
}
export interface EntryPageRow extends BreakdownMetrics {
  hostname: string;
  path: string;
}
export interface ExitClickRow {
  url: string;
  visitors: number;
  clicks: number;
}
export interface GoalRow {
  goal: string;
  completions: number;
  visitors: number;
  /** DataGoat extensions used by the dashboard goals card. */
  revenue?: number;
  conversion_rate?: number;
}
export interface GoalPropertyRow {
  property?: string;
  value?: string;
  completions: number;
  visitors: number;
}

export interface Realtime {
  visitors: number;
}

export interface RealtimeVisitor {
  visitorId: string;
  location: { city: string | null; region: string | null; countryCode: string | null };
  system: {
    browser: { name: string } | null;
    os: { name: string } | null;
    device: { type: string } | null;
  };
  currentUrl: string | null;
  referrer: string | null;
  sessionStartTime: string | null;
  visitCount: number;
  params: Record<string, string | null>;
  latitude: number | null;
  longitude: number | null;
  isCustomer: boolean;
  customerName: string | null;
  customerEmail: string | null;
  profileData: {
    displayName: string | null;
    userId: string | null;
    profileImage?: string;
    hasProfile: boolean;
    isRandomName: boolean;
  };
  conversionLikelihood?: {
    score: number;
    confidence: number;
    isCustomer?: boolean;
    isBaseline?: boolean;
    dimensionMatches?: Array<{ dimension: string; value: string; conversionRate: number }>;
    raw?: { conversionRate: number; averageValue: number; expectedValue: number };
  };
}

export interface RealtimeMap {
  count: number;
  visitors: RealtimeVisitor[];
  conversionMetrics?: { baselineConversionRate: number; baselineAverageValue: number };
  hasConversionPredictions: boolean;
  recentEvents: Array<{
    _id: string;
    type: string | null;
    visitorId: string;
    timestamp: string;
    path: string | null;
    countryCode: string | null;
    extraData: Record<string, unknown>;
    referrer: string | null;
    customerName: string | null;
    amount: number | null;
    displayName: string | null;
  }>;
  recentPayments: Array<{
    _id: string;
    type: "payment_received";
    timestamp: string;
    name: string | null;
    email: string | null;
    amount: number;
    currency: string;
    renewal: boolean;
    displayName: null;
    isNew: boolean;
    visible: boolean;
  }>;
}

/**
 * DataGoat extension: `GET /api/v1/analytics/realtime/replay` — the last 8 hours of globe
 * activity in 15-minute frames (DataFast's globe replay).
 */
export interface RealtimeReplayFrame {
  /** Frame start (ISO). */
  at: string;
  visitors: Array<{
    visitorId: string;
    latitude: number | null;
    longitude: number | null;
    countryCode: string | null;
    city: string | null;
    isCustomer: boolean;
    conversionScore: number | null;
  }>;
  pageviews: number;
  goals: number;
  payments: number;
}

export interface RealtimeReplay {
  stepMinutes: number;
  startAt: string;
  endAt: string;
  frames: RealtimeReplayFrame[];
}

export type FunnelUrlMatchType =
  | "equals"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "not_equals"
  | "not_contains"
  | "wildcard";

export interface FunnelStep {
  _id?: string;
  id?: string;
  name: string;
  type: "pageview" | "goal";
  url?: string;
  urlMatchType?: FunnelUrlMatchType;
  hostname?: string;
  goalName?: string;
  goalCompletionType?: "completed" | "not_completed";
}

export interface Funnel {
  id: string;
  websiteId: string;
  name: string;
  slug: string;
  steps: FunnelStep[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FunnelResult {
  funnel: { id: string; name: string; slug: string; steps: FunnelStep[] };
  data: Array<{
    id: string;
    label: string;
    value: number;
    stepIndex: number;
    stepType: "pageview" | "goal";
    revenue: number;
    conversionRate: number;
    dropoffFromPrevious: number;
  }>;
  metrics: {
    totalVisitors: number;
    completions: number;
    overallConversionRate: number;
    overallRevenuePerVisitor: number;
    timezone: string;
    startAt: string | null;
    endAt: string | null;
    lastUpdated: string;
  };
}

// ---------------------------------------------------------------------------
// Visitors (/api/v1/visitors) — W2
// ---------------------------------------------------------------------------

export interface VisitorListRow {
  visitorId: string;
  lastSeenAt: string | null;
  visitorFirstSeenAt: string | null;
  visitorSessionNumber: number | null;
  visitorType: "new" | "returning" | null;
  currentUrl: string | null;
  identity: {
    country: string | null;
    region: string | null;
    city: string | null;
    browser: string | null;
    os: string | null;
    device: string | null;
  };
  acquisition: Record<string, string | null>;
  /** DataGoat extensions for the dashboard visitors list. */
  userId?: string | null;
  displayName?: string | null;
  revenue?: number;
}

export interface VisitorProfile {
  visitorId: string;
  identity: {
    country: string | null;
    countryCode: string | null;
    region: string | null;
    city: string | null;
    params: Record<string, string | null>;
    adClickIds: Record<string, string>;
    browser: { name: string | null; version: string | null };
    os: { name: string | null; version: string | null };
    device: { type: string | null; vendor: string | null; model: string | null };
    viewport: { width: number | null; height: number | null };
  };
  activity: {
    visitCount: number;
    visitorFirstSeenAt: string | null;
    visitorSessionNumber: number;
    visitorType: "new" | "returning" | null;
    pageViewCount: number;
    timeSinceFirstVisit: number;
    timeSinceCurrentVisit: number;
    firstVisitAt: string | null;
    lastVisitAt: string | null;
    currentUrl: string | null;
    completedGoals: Array<{
      name: string;
      origin: "manual" | "payment_provider";
      type: "custom" | "payment" | "subscription_lifecycle";
      timestamp: string;
    }>;
    visitedPages: Array<{ url: string; timestamp: string }>;
  };
  profile?: { userId: string; metadata: Record<string, unknown>; identifiedAt: string };
  prediction?: { score: number; conversionRate: number; expectedValue: number; confidence: number };
  /** DataGoat extensions: the journey timeline used by the visitor profile page. */
  sessions?: Array<{
    id: string;
    startedAt: string;
    endedAt: string;
    channel: string;
    referrer: string | null;
    entryPath: string;
    pageviews: number;
  }>;
  payments?: Array<{
    id: string;
    amount: number;
    currency: string;
    kind: "payment" | "renewal" | "refund" | "free_trial";
    provider: string;
    timestamp: string;
  }>;
}

// ---------------------------------------------------------------------------
// Website admin resources — W2 (goals, notes, segments, share, usage)
// ---------------------------------------------------------------------------

export interface TrackedGoal {
  name: string;
  displayName: string | null;
  color: string | null;
  description: string | null;
  hidden?: boolean;
  total: number;
  uv: number;
  conversionRate: number;
  eventType: string;
}

export interface GoalCustomization {
  goalName: string;
  displayName: string | null;
  color: string | null;
  description: string | null;
  hidden: boolean;
  updatedAt: string | null;
}

export interface GoalColor {
  color: string;
  label: string;
  family: string;
}

export interface Note {
  id: string;
  websiteId: string;
  text: string;
  timestamp: string;
  author: { id: string; name: string | null; image: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface Segment {
  id: string;
  websiteId: string;
  name: string;
  /** `{ "filter_country": "is:US", "filter_goal": "is:payment" }` */
  filters: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface ShareLink {
  enabled: boolean;
  token: string | null;
  url: string | null;
  isPublicDataEnabled: boolean;
}

export interface Usage {
  databaseSizeBytes: number;
  databaseLimitBytes: number;
  databasePercentUsed: number;
  plan: "free" | "paid" | "unknown";
  rows: { events: number; sessions: number; visitors: number; payments: number };
  last24h: { events: number; sessions: number; estimatedRowsWritten: number };
  estimatedDailyWriteLimit: number;
  retentionDays: number | null;
  oldestEventAt: string | null;
}

// ---------------------------------------------------------------------------
// Revenue (W3)
// ---------------------------------------------------------------------------

export type PaymentProvider =
  | "stripe"
  | "polar"
  | "lemonsqueezy"
  | "paddle"
  | "dodo"
  | "creem"
  | "shopify"
  | "woocommerce";

export interface IntegrationsStatus {
  stripe: { connected: boolean };
  lemonsqueezy: { connected: boolean };
  polar: { connected: boolean };
  paddle: { connected: boolean; keyExpiresAt: string | null };
  shopify: { connected: boolean };
  woocommerce: { connected: boolean };
  currency: string;
  /** DataGoat extensions */
  dodo?: { connected: boolean };
  creem?: { connected: boolean };
  details?: Array<{
    provider: PaymentProvider;
    status: "active" | "error" | "disconnected" | "pending";
    accountName: string | null;
    lastSyncedAt: string | null;
    lastError: string | null;
    backfillComplete: boolean;
  }>;
}

export interface CreatePaymentRequest {
  amount: number;
  currency: string;
  transaction_id: string;
  datafast_visitor_id?: string;
  visitorId?: string;
  email?: string;
  customer_email?: string;
  name?: string;
  customer_name?: string;
  customer_id?: string;
  renewal?: boolean;
  refunded?: boolean;
  is_free_trial?: boolean;
  timestamp?: string;
}

/** Plain body (no envelope), DataFast-compatible. */
export interface CreatePaymentResult {
  message: string;
  transaction_id?: string;
}

export interface PaymentRow {
  id: string;
  provider: string;
  transactionId: string;
  kind: "payment" | "renewal" | "refund" | "free_trial";
  amount: number;
  currency: string;
  originalAmount: number;
  originalCurrency: string;
  visitorId: string | null;
  attributedVia: "metadata" | "link" | "customer" | "email" | "api" | "none";
  channel: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  timestamp: string;
}

export interface RevenueSummary {
  currency: string;
  revenue: number;
  newRevenue: number;
  renewalRevenue: number;
  refunds: number;
  payments: number;
  customers: number;
  attribution: {
    attributedRevenue: number;
    unattributedRevenue: number;
    coveragePercentage: number;
    byMethod: Record<"metadata" | "link" | "customer" | "email" | "api" | "none", number>;
  };
  lifetimeValueByChannel: Array<{
    channel: string;
    customers: number;
    revenue: number;
    averageValue: number;
  }>;
  /** DataGoat extension: how customers got to their first payment in the range. */
  pathToPurchase?: {
    customers: number;
    averageDaysToPurchase: number;
    averageSessionsToPurchase: number;
    averagePageviewsToPurchase: number;
    /** Most common channel sequences across the customer's sessions before paying. */
    topPaths: Array<{ channels: string[]; customers: number; revenue: number }>;
  };
}

// ---------------------------------------------------------------------------
// Growth (W6): alerts, bot traffic, mentions, GitHub, GSC, ads, imports
// ---------------------------------------------------------------------------

export interface Alert {
  id: string;
  websiteId: string;
  name: string;
  trigger: {
    type: "goal" | "new_sale" | "traffic_spike" | "weekly_digest";
    goalName?: string;
    multiplier?: number;
  };
  destination: { type: "email" | "telegram"; email?: string; chatId?: string };
  template: { subject?: string; message: string };
  isEnabled: boolean;
  triggerCount: number;
  monthlyCount: number;
  monthlyCountResetAt: string;
  dailyCount: number;
  dailyCountResetAt: string;
  lastTriggeredAt?: string | null;
  lastError?: string | null;
  recentLogs: Array<{
    status: "sent" | "failed";
    error: string | null;
    visitorId: string | null;
    at: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface AlertHistoryEntry {
  alertId: string;
  alertName: string;
  goalName: string | null;
  status: "sent" | "failed";
  error: string | null;
  visitorId: string | null;
  triggeredAt: string;
}

export type BotCategory = "answer_fetch" | "search_index" | "training" | "ai_crawler";

export interface BotCrawlerCount {
  id: string;
  company: string;
  userAgent: string;
  category: BotCategory;
  requestCount: number;
  ipVerifiedRequests?: number;
  userAgentOnlyRequests?: number;
  percentage?: number;
}

export interface BotTrafficSummary {
  websiteId: string;
  domain: string;
  range: { startAt: string; endAt: string; timezone: string; interval: Interval };
  filters: { category: string; verification: string; company: string; crawlerId: string | null };
  totalRequests: number;
  aiAnswerRequests: number;
  indexingRequests: number;
  trainingRequests: number;
  otherCrawlerRequests: number;
  ipVerifiedRequests: number;
  userAgentOnlyRequests: number;
  companies: Array<{
    company: string;
    requestCount: number;
    aiAnswerRequests: number;
    ipVerifiedRequests: number;
    percentage: number;
  }>;
  crawlers: BotCrawlerCount[];
  timeseries: Array<{
    date: string;
    requestCount: number;
    aiAnswerRequests: number;
    ipVerifiedRequests: number;
  }>;
}

export interface BotTrafficPage {
  id: string;
  hostname: string;
  path: string;
  requestCount: number;
  ipVerifiedRequests: number;
  userAgentOnlyRequests: number;
  statusCodes: Array<{ statusCode: number; requestCount: number }>;
  crawlers: BotCrawlerCount[];
}

export interface BotTrafficSettings {
  hiddenCrawlers: string[];
  excludedCrawlerIds: string[];
  verifiedOnly: boolean;
  hideDashboardCard: boolean;
  groupBy: "crawlers" | "pages";
  pageFilterIds: string[];
  requireAuthToken: boolean;
}

export interface BotTokenStatus {
  websiteId: string;
  domain: string;
  hasToken: boolean;
  displayToken: string | null;
  createdAt: string | null;
  requireAuthToken: boolean;
  requestAuthToken?: string;
}

export interface Mention {
  id: string;
  websiteId: string;
  platform: "x" | "reddit";
  timestamp: string;
  text: string;
  url: string;
  author: { name: string | null; username: string | null; image: string | null };
  engagement: Record<string, number>;
  media?: unknown[];
  isRetweet?: boolean;
  subreddit?: string;
}

export interface GithubCommit {
  sha: string;
  repo: string;
  branch: string | null;
  message: string;
  author: { name: string | null; login: string | null; avatar: string | null };
  additions: number | null;
  deletions: number | null;
  url: string | null;
  timestamp: string;
}

export interface SearchConsoleRow {
  query?: string;
  page?: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  estimatedRevenue: number;
}

export interface AdCampaignRow {
  platform: "meta";
  accountId: string;
  campaignId: string;
  campaignName: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  visitors: number;
  revenue: number;
  payments: number;
  roas: number | null;
}

export interface XLinkRow {
  tweetId: string | null;
  tweetUrl: string | null;
  authorUsername: string | null;
  text: string | null;
  visitors: number;
  revenue: number;
  payments: number;
}

export interface ImportJob {
  id: string;
  websiteId: string;
  source: "plausible" | "datafast";
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  fileName: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  rowsTotal: number | null;
  rowsImported: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface GrowthIntegrationStatus {
  kind: "github" | "gsc" | "meta_ads" | "x";
  connected: boolean;
  status: "active" | "error" | "disconnected" | "pending" | null;
  settings: Record<string, unknown>;
  lastSyncedAt: string | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// MCP OAuth (W7)
// ---------------------------------------------------------------------------

export interface OAuthConnection {
  id: string;
  client: { id: string; name: string | null };
  scopes: string[];
  websiteIds: string[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

// ---------------------------------------------------------------------------
// Public share links (W2)
// ---------------------------------------------------------------------------

export interface SharedWebsite {
  domain: string;
  name: string | null;
  logo: string | null;
  timezone: string;
  currency: string;
  showRevenue: boolean;
}
