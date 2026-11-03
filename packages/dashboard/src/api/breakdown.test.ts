import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBreakdown } from './breakdown';

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

describe('breakdown api', () => {
  it('requests the dimension with range, site, and pagination params', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, {
        data: [],
        pagination: { limit: 25, offset: 50, total: 100, hasMore: true },
      }),
    );

    await getBreakdown('pages', {
      siteId: 'site_1',
      startAt: '2026-01-01',
      endAt: '2026-01-07',
      timezone: 'UTC',
      path: '/blog',
      limit: 25,
      offset: 50,
      order: 'asc',
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/analytics/pages?');
    expect(url).toContain('siteId=site_1');
    expect(url).toContain('path=%2Fblog');
    expect(url).toContain('limit=25');
    expect(url).toContain('offset=50');
    expect(url).toContain('order=asc');
  });

  it('omits undefined params', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { data: [] }));

    await getBreakdown('referrers');

    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/analytics/referrers');
  });
});
