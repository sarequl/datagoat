import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './client';

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

describe('apiFetch', () => {
  it('unwraps the success envelope and keeps pagination', async () => {
    stubFetch(async () =>
      jsonResponse(200, {
        data: { visitors: 7 },
        pagination: { limit: 1, offset: 0, total: 1, hasMore: false },
      }),
    );

    const response = await apiFetch<{ visitors: number }>('/analytics/overview');

    expect(response.data.visitors).toBe(7);
    expect(response.pagination?.total).toBe(1);
  });

  it('sends same-origin credentials for the cookie session', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { data: {} }));

    await apiFetch('/session');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/session',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('throws ApiError with the envelope status and message', async () => {
    stubFetch(async () => jsonResponse(401, { error: { code: 401, message: 'Unauthenticated' } }));

    const error = await apiFetch('/session').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 401, message: 'Unauthenticated' });
  });

  it('sets the JSON content type when a body is sent', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { data: {} }));

    await apiFetch('/session', { method: 'POST', body: JSON.stringify({ password: 'x' }) });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
  });
});
