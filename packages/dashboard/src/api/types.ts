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
  name: string;
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
  kpis: string[];
}

export interface OverviewMetrics {
  visitors: number;
  sessions: number;
  pageviews: number;
  bounceRate: number;
  avgSessionDuration: number;
  revenue: number;
  payments: number;
  revenuePerVisitor: number;
  conversionRate: number;
}

export interface Overview extends OverviewMetrics {
  // Mirrors the same fields for the immediately preceding equal-length range
  // in the site timezone (api.md §2.1). Optional until the Worker ships it.
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

export type GoalRow = BreakdownRow;

// `api.md` specifies the timeseries query params but not the response shape.
// This is the mock's assumed shape and is flagged for API Engineer review.
export interface TimeseriesPoint {
  timestamp: string;
  visitors: number;
  pageviews: number;
  sessions: number;
  revenue: number;
  payments: number;
}

export interface Timeseries {
  interval: 'hour' | 'day' | 'week' | 'month';
  fields: string[];
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

// `api.md` §2.1/§2.6 describe funnel semantics but not the JSON shape; this is
// the mock's assumed shape and is flagged for API Engineer review.
export interface FunnelResult {
  id: string;
  name: string;
  steps: FunnelStepResult[];
  totalConversionRate: number;
  revenue: number;
  payments: number;
}

export interface Realtime {
  visitors: number;
  timestamp: string;
}

export interface RealtimePayment {
  amount: number;
  currency: string;
  at: string;
}

export interface RealtimeVisitor {
  visitorId: string;
  page: string;
  referrer: string | null;
  country: string | null;
  device: 'desktop' | 'mobile' | 'tablet';
  lastSeenAt: string;
  payments: RealtimePayment[];
}

export interface RealtimeMap {
  visitors: RealtimeVisitor[];
  timestamp: string;
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
