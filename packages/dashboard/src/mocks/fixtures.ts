// Typed mock data for the frozen `/api/v1` contract. Values are examples, not
// real analytics. Fixtures are added per dashboard milestone; the mock router
// returns 404 for endpoints that have no fixture yet.
import type { Overview, SiteMetadata, TimeseriesPoint } from '../api/types.ts';

export const MOCK_PASSWORD = process.env.VITE_MOCK_PASSWORD ?? 'password';

export const MOCK_SESSION_TOKEN = 'mock-dg-session-token';

export const metadata: SiteMetadata = {
  siteId: 'site_1',
  domain: 'example.com',
  name: 'Example Site',
  timezone: 'UTC',
  currency: 'USD',
  kpi: 'revenue',
};

export const overviewBase: Overview = {
  visitors: 12840,
  sessions: 15320,
  pageviews: 41280,
  bounceRate: 0.42,
  avgSessionDuration: 184,
  currency: 'USD',
  revenue: 5310.5,
  payments: 42,
  revenuePerVisitor: 0.41,
  conversionRate: 0.0333,
};

export const overviewPrevious: Omit<Overview, 'previous'> = {
  visitors: 11920,
  sessions: 14110,
  pageviews: 38900,
  bounceRate: 0.45,
  avgSessionDuration: 171,
  currency: 'USD',
  revenue: 4720.0,
  payments: 38,
  revenuePerVisitor: 0.4,
  conversionRate: 0.0319,
};

export function timeseriesPoint(timestamp: string, seed: number): TimeseriesPoint {
  const visitors = 320 + ((seed * 37) % 180);
  const pageviews = visitors * (2 + (seed % 3));
  const sessions = Math.round(visitors * 0.85);
  const payments = Math.max(0, Math.round(visitors * 0.03));
  return {
    timestamp,
    visitors,
    pageviews,
    sessions,
    revenue: Number((payments * 126.4).toFixed(2)),
    payments,
  };
}
