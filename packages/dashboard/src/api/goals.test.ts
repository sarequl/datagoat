import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGoals } from './goals';

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

describe('goals api', () => {
  it('requests the goals endpoint with range, pagination, and order', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, {
        data: [],
        pagination: { limit: 25, offset: 25, total: 0, hasMore: false },
      }),
    );

    await getGoals({
      siteId: 'site_1',
      startAt: '2026-11-01',
      endAt: '2026-11-03',
      timezone: 'UTC',
      limit: 25,
      offset: 25,
      order: 'asc',
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/analytics/goals?');
    expect(url).toContain('siteId=site_1');
    expect(url).toContain('startAt=2026-11-01');
    expect(url).toContain('endAt=2026-11-03');
    expect(url).toContain('limit=25');
    expect(url).toContain('offset=25');
    expect(url).toContain('order=asc');
  });

  it('returns goal rows and pagination', async () => {
    stubFetch(async () =>
      jsonResponse(200, {
        data: [
          {
            value: 'signup',
            completions: 482,
            visitors: 391,
            pageviews: 0,
            revenue: 0,
            payments: 0,
            revenuePerVisitor: 0,
          },
        ],
        pagination: { limit: 25, offset: 0, total: 1, hasMore: false },
      }),
    );

    const response = await getGoals();
    expect(response.data[0].value).toBe('signup');
    expect(response.data[0].completions).toBe(482);
    expect(response.pagination?.total).toBe(1);
  });
});
