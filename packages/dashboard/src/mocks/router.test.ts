import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { handleMockRequest } from './router.ts';

interface CapturedResponse {
  statusCode: number;
  body: string;
  setHeader: (name: string, value: string) => void;
  end: (chunk: string) => void;
}

interface CapturedBody {
  data?: unknown;
  error?: { code: number; message: string };
}

function captureResponse(): CapturedResponse {
  const captured: CapturedResponse = {
    statusCode: 0,
    body: '',
    setHeader: () => {},
    end: (chunk: string) => {
      captured.body = chunk;
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
