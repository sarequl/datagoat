import { env } from 'cloudflare:workers';
import initSql from '../migrations/0001_init.sql?raw';
import initSql0002 from '../migrations/0002_payments_attribution.sql?raw';

/** Request type accepted by `worker.fetch()`. */
export type WorkerRequest = Request<unknown, IncomingRequestCfProperties>;

export interface SeedSite {
  id: string;
  site_token: string;
  name: string;
  domain: string;
  timezone: string;
  currency: string;
  owner_user_id: string | null;
  privacy_mode: string;
  allow_cookieless: number;
  allowed_hosts: string;
  excluded_ips: string;
  excluded_paths: string;
  excluded_ua: string;
  hash_paths: number;
  attribution_model: string;
  retention_days: number;
  bot_filter_level: string;
  created_at: number;
  updated_at: number;
}

export const TEST_SITE: SeedSite = {
  id: 'site_test_1',
  site_token: 'dg_test_site_token',
  name: 'Test Site',
  domain: 'example.com',
  timezone: 'UTC',
  currency: 'USD',
  owner_user_id: null,
  privacy_mode: 'cookies',
  allow_cookieless: 1,
  allowed_hosts: JSON.stringify(['example.com', 'www.example.com']),
  excluded_ips: '[]',
  excluded_paths: '[]',
  excluded_ua: '[]',
  hash_paths: 0,
  attribution_model: 'last_non_direct',
  retention_days: 365,
  bot_filter_level: 'standard',
  created_at: 0,
  updated_at: 0,
};

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function applySchema(): Promise<void> {
  for (const statement of splitStatements(initSql)) {
    await env.DB.prepare(statement).run();
  }
  for (const statement of splitStatements(initSql0002)) {
    await env.DB.prepare(statement).run();
  }
}

/**
 * Splits a SQL script into individual statements, ignoring line and block
 * comments and semicolons inside string literals. D1's `exec()` chokes on a
 * leading comment block, so each statement is prepared and run on its own.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === '-' && next === '-') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === ';') {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      continue;
    }
    current += ch;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/** Wipes the data tables and inserts a fresh website row. */
export async function resetData(overrides: Partial<SeedSite> = {}): Promise<SeedSite> {
  const now = Math.floor(Date.now() / 1000);
  const site: SeedSite = { ...TEST_SITE, ...overrides, created_at: now, updated_at: now };

  await env.DB.exec(
    'DELETE FROM daily_aggregates; DELETE FROM sessions; DELETE FROM visitors; DELETE FROM events;' +
      ' DELETE FROM payments; DELETE FROM webhook_events; DELETE FROM customers;' +
      ' DELETE FROM customer_links; DELETE FROM fx_rates; DELETE FROM payment_integrations;',
  );

  await env.DB.prepare(
    `INSERT OR REPLACE INTO websites (
       id, site_token, name, domain, timezone, currency, owner_user_id, privacy_mode,
       allow_cookieless, allowed_hosts, excluded_ips, excluded_paths, excluded_ua,
       hash_paths, attribution_model, retention_days, bot_filter_level, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      site.id,
      site.site_token,
      site.name,
      site.domain,
      site.timezone,
      site.currency,
      site.owner_user_id,
      site.privacy_mode,
      site.allow_cookieless,
      site.allowed_hosts,
      site.excluded_ips,
      site.excluded_paths,
      site.excluded_ua,
      site.hash_paths,
      site.attribution_model,
      site.retention_days,
      site.bot_filter_level,
      site.created_at,
      site.updated_at,
    )
    .run();

  return site;
}

let seq = 0;
export function nextId(prefix = 'ev'): string {
  seq += 1;
  return `${prefix}_${Date.now()}_${seq}`;
}

export function pageviewBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    s: TEST_SITE.site_token,
    e: 'pageview',
    ts: Date.now(),
    u: 'https://example.com/',
    p: '/',
    q: '',
    r: '',
    event_id: nextId(),
    ...overrides,
  };
}

export interface RequestOptions {
  ip?: string;
  userAgent?: string;
  cookie?: string;
  cf?: Record<string, unknown>;
  path?: string;
}

let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `203.0.113.${(ipSeq % 250) + 1}`;
}

function build(
  url: string,
  method: string,
  headers: Record<string, string>,
  options: RequestOptions,
  body?: string,
): WorkerRequest {
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = body;
  if (options.cf) (init as { cf?: unknown }).cf = options.cf;
  return new Request(url, init) as unknown as WorkerRequest;
}

/** Builds a beacon request. A unique IP per call keeps the KV rate limit out of the way. */
export function beaconRequest(body: unknown, options: RequestOptions = {}): WorkerRequest {
  const headers: Record<string, string> = {
    'content-type': 'text/plain;charset=UTF-8',
    'user-agent': options.userAgent ?? BROWSER_UA,
    accept: 'text/html,application/xhtml+xml',
    'accept-language': 'en-US,en;q=0.9',
    'CF-Connecting-IP': options.ip ?? nextIp(),
  };
  if (options.cookie) headers.cookie = options.cookie;

  return build(
    `https://example.com${options.path ?? '/t'}`,
    'POST',
    headers,
    options,
    typeof body === 'string' ? body : JSON.stringify(body),
  );
}

export function pixelRequest(
  query: Record<string, string>,
  options: RequestOptions = {},
): WorkerRequest {
  const headers: Record<string, string> = {
    'user-agent': options.userAgent ?? BROWSER_UA,
    accept: 'image/avif,image/webp,*/*',
    'CF-Connecting-IP': options.ip ?? nextIp(),
  };
  if (options.cookie) headers.cookie = options.cookie;
  const qs = new URLSearchParams(query).toString();
  return build(`https://example.com/p.gif?${qs}`, 'GET', headers, options);
}

