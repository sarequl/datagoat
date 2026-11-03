import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src';
import {
  apiRequest,
  applySchema,
  insertEvent,
  insertPayment,
  resetData,
  sessionCookieFrom,
  TEST_SITE,
} from './helpers';

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

const T0 = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
const RANGE = 'startAt=2026-01-01&endAt=2026-01-31';

interface Step {
  type: string;
  name?: string;
  [key: string]: unknown;
}

async function createFunnel(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return call(
    apiRequest(`/api/v1/admin/sites/${TEST_SITE.id}/funnels`, {
      method: 'POST',
      cookie,
      body,
    }),
  );
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetData();
});

describe('funnel definition CRUD', () => {
  it('creates a funnel with embedded steps', async () => {
    const cookie = await login();
    const response = await createFunnel(cookie, {
      name: 'Checkout',
      isActive: true,
      maxGapSeconds: 86400,
      steps: [
        { type: 'page', path: '/pricing', name: 'View pricing' },
        { type: 'goal', goal: 'payment', name: 'Payment' },
      ],
    });
    expect(response.status).toBe(201);
    const body = await response.json<{ data: Record<string, unknown> }>();
    expect(body.data.id).toMatch(/^fun_/);
    expect(body.data).toMatchObject({
      name: 'Checkout',
      isActive: true,
      maxGapSeconds: 86400,
      steps: [
        { type: 'page', path: '/pricing', name: 'View pricing' },
        { type: 'goal', goal: 'payment', name: 'Payment' },
      ],
    });
    expect(body.data.createdAt).toMatch(/Z$/);
    expect(body.data.updatedAt).toMatch(/Z$/);
  });

  it('derives a step name when omitted', async () => {
    const cookie = await login();
    const response = await createFunnel(cookie, {
      name: 'Named steps',
      steps: [
        { type: 'page', path: '/pricing' },
        { type: 'goal', goal: 'payment' },
      ],
    });
    const body = await response.json<{ data: { steps: Step[] } }>();
    expect(body.data.steps[0].name).toBe('Page /pricing');
  });

  it('rejects a duplicate name with 409', async () => {
    const cookie = await login();
    const body = {
      name: 'Checkout',
      steps: [
        { type: 'page', path: '/a' },
        { type: 'page', path: '/b' },
      ],
    };
    expect((await createFunnel(cookie, body)).status).toBe(201);
    expect((await createFunnel(cookie, body)).status).toBe(409);
  });

  it('requires a name and steps', async () => {
    const cookie = await login();
    const missingName = await createFunnel(cookie, {
      steps: [
        { type: 'page', path: '/a' },
        { type: 'page', path: '/b' },
      ],
    });
    expect(missingName.status).toBe(400);

    const missingSteps = await createFunnel(cookie, { name: 'No steps' });
    expect(missingSteps.status).toBe(400);
  });

  it('rejects unknown predicates and disallowed params', async () => {
    const cookie = await login();
    const unknown = await createFunnel(cookie, {
      name: 'Unknown',
      steps: [
        { type: 'bogus', path: '/a' },
        { type: 'page', path: '/b' },
      ],
    });
    expect(unknown.status).toBe(400);

    const disallowed = await createFunnel(cookie, {
      name: 'Disallowed',
      steps: [
        { type: 'page', path: '/a', goal: 'payment' },
        { type: 'page', path: '/b' },
      ],
    });
    expect(disallowed.status).toBe(400);
  });

  it('rejects a step count outside 2-8', async () => {
    const cookie = await login();
    const oneStep = await createFunnel(cookie, {
      name: 'One step',
      steps: [{ type: 'page', path: '/a' }],
    });
    expect(oneStep.status).toBe(400);

    const nineSteps = await createFunnel(cookie, {
      name: 'Nine steps',
      steps: Array.from({ length: 9 }, (_, index) => ({ type: 'page', path: `/p${index}` })),
    });
    expect(nineSteps.status).toBe(400);
  });

  it('lists funnels with pagination and order', async () => {
    const cookie = await login();
    await createFunnel(cookie, {
      name: 'First',
      steps: [
        { type: 'page', path: '/a' },
        { type: 'page', path: '/b' },
      ],
    });
    await createFunnel(cookie, {
      name: 'Second',
      steps: [
        { type: 'page', path: '/c' },
        { type: 'page', path: '/d' },
      ],
    });

    const response = await call(
      apiRequest(`/api/v1/admin/sites/${TEST_SITE.id}/funnels?limit=1&offset=0`, { cookie }),
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      data: Array<Record<string, unknown>>;
      pagination: { limit: number; offset: number; total: number; hasMore: boolean };
    }>();
    expect(body.pagination).toEqual({ limit: 1, offset: 0, total: 2, hasMore: true });
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Second');
    expect(body.data[0].steps).toHaveLength(2);
  });

  it('patches fields and replaces steps', async () => {
    const cookie = await login();
    const created = await createFunnel(cookie, {
      name: 'Checkout',
      steps: [
        { type: 'page', path: '/a' },
        { type: 'page', path: '/b' },
      ],
    });
    const createdBody = await created.json<{ data: { id: string } }>();

    const response = await call(
      apiRequest(`/api/v1/admin/sites/${TEST_SITE.id}/funnels/${createdBody.data.id}`, {
        method: 'PATCH',
        cookie,
        body: {
          name: 'Checkout v2',
          isActive: false,
          maxGapSeconds: null,
          steps: [
            { type: 'page', path: '/pricing' },
            { type: 'goal', goal: 'payment' },
          ],
        },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ data: Record<string, unknown> }>();
    expect(body.data).toMatchObject({
      name: 'Checkout v2',
      isActive: false,
      maxGapSeconds: null,
      steps: [
        { type: 'page', path: '/pricing' },
        { type: 'goal', goal: 'payment' },
      ],
    });

    const empty = await call(
      apiRequest(`/api/v1/admin/sites/${TEST_SITE.id}/funnels/${createdBody.data.id}`, {
        method: 'PATCH',
        cookie,
        body: {},
      }),
    );
    expect(empty.status).toBe(400);

    const unknown = await call(
      apiRequest(`/api/v1/admin/sites/${TEST_SITE.id}/funnels/fun_missing`, {
        method: 'PATCH',
        cookie,
        body: { isActive: true },
      }),
    );
    expect(unknown.status).toBe(404);
  });

  it('soft-deletes a funnel', async () => {
    const cookie = await login();
    const created = await createFunnel(cookie, {
      name: 'Delete me',
      steps: [
        { type: 'page', path: '/a' },
        { type: 'page', path: '/b' },
      ],
    });
    const createdBody = await created.json<{ data: { id: string } }>();

    const removed = await call(
      apiRequest(`/api/v1/admin/sites/${TEST_SITE.id}/funnels/${createdBody.data.id}`, {
        method: 'DELETE',
        cookie,
      }),
    );
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');

    const list = await call(apiRequest(`/api/v1/admin/sites/${TEST_SITE.id}/funnels`, { cookie }));
    const listBody = await list.json<{ data: Array<Record<string, unknown>> }>();
    expect(listBody.data).toHaveLength(0);

    const again = await call(
      apiRequest(`/api/v1/admin/sites/${TEST_SITE.id}/funnels/${createdBody.data.id}`, {
        method: 'DELETE',
        cookie,
      }),
    );
    expect(again.status).toBe(404);
  });
});

describe('GET /api/v1/analytics/funnel/{funnelId}', () => {
  it('returns 404 for an unknown funnel', async () => {
    const cookie = await login();
    const response = await call(
      apiRequest(`/api/v1/analytics/funnel/fun_missing?siteId=${TEST_SITE.id}&${RANGE}`, {
        cookie,
      }),
    );
    expect(response.status).toBe(404);
  });

  it('evaluates ordered steps within a session', async () => {
    const cookie = await login();
    const created = await createFunnel(cookie, {
      name: 'Checkout',
      steps: [
        { type: 'page', path: '/pricing' },
        { type: 'goal', goal: 'payment' },
      ],
    });
    const createdBody = await created.json<{ data: { id: string } }>();

    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      path: '/pricing',
      ts: T0,
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      name: 'payment',
      path: '/checkout',
      ts: T0 + 10,
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v2',
      session_id: 's2',
      path: '/pricing',
      ts: T0 + 20,
    });
    await insertPayment({
      websiteId: TEST_SITE.id,
      visitorId: 'v1',
      amountCents: 5000,
      occurredAt: T0 + 15,
    });

    const response = await call(
      apiRequest(
        `/api/v1/analytics/funnel/${createdBody.data.id}?siteId=${TEST_SITE.id}&${RANGE}`,
        {
          cookie,
        },
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ data: Record<string, unknown> }>();
    expect(body.data).toMatchObject({
      id: createdBody.data.id,
      name: 'Checkout',
      totalVisitors: 2,
      totalConversionRate: 0.5,
      revenue: 50,
      payments: 1,
      revenuePerVisitor: 25,
      timezone: 'UTC',
      startAt: '2026-01-01',
      endAt: '2026-01-31',
    });
    const steps = body.data.steps as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      step: 1,
      visitors: 2,
      conversionRate: 1,
      dropoffRate: 0,
      revenue: 50,
      payments: 1,
    });
    expect(steps[1]).toMatchObject({
      step: 2,
      visitors: 1,
      conversionRate: 0.5,
      dropoffRate: 0.5,
      revenue: 50,
      payments: 1,
    });
  });

  it('returns 404 for an inactive funnel', async () => {
    const cookie = await login();
    const created = await createFunnel(cookie, {
      name: 'Inactive',
      isActive: false,
      steps: [
        { type: 'page', path: '/a' },
        { type: 'page', path: '/b' },
      ],
    });
    const createdBody = await created.json<{ data: { id: string } }>();
    const response = await call(
      apiRequest(
        `/api/v1/analytics/funnel/${createdBody.data.id}?siteId=${TEST_SITE.id}&${RANGE}`,
        {
          cookie,
        },
      ),
    );
    expect(response.status).toBe(404);
  });

  it('honours maxGapSeconds', async () => {
    const cookie = await login();
    const created = await createFunnel(cookie, {
      name: 'Gapped',
      maxGapSeconds: 60,
      steps: [
        { type: 'page', path: '/pricing' },
        { type: 'goal', goal: 'payment' },
      ],
    });
    const createdBody = await created.json<{ data: { id: string } }>();

    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      path: '/pricing',
      ts: T0,
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      name: 'payment',
      path: '/checkout',
      ts: T0 + 120,
    });

    const response = await call(
      apiRequest(
        `/api/v1/analytics/funnel/${createdBody.data.id}?siteId=${TEST_SITE.id}&${RANGE}`,
        {
          cookie,
        },
      ),
    );
    const body = await response.json<{ data: { steps: Array<Record<string, unknown>> } }>();
    expect(body.data.steps[1].visitors).toBe(0);
  });

  it('drops a scrollDepth step when the site has no scroll events', async () => {
    const cookie = await login();
    const created = await createFunnel(cookie, {
      name: 'Scroll',
      steps: [
        { type: 'page', path: '/' },
        { type: 'scrollDepth', scrollPercent: 50 },
        { type: 'goal', goal: 'signup' },
      ],
    });
    const createdBody = await created.json<{ data: { id: string } }>();

    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      path: '/',
      ts: T0,
    });
    await insertEvent({
      website_id: TEST_SITE.id,
      visitor_id: 'v1',
      session_id: 's1',
      name: 'signup',
      path: '/',
      ts: T0 + 5,
    });

    const response = await call(
      apiRequest(
        `/api/v1/analytics/funnel/${createdBody.data.id}?siteId=${TEST_SITE.id}&${RANGE}`,
        {
          cookie,
        },
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ data: { steps: Array<Record<string, unknown>> } }>();
    expect(body.data.steps).toHaveLength(2);
    expect(body.data.steps[1].name).toContain('signup');
  });
});
