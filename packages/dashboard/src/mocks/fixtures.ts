// Typed mock data for the frozen `/api/v1` contract. Values are examples, not
// real analytics. Fixtures are added per dashboard milestone; the mock router
// returns 404 for endpoints that have no fixture yet.
import type { BreakdownDimension } from '../api/breakdown.ts';
import type { BreakdownRow, Overview, Site, SiteMetadata, TimeseriesPoint } from '../api/types.ts';

export const MOCK_PASSWORD = process.env.VITE_MOCK_PASSWORD ?? 'password';

export const MOCK_SESSION_TOKEN = 'mock-dg-session-token';

export const sites: Site[] = [
  {
    id: 'site_1',
    name: 'Example Site',
    domain: 'example.com',
    timezone: 'UTC',
    currency: 'USD',
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'site_2',
    name: null,
    domain: 'acme.test',
    timezone: 'America/New_York',
    currency: 'EUR',
    createdAt: '2026-02-01T00:00:00Z',
  },
  {
    id: 'site_3',
    name: 'Blog',
    domain: 'blog.example.com',
    timezone: 'Europe/London',
    currency: 'GBP',
    createdAt: '2026-03-01T00:00:00Z',
  },
];

export const metadata: SiteMetadata = {
  siteId: 'site_1',
  domain: 'example.com',
  name: 'Example Site',
  timezone: 'UTC',
  currency: 'USD',
  kpi: 'revenue',
};

const BREAKDOWN_VALUES: Record<BreakdownDimension, string[]> = {
  pages: [
    '/',
    '/pricing',
    '/blog',
    '/blog/analytics-guide',
    '/blog/roadmap',
    '/features',
    '/docs',
    '/docs/getting-started',
    '/docs/api',
    '/signup',
    '/login',
    '/checkout',
    '/about',
    '/contact',
    '/integrations',
    '/changelog',
    '/customers',
    '/case-studies',
    '/case-studies/acme',
    '/legal/privacy',
    '/legal/terms',
    '/careers',
    '/press',
    '/status',
    '/security',
    '/api',
    '/roadmap',
    '/webinars',
    '/resources',
    '/templates',
  ],
  referrers: [
    'google.com',
    'news.ycombinator.com',
    'twitter.com',
    'linkedin.com',
    'producthunt.com',
    'reddit.com',
    'bing.com',
    'duckduckgo.com',
    'facebook.com',
    'youtube.com',
    'github.com',
    'medium.com',
    'substack.com',
    't.co',
    'slack.com',
    'discord.com',
    'mail.google.com',
    'news.google.com',
    'search.brave.com',
    'ecosia.org',
    'baidu.com',
    'yandex.ru',
    'instagram.com',
    'pinterest.com',
    'quora.com',
    'direct',
    'newsletter',
    'affiliate',
  ],
  campaigns: [
    'launch',
    'newsletter',
    'retargeting',
    'black-friday',
    'spring-sale',
    'webinar',
    'partner',
    'brand',
  ],
  countries: ['US', 'GB', 'DE', 'IN', 'CA', 'AU', 'FR', 'BR', 'JP', 'NL', 'SE', 'SG'],
  devices: ['desktop', 'mobile', 'tablet'],
  browsers: ['Chrome', 'Safari', 'Firefox', 'Edge', 'Opera', 'Samsung Internet', 'Brave'],
};

/** Deterministic rows so pagination and sorting are testable. */
export function breakdownRows(dimension: BreakdownDimension): BreakdownRow[] {
  return BREAKDOWN_VALUES[dimension].map((value, index) => {
    const visitors = 2400 - index * 73 + ((index * 37) % 53);
    const pageviews = visitors * (2 + (index % 3));
    const revenue = Number((visitors * (0.22 + ((index * 7) % 11) / 50)).toFixed(2));
    const payments = Math.max(1, Math.round(revenue / 126.4));
    const revenuePerVisitor = visitors === 0 ? 0 : Number((revenue / visitors).toFixed(2));
    return { value, visitors, pageviews, revenue, payments, revenuePerVisitor };
  });
}

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
