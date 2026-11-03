import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRouter } from './router';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
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

    render(<AppRouter />);

    expect(await screen.findByRole('heading', { name: 'Sign in to DataGoat' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
  });

  it('shows the app shell to an authenticated visitor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { data: { authenticated: true, scope: 'owner' } })),
    );

    render(<AppRouter />);

    expect(await screen.findByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });
});
