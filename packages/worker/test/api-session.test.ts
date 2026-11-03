import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src';
import { apiRequest, applySchema, resetData, sessionCookieFrom, TEST_SITE } from './helpers';

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function ownerCount(): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetData();
});

describe('POST /api/v1/session', () => {
  it('creates the owner on first boot and sets the dg_session cookie', async () => {
    const response = await call(
      apiRequest('/api/v1/session', { method: 'POST', body: { password: 's3cret-password' } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { authenticated: true, scope: 'owner' } });

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('dg_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=43200');

    const user = await env.DB.prepare('SELECT * FROM users').first<{
      email: string;
      is_owner: number;
      password_hash: string;
    }>();
    expect(user?.email).toBe('owner@localhost');
    expect(user?.is_owner).toBe(1);
    expect(user?.password_hash).toMatch(/^pbkdf2-sha256\$210000\$/);

    // First boot inherits pre-existing sites so the owner sees them.
    const site = await env.DB.prepare('SELECT owner_user_id FROM websites WHERE id = ?')
      .bind(TEST_SITE.id)
      .first<{ owner_user_id: string }>();
    expect(site?.owner_user_id).toBeTruthy();
  });

  it('rejects a wrong password with 401', async () => {
    await call(
      apiRequest('/api/v1/session', { method: 'POST', body: { password: 'first-password' } }),
    );
    const response = await call(
      apiRequest('/api/v1/session', { method: 'POST', body: { password: 'wrong' } }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 401, message: 'Incorrect password' } });
  });

  it('rejects a malformed JSON body with 400', async () => {
    const response = await call(
      new Request('https://example.com/api/v1/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }) as unknown as Request,
    );
    expect(response.status).toBe(400);
  });

  it('does not create a second owner on later logins', async () => {
    await call(
      apiRequest('/api/v1/session', { method: 'POST', body: { password: 'first-password' } }),
    );
    const response = await call(
      apiRequest('/api/v1/session', { method: 'POST', body: { password: 'first-password' } }),
    );
    expect(response.status).toBe(200);
    expect(await ownerCount()).toBe(1);
  });

  it('rate-limits repeated failures per IP', async () => {
    await call(
      apiRequest('/api/v1/session', { method: 'POST', body: { password: 'first-password' } }),
    );
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await call(
        apiRequest('/api/v1/session', { method: 'POST', body: { password: 'wrong' } }),
      );
      expect(response.status).toBe(401);
    }
    const blocked = await call(
      apiRequest('/api/v1/session', { method: 'POST', body: { password: 'first-password' } }),
    );
    expect(blocked.status).toBe(429);
  });
});

describe('GET /api/v1/session', () => {
  it('returns 401 without a credential', async () => {
    const response = await call(apiRequest('/api/v1/session'));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 401, message: 'Unauthenticated' } });
  });

  it('accepts the dg_session cookie', async () => {
    const login = await call(
      apiRequest('/api/v1/session', { method: 'POST', body: { password: 'pw' } }),
    );
    const cookie = sessionCookieFrom(login);
    expect(cookie).toBeTruthy();

    const response = await call(apiRequest('/api/v1/session', { cookie }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { authenticated: true, scope: 'owner' } });
  });

  it('accepts Authorization: Bearer with the session JWT', async () => {
    const login = await call(
      apiRequest('/api/v1/session', { method: 'POST', body: { password: 'pw' } }),
    );
    const cookie = sessionCookieFrom(login);
    const token = cookie.slice('dg_session='.length);

    const response = await call(apiRequest('/api/v1/session', { token }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { authenticated: true, scope: 'owner' } });
  });

  it('rejects a forged token', async () => {
    const response = await call(apiRequest('/api/v1/session', { token: 'not-a-jwt' }));
    expect(response.status).toBe(401);
  });
});

describe('POST /api/v1/session/logout', () => {
  it('clears the session cookie', async () => {
    const response = await call(apiRequest('/api/v1/session/logout', { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { authenticated: false } });
    expect(response.headers.get('set-cookie')).toContain('dg_session=;');
  });
});
