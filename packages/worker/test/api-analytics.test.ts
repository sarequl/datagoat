import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src';
import {
  apiRequest,
  applySchema,
  insertEvent,
  insertPayment,
  resetData,
  sessionCookieFrom,
  TEST_SITE,
} from './helpers';

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function login(): Promise<string> {
  const response = await call(
    apiRequest('/api/v1/session', { method: 'POST', body: { password: 'pw' } }),
  );
  expect(response.status).toBe(200);
  return sessionCookieFrom(response);
}

const T0 = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
const RANGE = 'startAt=2026-01-01&endAt=2026-01-31';

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetData();
});

describe('GET /api/v1/analytics/overview', () => {
  it('requires siteId', async () => {
    const cookie = await login();
    const response = await call(apiRequest('/api/v1/analytics/overview', { cookie }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 400, message: 'siteId is required' } });
  });

  it('returns 404 for a site the owner cannot access', async () => {
    const cookie = await login();
    const response = await call(
      apiRequest('/api/v1/analytics/overview?siteId=site_missing', { cookie }),
    );
    expect(response.status).toBe(404);
  });

  it('returns the pinned overview shape', async () => {
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      path: '/',
      ts: T0,
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      path: '/pricing',
      ts: T0 + 30,
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v2',
      session_id: 's2',
      path: '/blog',
      ts: T0 + 60,
    });

    const cookie = await login();
    const response = await call(
      apiRequest(`/api/v1/analytics/overview?siteId=${TEST_SITE.id}&${RANGE}`, { cookie }),
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ data: Record<string, unknown> }>();
    expect(body.data).toEqual({
      visitors: 2,
      sessions: 2,
      pageviews: 3,
      bounceRate: 0.5,
      avgSessionDuration: 15,
      currency: 'USD',
      revenue: 0,
      payments: 0,
      revenuePerVisitor: 0,
      conversionRate: 0,
    });
    expect(body.data.previous).toBeUndefined();
  });

  it('adds a previous block for compare=previous', async () => {
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      path: '/',
      ts: T0,
    });
    const cookie = await login();
    const response = await call(
      apiRequest(`/api/v1/analytics/overview?siteId=${TEST_SITE.id}&${RANGE}&compare=previous`, {
        cookie,
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ data: { previous: Record<string, unknown> } }>();
    expect(body.data.previous).toBeDefined();
    expect(body.data.previous).toMatchObject({
      visitors: 0,
      sessions: 0,
      pageviews: 0,
      currency: 'USD',
    });
  });

  it('includes attributed revenue and conversion', async () => {
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      path: '/',
      ts: T0,
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v2',
      session_id: 's2',
      path: '/',
      ts: T0 + 10,
    });
    await insertPayment({
      websiteId: TEST_SITE.id,
      visitorId: 'v1',
      amountCents: 5000,
      occurredAt: T0 + 20,
    });

    const cookie = await login();
    const response = await call(
      apiRequest(`/api/v1/analytics/overview?siteId=${TEST_SITE.id}&${RANGE}`, { cookie }),
    );
    const body = await response.json<{ data: Record<string, unknown> }>();
    expect(body.data).toMatchObject({
      visitors: 2,
      revenue: 50,
      payments: 1,
      revenuePerVisitor: 25,
      conversionRate: 0.5,
    });
  });
});

