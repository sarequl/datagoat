import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
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
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });
});
