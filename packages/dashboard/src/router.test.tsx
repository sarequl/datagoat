import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRouter } from './router';

// jsdom has no canvas 2d context; this test is about routing, not chart drawing.
vi.mock('./components/charts/TimeseriesChart', () => ({
  TimeseriesChart: () => <div data-testid="timeseries-chart" />,
}));

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppRouter />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('AppRouter', () => {
  it('redirects an unauthenticated visitor from / to /login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: { code: 401, message: 'Unauthenticated' } })),
    );

    renderApp();

    expect(await screen.findByRole('heading', { name: 'Sign in to DataGoat' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
  });

  it('shows the app shell to an authenticated visitor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { data: { authenticated: true, scope: 'owner' } })),
    );

    renderApp();

    expect(await screen.findByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('waits for the site list before firing site-scoped calls', async () => {
    const calls: string[] = [];
    let releaseSites: ((response: Response) => void) | undefined;
    const sitesGate = new Promise<Response>((resolve) => {
      releaseSites = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.startsWith('/api/v1/admin/sites')) {
          return sitesGate;
        }
        return jsonResponse(200, { data: { authenticated: true, scope: 'owner' } });
      }),
    );

    renderApp();

    await waitFor(() =>
      expect(calls.some((url) => url.startsWith('/api/v1/admin/sites'))).toBe(true),
    );
    await Promise.resolve();
    expect(calls.some((url) => url.includes('/analytics/'))).toBe(false);

    releaseSites?.(
      jsonResponse(200, {
        data: [
          {
            id: 'site_1',
            name: 'Example Site',
            domain: 'example.com',
            timezone: 'UTC',
            currency: 'USD',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(calls.some((url) => url.includes('/analytics/'))).toBe(true);
  });
});