describe('GET /api/v1/analytics/timeseries', () => {
  it('requires an interval', async () => {
    const cookie = await login();
    const response = await call(
      apiRequest(`/api/v1/analytics/timeseries?siteId=${TEST_SITE.id}`, { cookie }),
    );
    expect(response.status).toBe(400);
  });

  it('buckets by day and zero-fills empty days', async () => {
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      path: '/',
      ts: T0,
    });
    const cookie = await login();
    const response = await call(
      apiRequest(
        `/api/v1/analytics/timeseries?siteId=${TEST_SITE.id}&startAt=2026-01-15&endAt=2026-01-16&interval=day`,
        { cookie },
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      data: {
        interval: string;
        fields: string[];
        timezone: string;
        currency: string;
        points: Array<Record<string, unknown>>;
      };
    }>();
    expect(body.data.interval).toBe('day');
    expect(body.data.fields).toEqual(['visitors', 'pageviews', 'sessions', 'revenue', 'payments']);
    expect(body.data.timezone).toBe('UTC');
    expect(body.data.points).toHaveLength(2);
    expect(body.data.points[0]).toMatchObject({
      timestamp: '2026-01-15T00:00:00.000Z',
      visitors: 1,
      pageviews: 1,
      sessions: 1,
      revenue: 0,
      payments: 0,
    });
    expect(body.data.points[1]).toMatchObject({
      timestamp: '2026-01-16T00:00:00.000Z',
      visitors: 0,
    });
  });

  it('honours the fields selection and adds payments with revenue', async () => {
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      path: '/',
      ts: T0,
    });
    const cookie = await login();
    const response = await call(
      apiRequest(
        `/api/v1/analytics/timeseries?siteId=${TEST_SITE.id}&startAt=2026-01-15&endAt=2026-01-15&interval=day&fields=revenue`,
        { cookie },
      ),
    );
    const body = await response.json<{
      data: { fields: string[]; points: Array<Record<string, unknown>> };
    }>();
    expect(body.data.fields).toEqual(['revenue', 'payments']);
    expect(body.data.points[0]).toEqual({
      timestamp: '2026-01-15T00:00:00.000Z',
      revenue: 0,
      payments: 0,
    });
  });

  it('rejects an unknown metric', async () => {
    const cookie = await login();
    const response = await call(
      apiRequest(
        `/api/v1/analytics/timeseries?siteId=${TEST_SITE.id}&startAt=2026-01-15&endAt=2026-01-15&interval=day&fields=bogus`,
        { cookie },
      ),
    );
    expect(response.status).toBe(400);
  });
});

describe('GET /api/v1/analytics/metadata', () => {
  it('returns the pinned metadata shape', async () => {
    const cookie = await login();
    const response = await call(
      apiRequest(`/api/v1/analytics/metadata?siteId=${TEST_SITE.id}`, { cookie }),
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ data: Record<string, unknown> }>();
    expect(body.data).toEqual({
      siteId: TEST_SITE.id,
      domain: TEST_SITE.domain,
      name: TEST_SITE.name,
      timezone: TEST_SITE.timezone,
      currency: TEST_SITE.currency,
      kpi: null,
    });
  });
});

