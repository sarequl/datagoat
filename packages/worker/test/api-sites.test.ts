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

async function login(): Promise<string> {
  const response = await call(
    apiRequest('/api/v1/session', { method: 'POST', body: { password: 'pw' } }),
  );
  expect(response.status).toBe(200);
  return sessionCookieFrom(response);
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetData();
});

describe('GET /api/v1/admin/sites', () => {
  it('requires a session', async () => {
    const response = await call(apiRequest('/api/v1/admin/sites'));
    expect(response.status).toBe(401);
  });

  it('lists sites owned by the session owner', async () => {
    const cookie = await login();
    const response = await call(apiRequest('/api/v1/admin/sites', { cookie }));
    expect(response.status).toBe(200);
    const body = await response.json<{
      data: Array<Record<string, unknown>>;
      pagination: { total: number; hasMore: boolean };
    }>();
    expect(body.pagination).toEqual({ limit: 100, offset: 0, total: 1, hasMore: false });
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: TEST_SITE.id,
      name: TEST_SITE.name,
      domain: TEST_SITE.domain,
      timezone: TEST_SITE.timezone,
      currency: TEST_SITE.currency,
    });
    expect(body.data[0].createdAt).toMatch(/Z$/);
  });

  it('rejects unknown query parameters', async () => {
    const cookie = await login();
    const response = await call(apiRequest('/api/v1/admin/sites?bogus=1', { cookie }));
    expect(response.status).toBe(400);
  });
});

describe('POST /api/v1/admin/sites', () => {
  it('creates a site with a generated token and default allowed hosts', async () => {
    const cookie = await login();
    const response = await call(
      apiRequest('/api/v1/admin/sites', {
        method: 'POST',
        cookie,
        body: { name: 'New Site', domain: 'new.example.com' },
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json<{ data: Record<string, unknown> }>();
    expect(body.data.id).toMatch(/^site_/);
    expect(body.data.siteToken).toMatch(/^[0-9a-f]{32}$/);
    expect(body.data).toMatchObject({
      name: 'New Site',
      domain: 'new.example.com',
      timezone: 'UTC',
      currency: 'USD',
    });

    const row = await env.DB.prepare(
      'SELECT site_token, allowed_hosts, owner_user_id FROM websites WHERE id = ?',
    )
      .bind(body.data.id as string)
      .first<{ site_token: string; allowed_hosts: string; owner_user_id: string }>();
    expect(row?.site_token).toBe(body.data.siteToken);
    expect(JSON.parse(row?.allowed_hosts ?? '[]')).toEqual(['new.example.com']);
    expect(row?.owner_user_id).toBeTruthy();
  });

  it('requires a domain', async () => {
    const cookie = await login();
    const response = await call(
      apiRequest('/api/v1/admin/sites', { method: 'POST', cookie, body: { name: 'No domain' } }),
    );
    expect(response.status).toBe(400);
  });

  it('rejects a duplicate domain with 409', async () => {
    const cookie = await login();
    const response = await call(
      apiRequest('/api/v1/admin/sites', {
        method: 'POST',
        cookie,
        body: { domain: TEST_SITE.domain },
      }),
    );
    expect(response.status).toBe(409);
  });
});

describe('GET/PATCH /api/v1/admin/sites/{siteId}', () => {
  it('returns one site with its token', async () => {
    const cookie = await login();
    const response = await call(apiRequest(`/api/v1/admin/sites/${TEST_SITE.id}`, { cookie }));
    expect(response.status).toBe(200);
    const body = await response.json<{ data: Record<string, unknown> }>();
    expect(body.data.id).toBe(TEST_SITE.id);
    expect(body.data.siteToken).toBe(TEST_SITE.site_token);
  });

  it('returns 404 for an unknown site', async () => {
    const cookie = await login();
    const response = await call(apiRequest('/api/v1/admin/sites/site_missing', { cookie }));
    expect(response.status).toBe(404);
  });

  it('patches the writable fields', async () => {
    const cookie = await login();
    const response = await call(
      apiRequest(`/api/v1/admin/sites/${TEST_SITE.id}`, {
        method: 'PATCH',
        cookie,
        body: { name: 'Renamed', timezone: 'Europe/London', currency: 'GBP' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ data: Record<string, unknown> }>();
    expect(body.data).toMatchObject({
      name: 'Renamed',
      timezone: 'Europe/London',
      currency: 'GBP',
    });
  });

  it('rejects an empty patch body', async () => {
    const cookie = await login();
    const response = await call(
      apiRequest(`/api/v1/admin/sites/${TEST_SITE.id}`, { method: 'PATCH', cookie, body: {} }),
    );
    expect(response.status).toBe(400);
  });
});
