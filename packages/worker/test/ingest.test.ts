import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src';
import {
  applySchema,
  beaconRequest,
  countEvents,
  firstEvent,
  pageviewBody,
  pixelRequest,
  resetData,
  TEST_SITE,
} from './helpers';

async function call(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe('POST /t ingestion', () => {
  beforeAll(async () => {
    await applySchema();
  });

  beforeEach(async () => {
    await resetData();
  });

  it('accepts a valid beacon with 204 and writes exactly one events row', async () => {
    const response = await call(beaconRequest(pageviewBody()));
    expect(response.status).toBe(204);
    expect(await countEvents()).toBe(1);
  });

  it('enriches the event server-side (session, visitor, geo, channel)', async () => {
    const response = await call(
      beaconRequest(
        pageviewBody({ u: 'https://example.com/pricing?utm_source=google&utm_medium=cpc' }),
        {
          cf: { country: 'US', region: 'CA', city: 'San Francisco', colo: 'SJC' },
        },
      ),
    );
    expect(response.status).toBe(204);

    const event = await firstEvent();
    expect(event).not.toBeNull();
    expect(event?.website_id).toBe(TEST_SITE.id);
    expect(event?.name).toBe('pageview');
    expect(event?.channel).toBe('paid');
    expect(event?.channel_name).toBe('google');
    expect(event?.utm_source).toBe('google');
    expect(event?.country).toBe('US');
    expect(event?.colo).toBe('SJC');
    expect(event?.device_type).toBe('desktop');
    expect(event?.browser).toBe('Chrome');
    expect(event?.is_bot).toBe(0);
    expect(typeof event?.session_id).toBe('string');
    expect(event?.session_id).toBeTruthy();
    expect(typeof event?.visitor_id).toBe('string');
    expect(event?.visitor_id).toBeTruthy();
  });

  it('is idempotent on event_id: a replay returns 204 and does not add a row', async () => {
    const body = pageviewBody();
    expect((await call(beaconRequest(body))).status).toBe(204);
    expect(await countEvents()).toBe(1);

    expect((await call(beaconRequest(body))).status).toBe(204);
    expect(await countEvents()).toBe(1);
  });

  it('rejects a beacon for a non-allowed host with 400 host_not_allowed', async () => {
    const response = await call(beaconRequest(pageviewBody({ u: 'https://evil.example.net/' })));
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { details: Array<{ code: string }> } };
    expect(payload.error.details[0].code).toBe('host_not_allowed');
    expect(await countEvents()).toBe(0);
  });

  it('returns 404 for an unknown site token', async () => {
    const response = await call(beaconRequest(pageviewBody({ s: 'dg_test_unknown' })));
    expect(response.status).toBe(404);
    expect(await countEvents()).toBe(0);
  });

  it('returns 400 for a timestamp outside the ±24h window', async () => {
    const response = await call(beaconRequest(pageviewBody({ ts: Date.now() - 25 * 3600 * 1000 })));
    expect(response.status).toBe(400);
    expect(await countEvents()).toBe(0);
  });

  it('returns 400 when a custom event has no props.name', async () => {
    const response = await call(
      beaconRequest(pageviewBody({ e: 'event', props: {}, event_id: undefined })),
    );
    expect(response.status).toBe(400);
    expect(await countEvents()).toBe(0);
  });

  it('accepts a custom event with props.name and stores it as the event name', async () => {
    const response = await call(
      beaconRequest(pageviewBody({ e: 'event', props: { name: 'signup', plan: 'pro' } })),
    );
    expect(response.status).toBe(204);
    expect(await countEvents()).toBe(1);
    expect((await firstEvent())?.name).toBe('signup');
  });

  it('returns 400 for malformed JSON', async () => {
    const response = await call(beaconRequest('{not json'));
    expect(response.status).toBe(400);
  });

  it('drops a known-bot User-Agent at the standard level', async () => {
    const response = await call(
      beaconRequest(pageviewBody(), {
        userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      }),
    );
    expect(response.status).toBe(204);
    expect(await countEvents()).toBe(0);
  });

  it('records a known-bot User-Agent with is_bot=1 at the off level', async () => {
    await resetData({ bot_filter_level: 'off' });
    const response = await call(
      beaconRequest(pageviewBody(), { userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1)' }),
    );
    expect(response.status).toBe(204);
    expect(await countEvents()).toBe(1);
    const event = await firstEvent();
    expect(event?.is_bot).toBe(1);
    expect(event?.bot_reason).toBe('known_bot');
    expect(event?.bot_score).toBe(0);
  });

  it('drops a datacenter ASN at the strict level', async () => {
    await resetData({ bot_filter_level: 'strict' });
    const response = await call(
      beaconRequest(pageviewBody(), { cf: { asn: 16509, country: 'US' } }),
    );
    expect(response.status).toBe(204);
    expect(await countEvents()).toBe(0);
  });

  it('keeps a datacenter ASN at the standard level', async () => {
    const response = await call(
      beaconRequest(pageviewBody(), { cf: { asn: 16509, country: 'US' } }),
    );
    expect(response.status).toBe(204);
    expect(await countEvents()).toBe(1);
  });

  it('derives a stable cookieless visitor id when no cookie or vid is sent', async () => {
    await resetData({ privacy_mode: 'cookieless', allow_cookieless: 1 });

    const first = await call(beaconRequest(pageviewBody(), { ip: '198.51.100.9' }));
    expect(first.status).toBe(204);
    const firstEventRow = await firstEvent();

    const second = await call(beaconRequest(pageviewBody(), { ip: '198.51.100.9' }));
    expect(second.status).toBe(204);

    const rows = await env.DB.prepare('SELECT visitor_id FROM events ORDER BY ts ASC').all<{
      visitor_id: string;
    }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0].visitor_id).toBe(rows.results[1].visitor_id);
    expect(firstEventRow?.visitor_id).toBe(rows.results[0].visitor_id);
  });

  it('reuses the _dg_vid cookie as the visitor id', async () => {
    const vid = 'cookie_visitor_123';
    const response = await call(beaconRequest(pageviewBody(), { cookie: `_dg_vid=${vid}` }));
    expect(response.status).toBe(204);
    expect((await firstEvent())?.visitor_id).toBe(vid);
  });

  it('attributes a self-referrer on a checkout path as a checkout return', async () => {
    const response = await call(
      beaconRequest(
        pageviewBody({
          u: 'https://example.com/checkout',
          p: '/checkout',
          r: 'https://example.com/cart',
        }),
      ),
    );
    expect(response.status).toBe(204);
    const event = await firstEvent();
    expect(event?.channel).toBe('direct');
    expect(event?.direct_type).toBe('checkout_return');
  });

  it('returns a 1x1 GIF for GET /p.gif and records the event', async () => {
    const response = await call(
      pixelRequest({
        s: TEST_SITE.site_token,
        e: 'pageview',
        ts: String(Date.now()),
        u: 'https://example.com/',
        p: '/',
        event_id: 'pixel_1',
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/gif');
    expect(await countEvents("event_id = 'pixel_1'")).toBe(1);
  });

  it('answers OPTIONS with 204 and CORS headers', async () => {
    const response = await call(
      new Request('https://example.com/t', { method: 'OPTIONS' }) as unknown as Request,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('GET /', () => {
  it('returns the dashboard SPA shell', async () => {
    const response = await call(new Request('https://example.com/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const body = await response.text();
    expect(body).toContain('DataGoat');
    expect(body).toContain('id="root"');
  });

  it('falls back to the SPA shell for client-side routes', async () => {
    const response = await call(new Request('https://example.com/funnels'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('id="root"');
  });
});