export async function countEvents(where = ''): Promise<number> {
  const sql = where
    ? `SELECT COUNT(*) AS n FROM events WHERE ${where}`
    : 'SELECT COUNT(*) AS n FROM events';
  const row = await env.DB.prepare(sql).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function firstEvent(): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare('SELECT * FROM events ORDER BY ts ASC LIMIT 1').first<
    Record<string, unknown>
  >();
  return row ?? null;
}

export async function dayOf(ts: number): Promise<string> {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts * 1000));
}

export async function aggValue(
  day: string,
  kind: string,
  dimKey = '',
  dimValue = '',
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT value FROM daily_aggregates
     WHERE website_id = ? AND day = ? AND kind = ? AND dim_key = ? AND dim_value = ?`,
  )
    .bind(TEST_SITE.id, day, kind, dimKey, dimValue)
    .first<{ value: number }>();
  return row?.value ?? 0;
}

// ---------------------------------------------------------------------------
// Milestone 2 — payments fixtures
// ---------------------------------------------------------------------------

export interface SeedEvent {
  website_id: string;
  visitor_id: string;
  session_id?: string | null;
  name?: string;
  ts: number;
  channel?: string | null;
  channel_name?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  path?: string | null;
  referrer?: string | null;
  is_bot?: number;
  consent?: number | null;
}

export async function insertEvent(event: SeedEvent): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events (
       id, website_id, event_id, session_id, visitor_id, name, ts, path, referrer,
       channel, channel_name, utm_source, utm_medium, utm_campaign, is_bot, consent, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      nextId('ev'),
      event.website_id,
      nextId('eid'),
      event.session_id ?? null,
      event.visitor_id,
      event.name ?? 'pageview',
      event.ts,
      event.path ?? '/',
      event.referrer ?? null,
      event.channel ?? null,
      event.channel_name ?? null,
      event.utm_source ?? null,
      event.utm_medium ?? null,
      event.utm_campaign ?? null,
      event.is_bot ?? 0,
      event.consent ?? 1,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

export async function seedPaymentIntegration(
  websiteId: string,
  provider: string,
  webhookSecret: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO payment_integrations (id, website_id, provider, webhook_secret, enabled, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
  )
    .bind(nextId('pi'), websiteId, provider, webhookSecret, Math.floor(Date.now() / 1000))
    .run();
}

export async function countPayments(where = ''): Promise<number> {
  const sql = where
    ? `SELECT COUNT(*) AS n FROM payments WHERE ${where}`
    : 'SELECT COUNT(*) AS n FROM payments';
  const row = await env.DB.prepare(sql).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function firstPayment(): Promise<Record<string, unknown> | null> {
  return env.DB.prepare('SELECT * FROM payments ORDER BY occurred_at ASC LIMIT 1').first<
    Record<string, unknown>
  >();
}

export async function getPayment(
  providerPaymentId: string,
): Promise<Record<string, unknown> | null> {
  return env.DB.prepare('SELECT * FROM payments WHERE provider_payment_id = ?')
    .bind(providerPaymentId)
    .first<Record<string, unknown>>();
}

export async function countWebhookEvents(where = ''): Promise<number> {
  const sql = where
    ? `SELECT COUNT(*) AS n FROM webhook_events WHERE ${where}`
    : 'SELECT COUNT(*) AS n FROM webhook_events';
  const row = await env.DB.prepare(sql).first<{ n: number }>();
  return row?.n ?? 0;
}

export interface WebhookRequestOptions {
  site?: string;
  headers?: Record<string, string>;
  ip?: string;
}

export function webhookRequest(
  provider: string,
  payload: unknown,
  options: WebhookRequestOptions = {},
): WorkerRequest {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const site = options.site ?? TEST_SITE.site_token;
  const url = `https://example.com/api/v1/ingest/payment/${provider}?site=${encodeURIComponent(site)}`;
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body,
  };
  return new Request(url, init) as unknown as WorkerRequest;
}

export async function stripeSignature(
  rawBody: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<string> {
  const { hmacSha256Hex } = await import('../src/util/crypto');
  const value = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return `t=${timestamp},v1=${value}`;
}

export async function standardWebhooksSignature(
  id: string,
  rawBody: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<string> {
  const { hmacSha256Hex } = await import('../src/util/crypto');
  const value = await hmacSha256Hex(secret, `${id}.${timestamp}.${rawBody}`);
  return `v1,${value}`;
}

export async function creemSignature(rawBody: string, secret: string): Promise<string> {
  const { hmacSha256Hex } = await import('../src/util/crypto');
  return hmacSha256Hex(secret, rawBody);
}

export function stripeEvent(eventType: string, object: Record<string, unknown>, eventId?: string) {
  return {
    id: eventId ?? nextId('evt'),
    type: eventType,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  };
}

export function polarEvent(eventType: string, data: Record<string, unknown>, eventId?: string) {
  return {
    id: eventId ?? nextId('plev'),
    type: eventType,
    timestamp: Math.floor(Date.now() / 1000),
    data,
  };
}

export function dodoEvent(eventType: string, data: Record<string, unknown>) {
  return {
    type: eventType,
    timestamp: Math.floor(Date.now() / 1000),
    data,
  };
}

export function creemEvent(eventType: string, object: Record<string, unknown>, eventId?: string) {
  return {
    id: eventId ?? nextId('crev'),
    eventType,
    created_at: Math.floor(Date.now() / 1000),
    object,
  };
}
