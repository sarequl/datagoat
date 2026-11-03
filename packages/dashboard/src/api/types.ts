// Types for the frozen `/api/v1` contract in design/api.md. The dashboard
// reads these shapes; it never invents fields the contract does not define.

export interface Pagination {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
}

export interface ApiErrorBody {
  error: {
    code: number;
    message: string;
    details?: unknown[];
  };
}

export interface SessionWhoami {
  authenticated: boolean;
  scope: string;
}

export interface Site {
  id: string;
  name: string | null;
  domain: string;
  timezone: string;
  currency: string;
  createdAt: string;
}

export interface SiteMetadata {
  siteId: string;
  domain: string;
  name: string;
  timezone: string;
  currency: string;
  /** The site's #1 KPI; `null` when unset. */
  kpi: string | null;
}

export interface OverviewMetrics {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounceRate: number;
  avgSessionDuration: number;
  currency: string;
  revenue: number;
  payments: number;
  revenuePerVisitor: number;
  conversionRate: number;
}

export interface Overview extends OverviewMetrics {
  /** Present when the request used `compare=previous` (api.md §2.7.1). */
  previous?: OverviewMetrics;
}

export interface BreakdownRow {
  value: string;
  visitors: number;
  pageviews: number;
  revenue: number;
  payments: number;
  revenuePerVisitor: number;
  conversionRate?: number;
}

// `api.md` §2.7.7: goals carry `completions` and no `conversionRate`.
export interface GoalRow extends Omit<BreakdownRow, 'conversionRate'> {
  completions: number;
}

export interface ExitClickRow extends BreakdownRow {
  clicks: number;
}

// `api.md` §2.7.2 pins this shape. Each point carries only the requested
// metrics; requesting `revenue` also returns `payments`. `sessions` is omitted
// unless it was requested.
export interface TimeseriesPoint {
  timestamp: string;
  visitors: number;
  pageviews: number;
  sessions?: number;
  revenue: number;
  payments: number;
}

export interface Timeseries {
  interval: 'hour' | 'day' | 'week' | 'month';
  fields: string[];
  timezone: string;
  currency: string;
  points: TimeseriesPoint[];
}

export interface FunnelStepResult {
  step: number;
  name: string;
  visitors: number;
  conversionRate: number;
  dropoffRate: number;
  revenue: number;
  payments: number;
}

// `api.md` §2.7.3 pins this shape.
export interface FunnelResult {
  id: string;
  name: string;
  steps: FunnelStepResult[];
  totalVisitors: number;
  totalConversionRate: number;
  revenue: number;
  payments: number;
  revenuePerVisitor: number;
  timezone: string;
  startAt: string | null;
  endAt: string | null;
  lastUpdated: string;
}

// `api.md` §2.7.4 pins this shape. `online` is the active-visitor count.
export interface Realtime {
  online: number;
  windowMinutes: number;
  timestamp: string;
}

// `api.md` §2.7.5 pins this shape.
export interface RealtimePayment {
  visitorId: string;
  amount: number;
  currency: string;
  at: string;
  isRenewal: boolean;
}

export interface RealtimeVisitor {
  visitorId: string;
  page: string | null;
  referrer: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  device: 'desktop' | 'mobile' | 'tablet';
  browser: string;
  os: string;
  sessionStartTime: string;
  lastSeenAt: string;
  visitCount: number;
  isCustomer: boolean;
}

export interface RealtimeMap {
  count: number;
  windowMinutes: number;
  timestamp: string;
  visitors: RealtimeVisitor[];
  recentPayments: RealtimePayment[];
}

export type BreakdownDimension =
  | 'pages'
  | 'referrers'
  | 'campaigns'
  | 'countries'
  | 'regions'
  | 'cities'
  | 'browsers'
  | 'devices'
  | 'operating-systems'
  | 'hostnames'
  | 'goals';
