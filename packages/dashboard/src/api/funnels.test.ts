import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFunnel, deleteFunnel, getFunnels, updateFunnel } from './funnels';

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

describe('funnels admin api', () => {
  it('lists funnel definitions on the path-scoped admin route', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, {
        data: [
          {
            id: 'fun_1',
            name: 'Checkout',
            isActive: true,
            maxGapSeconds: 86400,
            steps: [{ type: 'page', path: '/pricing', name: 'View pricing' }],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
          },
        ],
        pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
      }),
    );

    const response = await getFunnels('site_1', { limit: 100, offset: 0, order: 'desc' });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe('/api/v1/admin/sites/site_1/funnels?limit=100&offset=0&order=desc');
    expect(url).not.toContain('siteId');
    expect(response.data[0].id).toBe('fun_1');
    expect(response.pagination?.total).toBe(1);
  });

  it('creates a funnel with a JSON body', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(201, {
        data: {
          id: 'fun_3',
          name: 'Trial',
          isActive: true,
          maxGapSeconds: null,
          steps: [
            { type: 'page', path: '/', name: 'Landing' },
            { type: 'goal', goal: 'signup', name: 'Signup' },
          ],
          createdAt: '2026-11-03T00:00:00Z',
          updatedAt: '2026-11-03T00:00:00Z',
        },
      }),
    );

    const definition = await createFunnel('site_1', {
      name: 'Trial',
      steps: [
        { type: 'page', path: '/', name: 'Landing' },
        { type: 'goal', goal: 'signup', name: 'Signup' },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/v1/admin/sites/site_1/funnels');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ name: 'Trial' });
    expect(definition.id).toBe('fun_3');
  });

  it('patches a funnel definition', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(200, {
        data: {
          id: 'fun_1',
          name: 'Checkout renamed',
          isActive: false,
          maxGapSeconds: 86400,
          steps: [{ type: 'page', path: '/pricing', name: 'View pricing' }],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-11-03T00:00:00Z',
        },
      }),
    );

    const definition = await updateFunnel('site_1', 'fun_1', { name: 'Checkout renamed' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/v1/admin/sites/site_1/funnels/fun_1');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(definition.name).toBe('Checkout renamed');
  });

  it('deletes a funnel definition', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(204, null));

    await deleteFunnel('site_1', 'fun_1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/v1/admin/sites/site_1/funnels/fun_1');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('encodes the site and funnel ids', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(204, null));

    await deleteFunnel('site/1', 'fun 1');

    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/admin/sites/site%2F1/funnels/fun%201');
  });
});
