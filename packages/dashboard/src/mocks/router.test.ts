import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { handleMockRequest } from './router.ts';

interface CapturedResponse {
  statusCode: number;
  body: string;
  setHeader: (name: string, value: string) => void;
  end: (chunk?: string) => void;
}

interface CapturedBody {
  data?: unknown;
  pagination?: { limit: number; offset: number; total: number; hasMore: boolean };
  error?: { code: number; message: string };
}

function captureResponse(): CapturedResponse {
  const captured: CapturedResponse = {
    statusCode: 0,
    body: '',
    setHeader: () => {},
    end: (chunk?: string) => {
      captured.body = chunk ?? '';
    },
  };
  return captured;
}

async function requestJson(path: string): Promise<{ status: number; body: CapturedBody }> {
  const response = captureResponse();
  await handleMockRequest(
    { method: 'GET', url: path } as unknown as IncomingMessage,
    response as unknown as ServerResponse,
  );
  return { status: response.statusCode, body: JSON.parse(response.body) as CapturedBody };
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  rawBody?: string,
): Promise<{ status: number; body: CapturedBody; raw: string }> {
  const response = captureResponse();
  const chunks =
    rawBody !== undefined ? [rawBody] : body === undefined ? [] : [JSON.stringify(body)];
  const request = Object.assign(Readable.from(chunks), {
    method,
    url: path,
  }) as unknown as IncomingMessage;
  await handleMockRequest(request, response as unknown as ServerResponse);
  return {
    status: response.statusCode,
    body: response.body ? (JSON.parse(response.body) as CapturedBody) : {},
    raw: response.body,
  };
}

function listData(body: CapturedBody): Array<Record<string, unknown>> {
  return (body.data ?? []) as Array<Record<string, unknown>>;
}

const SITE_SCOPED_PATHS = [
  '/api/v1/analytics/overview',
  '/api/v1/analytics/timeseries',
  '/api/v1/analytics/metadata',
  '/api/v1/analytics/pages',
  '/api/v1/analytics/goals',
  '/api/v1/analytics/funnel/fun_1',
];

describe('mock site scope', () => {
  it.each(SITE_SCOPED_PATHS)('rejects a missing siteId on %s', async (path) => {
    const result = await requestJson(path);

    expect(result.status).toBe(400);
    expect(result.body.error).toMatchObject({ code: 400, message: 'siteId is required' });
  });

  it.each(SITE_SCOPED_PATHS)('rejects an unknown siteId on %s', async (path) => {
    const result = await requestJson(`${path}?siteId=site_missing`);

    expect(result.status).toBe(404);
  });

  it.each(SITE_SCOPED_PATHS)('accepts an owned siteId on %s', async (path) => {
    const result = await requestJson(`${path}?siteId=site_1`);

    expect(result.status).toBe(200);
  });

  it('rejects duplicate siteId params', async () => {
    const result = await requestJson('/api/v1/analytics/overview?siteId=site_1&siteId=site_2');

    expect(result.status).toBe(400);
  });

  it('keeps the site list site-agnostic', async () => {
    const result = await requestJson('/api/v1/admin/sites');

    expect(result.status).toBe(200);
    expect(Array.isArray(result.body.data)).toBe(true);
  });
});

const TRIAL_BODY = {
  name: 'Trial',
  steps: [
    { type: 'page', path: '/', name: 'Landing' },
    { type: 'goal', goal: 'signup', name: 'Signup' },
  ],
};

