import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFunnel } from './funnel';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function stubFetch(handler: (...args: unknown[]) => Promise<Response>) {
  const mock = vi.fn(handler);
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('funnel api', () => {
  it('requests the funnel results endpoint with range params', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, {
        data: {
          id: 'fun_1',
          name: 'Checkout',
          steps: [],
          totalVisitors: 0,
          totalConversionRate: 0,
          revenue: 0,
          payments: 0,
          revenuePerVisitor: 0,
          timezone: 'UTC',
          startAt: null,
          endAt: null,
          lastUpdated: '2026-11-03T08:00:00Z',
        },
      }),
    );

    await getFunnel('fun_1', {
      siteId: 'site_1',
      startAt: '2026-11-01',
      endAt: '2026-11-03',
      timezone: 'UTC',
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/analytics/funnel/fun_1?');
    expect(url).toContain('siteId=site_1');
    expect(url).toContain('startAt=2026-11-01');
    expect(url).toContain('endAt=2026-11-03');
  });

  it('returns the funnel result', async () => {
    stubFetch(async () =>
      jsonResponse(200, {
        data: {
          id: 'fun_1',
          name: 'Checkout',
          steps: [
            {
              step: 1,
              name: 'View pricing',
              visitors: 1204,
              conversionRate: 1,
              dropoffRate: 0,
              revenue: 0,
              payments: 0,
            },
          ],
          totalVisitors: 1204,
          totalConversionRate: 1,
          revenue: 0,
          payments: 0,
          revenuePerVisitor: 0,
          timezone: 'UTC',
          startAt: '2026-11-01',
          endAt: '2026-11-03',
          lastUpdated: '2026-11-03T08:00:00Z',
        },
      }),
    );

    const result = await getFunnel('fun_1');
    expect(result.name).toBe('Checkout');
    expect(result.steps[0].visitors).toBe(1204);
  });
});
