import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from './RequireAuth';
import { SessionProvider } from './SessionContext';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <Routes>
          <Route path="/login" element={<div>Login page</div>} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <div>Protected content</div>
              </RequireAuth>
            }
          />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RequireAuth', () => {
  it('redirects to /login when unauthenticated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(401, { error: { code: 401, message: 'Unauthenticated' } })),
    );

    renderAt('/');

    expect(await screen.findByText('Login page')).toBeInTheDocument();
  });

  it('renders children when authenticated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { data: { authenticated: true, scope: 'owner' } })),
    );

    renderAt('/');

    expect(await screen.findByText('Protected content')).toBeInTheDocument();
  });

  it('shows a retry state when the session check fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(500, { error: { code: 500, message: 'Boom' } })),
    );

    renderAt('/');

    expect(await screen.findByText('Cannot reach the server')).toBeInTheDocument();
  });
});
