import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, useSession } from './SessionContext';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function Probe() {
  const { status, scope, login, logout } = useSession();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="scope">{scope ?? ''}</span>
      <button type="button" onClick={() => login('password')}>
        login
      </button>
      <button type="button" onClick={() => logout()}>
        logout
      </button>
    </div>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SessionProvider', () => {
  it('starts unauthenticated when whoami returns 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: { code: 401, message: 'Unauthenticated' } })),
    );

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
  });

  it('reports a server error separately from an expired session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(500, { error: { code: 500, message: 'Boom' } })),
    );

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
  });

  it('logs in and stores the owner scope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) =>
        (init?.method ?? 'GET') === 'POST'
          ? jsonResponse(200, { data: { authenticated: true, scope: 'owner' } })
          : jsonResponse(401, { error: { code: 401, message: 'Unauthenticated' } }),
      ),
    );

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    await userEvent.click(screen.getByRole('button', { name: 'login' }));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('scope')).toHaveTextContent('owner');
  });

  it('logs out and clears the scope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) =>
        (init?.method ?? 'GET') === 'POST'
          ? jsonResponse(200, { data: { authenticated: false } })
          : jsonResponse(200, { data: { authenticated: true, scope: 'owner' } }),
      ),
    );

    render(
      <SessionProvider>
        <Probe />
      </SessionProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(screen.getByTestId('scope')).toHaveTextContent('');
  });
});
