import type { ExecutionContext } from '@cloudflare/workers-types';
import type { Env, Website } from './env';
import { providerEventId, providerEventType } from './payments/adapters';
import { processWebhookEvent } from './payments/processor';
import { verifyWebhookSignature } from './payments/signature';
import { isProvider, type Provider } from './payments/types';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Stripe-Signature, webhook-id, webhook-timestamp, webhook-signature, creem-signature, X-DataGoat-Site',
  'Cache-Control': 'no-store',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/**
 * Webhook routing (§7.1). Providers cannot carry our tenancy key, so the
 * operator configures each provider webhook URL with `?site=<site_token>`
 * (or the `X-DataGoat-Site` header). The site token resolves to `website_id`;
 * the signature secret is read from `payment_integrations` for that site.
 */
async function resolveWebsite(env: Env, request: Request): Promise<Website | null> {
  const url = new URL(request.url);
  const siteToken = url.searchParams.get('site') ?? request.headers.get('x-datagoat-site');
  if (!siteToken) return null;
  return env.DB.prepare('SELECT * FROM websites WHERE site_token = ?')
    .bind(siteToken)
    .first<Website>();
}

async function resolveSecret(
  env: Env,
  websiteId: string,
  provider: Provider,
): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT webhook_secret FROM payment_integrations WHERE website_id = ? AND provider = ?',
  )
    .bind(websiteId, provider)
    .first<{ webhook_secret: string | null }>();
  if (row?.webhook_secret) return row.webhook_secret;
  const envKey = `WEBHOOK_SECRET_${provider.toUpperCase()}` as keyof Env;
  const fallback = env[envKey];
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : null;
}

/**
 * Shared webhook entry point (§7.1): verify -> parse -> idempotency check ->
 * acknowledge -> process async. Signature failure returns 401 without logging
 * the payload.
 */
export async function handlePaymentWebhook(
  request: Request,
  env: Env,
  provider: Provider,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const website = await resolveWebsite(env, request);
  if (!website) return json({ error: 'unknown_site' }, 404);

  const secret = await resolveSecret(env, website.id, provider);
  if (!secret) return json({ error: 'webhook_not_configured' }, 500);

  const rawBody = await request.text();
  const headers = {
    'stripe-signature': request.headers.get('stripe-signature'),
    'webhook-id': request.headers.get('webhook-id'),
    'webhook-timestamp': request.headers.get('webhook-timestamp'),
    'webhook-signature': request.headers.get('webhook-signature'),
    'creem-signature': request.headers.get('creem-signature'),
  };

  const verified = await verifyWebhookSignature(
    provider,
    rawBody,
    headers,
    secret,
    Math.floor(Date.now() / 1000),
  );
  if (!verified) return json({ error: 'invalid_signature' }, 401);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const headerEventId = headers['webhook-id'];
  const eventId = providerEventId(provider, payload, headerEventId);
  if (!eventId) return json({ error: 'missing_event_id' }, 400);

  const existing = await env.DB.prepare(
    'SELECT status FROM webhook_events WHERE website_id = ? AND event_id = ?',
  )
    .bind(website.id, eventId)
    .first<{ status: string }>();
  if (existing) return json({ ok: true, duplicate: true, status: existing.status }, 200);

  const eventType = providerEventType(provider, payload);
  ctx.waitUntil(
    processWebhookEvent(env, website.id, provider, payload, rawBody, headerEventId).catch(
      (error) => {
        console.error(`payment webhook failed (${provider}/${eventType ?? 'unknown'})`, error);
      },
    ),
  );

  return json({ ok: true }, 200);
}

export { isProvider };