describe('mock admin funnel CRUD', () => {
  it('lists funnel definitions with pagination', async () => {
    const result = await request('GET', '/api/v1/admin/sites/site_1/funnels');

    expect(result.status).toBe(200);
    expect(listData(result.body)).toHaveLength(2);
    expect(listData(result.body)[0]).toMatchObject({ id: 'fun_2' });
    expect(result.body.pagination).toMatchObject({
      limit: 100,
      offset: 0,
      total: 2,
      hasMore: false,
    });
  });

  it('reverses the list with order=asc', async () => {
    const result = await request('GET', '/api/v1/admin/sites/site_1/funnels?order=asc');

    expect(listData(result.body)[0]).toMatchObject({ id: 'fun_1' });
  });

  it('paginates the list', async () => {
    const result = await request('GET', '/api/v1/admin/sites/site_1/funnels?limit=1&offset=0');

    expect(listData(result.body)).toHaveLength(1);
    expect(result.body.pagination).toMatchObject({ limit: 1, offset: 0, total: 2, hasMore: true });
  });

  it('rejects a siteId query param on the admin route', async () => {
    const result = await request('GET', '/api/v1/admin/sites/site_1/funnels?siteId=site_1');

    expect(result.status).toBe(400);
  });

  it('rejects an unknown site', async () => {
    const result = await request('GET', '/api/v1/admin/sites/site_missing/funnels');

    expect(result.status).toBe(404);
  });

  it('creates a funnel with defaults', async () => {
    const result = await request('POST', '/api/v1/admin/sites/site_1/funnels', TRIAL_BODY);

    expect(result.status).toBe(201);
    expect(result.body.data).toMatchObject({
      name: 'Trial',
      isActive: true,
      maxGapSeconds: null,
    });
    const data = result.body.data as Record<string, unknown>;
    expect(data.steps).toHaveLength(2);

    const list = await request('GET', '/api/v1/admin/sites/site_1/funnels');
    expect(listData(list.body).some((item) => item.name === 'Trial')).toBe(true);
  });

  it('rejects a duplicate funnel name', async () => {
    const result = await request('POST', '/api/v1/admin/sites/site_1/funnels', {
      ...TRIAL_BODY,
      name: 'Checkout',
    });

    expect(result.status).toBe(409);
  });

  it('validates the name and step count', async () => {
    const missingName = await request('POST', '/api/v1/admin/sites/site_1/funnels', {
      steps: TRIAL_BODY.steps,
    });
    expect(missingName.status).toBe(400);

    const longName = await request('POST', '/api/v1/admin/sites/site_1/funnels', {
      ...TRIAL_BODY,
      name: 'x'.repeat(101),
    });
    expect(longName.status).toBe(400);

    const tooFew = await request('POST', '/api/v1/admin/sites/site_1/funnels', {
      ...TRIAL_BODY,
      steps: [{ type: 'page', path: '/' }],
    });
    expect(tooFew.status).toBe(400);

    const tooMany = await request('POST', '/api/v1/admin/sites/site_1/funnels', {
      ...TRIAL_BODY,
      steps: Array.from({ length: 9 }, () => ({ type: 'page', path: '/' })),
    });
    expect(tooMany.status).toBe(400);
  });

  it('rejects unknown step types, params, and missing fields', async () => {
    const unknownType = await request('POST', '/api/v1/admin/sites/site_1/funnels', {
      ...TRIAL_BODY,
      steps: [
        { type: 'wat', path: '/' },
        { type: 'goal', goal: 'signup' },
      ],
    });
    expect(unknownType.status).toBe(400);

    const unknownParam = await request('POST', '/api/v1/admin/sites/site_1/funnels', {
      ...TRIAL_BODY,
      steps: [
        { type: 'page', path: '/', nope: 'x' },
        { type: 'goal', goal: 'signup' },
      ],
    });
    expect(unknownParam.status).toBe(400);

    const missingField = await request('POST', '/api/v1/admin/sites/site_1/funnels', {
      ...TRIAL_BODY,
      steps: [{ type: 'page' }, { type: 'goal', goal: 'signup' }],
    });
    expect(missingField.status).toBe(400);
  });

  it('rejects unknown top-level fields and bad maxGapSeconds', async () => {
    const unknownField = await request('POST', '/api/v1/admin/sites/site_1/funnels', {
      ...TRIAL_BODY,
      nope: true,
    });
    expect(unknownField.status).toBe(400);

    const badGap = await request('POST', '/api/v1/admin/sites/site_1/funnels', {
      ...TRIAL_BODY,
      maxGapSeconds: 0,
    });
    expect(badGap.status).toBe(400);

    const nullGap = await request('POST', '/api/v1/admin/sites/site_1/funnels', {
      ...TRIAL_BODY,
      name: 'Trial null gap',
      maxGapSeconds: null,
    });
    expect(nullGap.status).toBe(201);
  });

  it('rejects an invalid JSON body', async () => {
    const result = await request(
      'POST',
      '/api/v1/admin/sites/site_1/funnels',
      undefined,
      '{not json',
    );

    expect(result.status).toBe(400);
  });

  it('patches a funnel name without touching steps', async () => {
    const result = await request('PATCH', '/api/v1/admin/sites/site_1/funnels/fun_1', {
      name: 'Checkout v2',
    });

    expect(result.status).toBe(200);
    expect(result.body.data).toMatchObject({ id: 'fun_1', name: 'Checkout v2' });
    const data = result.body.data as Record<string, unknown>;
    expect(data.steps).toHaveLength(3);
  });

  it('replaces the whole step list on patch', async () => {
    const steps = [
      { type: 'page', path: '/a', name: 'A' },
      { type: 'page', path: '/b', name: 'B' },
      { type: 'page', path: '/c', name: 'C' },
      { type: 'goal', goal: 'signup', name: 'Signup' },
    ];
    const result = await request('PATCH', '/api/v1/admin/sites/site_1/funnels/fun_1', { steps });

    expect(result.status).toBe(200);
    const data = result.body.data as Record<string, unknown>;
    expect(data.steps).toHaveLength(4);
  });

  it('rejects an empty patch, unknown funnel, and duplicate name', async () => {
    const empty = await request('PATCH', '/api/v1/admin/sites/site_1/funnels/fun_1', {});
    expect(empty.status).toBe(400);

    const unknown = await request('PATCH', '/api/v1/admin/sites/site_1/funnels/fun_missing', {
      name: 'Nope',
    });
    expect(unknown.status).toBe(404);

    const duplicate = await request('PATCH', '/api/v1/admin/sites/site_1/funnels/fun_1', {
      name: 'Signup',
    });
    expect(duplicate.status).toBe(409);
  });

  it('returns 404 from the results route for an inactive funnel', async () => {
    const created = await request('POST', '/api/v1/admin/sites/site_1/funnels', {
      ...TRIAL_BODY,
      name: 'Inactive Funnel',
    });
    const id = (created.body.data as Record<string, unknown>).id as string;

    const patched = await request('PATCH', `/api/v1/admin/sites/site_1/funnels/${id}`, {
      isActive: false,
    });
    expect(patched.status).toBe(200);

    const result = await request('GET', `/api/v1/analytics/funnel/${id}?siteId=site_1`);
    expect(result.status).toBe(404);
  });

  it('deletes a funnel and hides it from results', async () => {
    const created = await request('POST', '/api/v1/admin/sites/site_1/funnels', {
      ...TRIAL_BODY,
      name: 'Doomed Funnel',
    });
    const id = (created.body.data as Record<string, unknown>).id as string;

    const removed = await request('DELETE', `/api/v1/admin/sites/site_1/funnels/${id}`);
    expect(removed.status).toBe(204);
    expect(removed.raw).toBe('');

    const list = await request('GET', '/api/v1/admin/sites/site_1/funnels');
    expect(listData(list.body).some((item) => item.id === id)).toBe(false);

    const result = await request('GET', `/api/v1/analytics/funnel/${id}?siteId=site_1`);
    expect(result.status).toBe(404);
  });

  it('rejects deleting an unknown funnel', async () => {
    const result = await request('DELETE', '/api/v1/admin/sites/site_1/funnels/fun_missing');

    expect(result.status).toBe(404);
  });

  it('returns 404 for an unknown funnel on the results route', async () => {
    const result = await request('GET', '/api/v1/analytics/funnel/fun_missing?siteId=site_1');

    expect(result.status).toBe(404);
  });
});
