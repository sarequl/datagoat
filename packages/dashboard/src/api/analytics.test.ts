import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMetadata, getOverview, getTimeseries } from './analytics';

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

describe('analytics api', () => {
  it('fetches metadata', async () => {
    stubFetch(async () =>
      jsonResponse(200, {
        data: {
          siteId: 'site_1',
          domain: 'example.com',
          name: 'Example',
          timezone: 'UTC',
          currency: 'USD',
          kpi: null,
        },
      }),
    );

    const metadata = await getMetadata();
    expect(metadata.timezone).toBe('UTC');
  });

  it('requests the previous block only when compare is true', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { data: {} }));

    await getOverview({ startAt: '2026-01-01', endAt: '2026-01-07', compare: true });
    expect(String(fetchMock.mock.calls[0][0])).toContain('compare=previous');

    await getOverview({ startAt: '2026-01-01', endAt: '2026-01-07', compare: false });
    expect(String(fetchMock.mock.calls[1][0])).not.toContain('compare=previous');
  });

  it('joins timeseries fields and passes the interval', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { data: {} }));

    await getTimeseries({ fields: ['visitors', 'revenue'], interval: 'day' });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('fields=visitors%2Crevenue');
    expect(url).toContain('interval=day');
  });
});