describe('analytics breakdowns', () => {
  beforeEach(async () => {
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      path: '/pricing',
      referrer: 'https://google.com/search',
      utm_campaign: 'launch',
      country: 'US',
      device_type: 'desktop',
      os: 'Mac OS',
      browser: 'Chrome',
      hostname: 'example.com',
      ts: T0,
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v2',
      session_id: 's2',
      path: '/pricing',
      referrer: 'https://news.ycombinator.com/',
      country: 'GB',
      device_type: 'mobile',
      os: 'iOS',
      browser: 'Safari',
      hostname: 'www.example.com',
      ts: T0 + 10,
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v3',
      session_id: 's3',
      path: '/blog',
      ts: T0 + 20,
    });
  });

  it('groups pages by visitors and pageviews', async () => {
    const cookie = await login();
    const response = await call(
      apiRequest(`/api/v1/analytics/pages?siteId=${TEST_SITE.id}&${RANGE}`, { cookie }),
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      data: Array<Record<string, unknown>>;
      pagination: { total: number };
    }>();
    expect(body.pagination.total).toBe(2);
    expect(body.data[0]).toMatchObject({ value: '/pricing', visitors: 2, pageviews: 2 });
    expect(body.data[0].revenue).toBe(0);
    expect(body.data[0].payments).toBe(0);
    expect(body.data[0].revenuePerVisitor).toBe(0);
    expect(body.data[1]).toMatchObject({ value: '/blog', visitors: 1, pageviews: 1 });
  });

  it('groups referrers by host', async () => {
    const cookie = await login();
    const response = await call(
      apiRequest(`/api/v1/analytics/referrers?siteId=${TEST_SITE.id}&${RANGE}`, { cookie }),
    );
    const body = await response.json<{ data: Array<Record<string, unknown>> }>();
    const values = body.data.map((row) => row.value);
    expect(values).toContain('google.com');
    expect(values).toContain('news.ycombinator.com');
    expect(values).toContain('(unknown)');
  });

  it('groups campaigns, countries, devices and hostnames', async () => {
    const cookie = await login();
    const campaign = await call(
      apiRequest(`/api/v1/analytics/campaigns?siteId=${TEST_SITE.id}&${RANGE}`, { cookie }),
    );
    const campaignBody = await campaign.json<{ data: Array<Record<string, unknown>> }>();
    expect(campaignBody.data[0]).toMatchObject({ value: '(unknown)', visitors: 2 });

    const country = await call(
      apiRequest(`/api/v1/analytics/countries?siteId=${TEST_SITE.id}&${RANGE}`, { cookie }),
    );
    const countryBody = await country.json<{ data: Array<Record<string, unknown>> }>();
    expect(countryBody.data.map((row) => row.value).sort()).toEqual(['(unknown)', 'GB', 'US']);

    const device = await call(
      apiRequest(`/api/v1/analytics/devices?siteId=${TEST_SITE.id}&${RANGE}`, { cookie }),
    );
    const deviceBody = await device.json<{ data: Array<Record<string, unknown>> }>();
    expect(deviceBody.data.map((row) => row.value).sort()).toEqual([
      '(unknown)',
      'desktop',
      'mobile',
    ]);

    const hostname = await call(
      apiRequest(`/api/v1/analytics/hostnames?siteId=${TEST_SITE.id}&${RANGE}`, { cookie }),
    );
    const hostnameBody = await hostname.json<{ data: Array<Record<string, unknown>> }>();
    expect(hostnameBody.data.map((row) => row.value).sort()).toEqual([
      '(unknown)',
      'example.com',
      'www.example.com',
    ]);
  });

  it('adds conversionRate when a goal filter is present', async () => {
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      name: 'signup',
      ts: T0 + 5,
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v2',
      session_id: 's2',
      name: 'signup',
      ts: T0 + 15,
    });
    const cookie = await login();
    const response = await call(
      apiRequest(`/api/v1/analytics/pages?siteId=${TEST_SITE.id}&${RANGE}&goal=signup`, { cookie }),
    );
    const body = await response.json<{ data: Array<Record<string, unknown>> }>();
    expect(body.data[0]).toMatchObject({ value: '/pricing', visitors: 2, conversionRate: 1 });
    expect(body.data[1]).toMatchObject({ value: '/blog', visitors: 1, conversionRate: 0 });
  });
});

describe('GET /api/v1/analytics/goals', () => {
  it('counts completions and unique visitors per goal', async () => {
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      name: 'signup',
      ts: T0,
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v2',
      session_id: 's2',
      name: 'signup',
      ts: T0 + 5,
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      name: 'signup',
      ts: T0 + 6,
    });
    const cookie = await login();
    const response = await call(
      apiRequest(`/api/v1/analytics/goals?siteId=${TEST_SITE.id}&${RANGE}`, { cookie }),
    );
    const body = await response.json<{ data: Array<Record<string, unknown>> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({
      value: 'signup',
      completions: 3,
      visitors: 2,
      pageviews: 0,
      revenue: 0,
      payments: 0,
      revenuePerVisitor: 0,
    });
  });
});

describe('GET /api/v1/analytics/exit-clicks', () => {
  it('groups external destinations by unique visitors and clicks', async () => {
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      name: 'exit_click',
      path: '/',
      props: { url: 'https://external.example.com/a' },
      ts: T0,
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v2',
      session_id: 's2',
      name: 'exit_click',
      path: '/',
      props: { url: 'https://external.example.com/a' },
      ts: T0 + 5,
    });
    const cookie = await login();
    const response = await call(
      apiRequest(`/api/v1/analytics/exit-clicks?siteId=${TEST_SITE.id}&${RANGE}`, { cookie }),
    );
    const body = await response.json<{ data: Array<Record<string, unknown>> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      value: 'https://external.example.com/a',
      visitors: 2,
      clicks: 2,
      pageviews: 0,
    });
  });
});
