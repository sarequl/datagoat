import { classifyAttribution } from './attribution';
import { evaluateBot } from './bot';
import type { BotFilterLevel, Env, Website } from './env';
import { COOKIE_VID, RATE_LIMIT_IP_PER_MIN, RATE_LIMIT_SITE_PER_MIN } from './env';
import { assignSessionId } from './session';
import { deriveCookielessVid, sha256Hex } from './util/crypto';
import { bareHost, hostOf, parseCookies, randomHex, serializeCookie, ulid } from './util/ids';
import { dayBucket } from './util/time';
import { parseUserAgent } from './util/ua';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

// 1x1 transparent GIF.
const ONE_PIXEL_GIF = Uint8Array.from(
  atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
  (c) => c.charCodeAt(0),
);

interface BeaconBody {
  v?: unknown;
  s?: unknown;
  e?: unknown;
  ts?: unknown;
  u?: unknown;
  p?: unknown;
  q?: unknown;
  r?: unknown;
  vid?: unknown;
  sid?: unknown;
  uid?: unknown;
  vw?: unknown;
  vh?: unknown;
  sw?: unknown;
  sh?: unknown;
  dpr?: unknown;
  lang?: unknown;
  tz?: unknown;
  bs?: unknown;
  pvid?: unknown;
  event_id?: unknown;
  gid?: unknown;
  props?: unknown;
}

interface Utm {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ error: { code: status, message, details: [{ code, message }] } }),
    { status, headers: { ...CORS, 'Content-Type': 'application/json' } },
  );
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

function normalizeLevel(level: string | null | undefined): BotFilterLevel {
  return level === 'off' || level === 'strict' ? level : 'standard';
}

function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For') ?? '127.0.0.1'
  );
}

function cfAsn(request: Request): number | null {
  const asn = request.cf?.asn;
  return typeof asn === 'number' ? asn : null;
}

function allowedHostsList(website: Website): string[] {
  return parseJsonArray(website.allowed_hosts);
}

function hostAllowed(host: string, website: Website): boolean {
  const bare = bareHost(host);
  const domain = bareHost(website.domain.toLowerCase());
  if (bare === domain) return true;
  const allowed = allowedHostsList(website).map((value) => bareHost(value.toLowerCase()));
  return allowed.includes(bare);
}

function parseUtm(query: string, pageUrl: string): Utm {
  const params = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(query)) params.set(key, value);
  try {
    for (const [key, value] of new URLSearchParams(new URL(pageUrl).search)) params.set(key, value);
  } catch {
    // Ignore an unparseable page URL; the host check already ran.
  }
  return {
    source: params.get('utm_source'),
    medium: params.get('utm_medium'),
    campaign: params.get('utm_campaign'),
    term: params.get('utm_term'),
    content: params.get('utm_content'),
  };
}

function computeEventId(body: BeaconBody, name: string, ts: number): string {
  const supplied = str(body.event_id);
  if (supplied) return supplied.slice(0, 128);
  const pvid = str(body.pvid) ?? ulid();
  if (name === 'pageview') return pvid.slice(0, 128);
  return `${pvid}:${name}:${ts}`.slice(0, 128);
}

async function getWebsite(env: Env, token: string): Promise<Website | null> {
  return env.DB.prepare('SELECT * FROM websites WHERE site_token = ?').bind(token).first<Website>();
}

async function readCounter(env: Env, key: string): Promise<number> {
  const raw = await env.KV.get(key);
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) ? value : 0;
}

/**
 * Fixed-window rate limiting in KV (ROADMAP D3): never a D1 write on the hot
 * path. Over-limit requests are silently accepted with 204 so a beacon retry
 * cannot loop, matching design/worker.md §5.1 rule 6.
 */
async function checkRateLimit(env: Env, websiteId: string, ip: string): Promise<boolean> {
  const window = Math.floor(Date.now() / 60000);
  const ipKey = `rl:ip:${websiteId}:${ip}:${window}`;
  const siteKey = `rl:site:${websiteId}:${window}`;

  const [ipCount, siteCount] = await Promise.all([
    readCounter(env, ipKey),
    readCounter(env, siteKey),
  ]);
  if (ipCount >= RATE_LIMIT_IP_PER_MIN || siteCount >= RATE_LIMIT_SITE_PER_MIN) {
    return false;
  }

  await Promise.all([
    env.KV.put(ipKey, String(ipCount + 1), { expirationTtl: 120 }),
    env.KV.put(siteKey, String(siteCount + 1), { expirationTtl: 120 }),
  ]);
  return true;
}

async function upsertIdentifiedUser(
  env: Env,
  websiteId: string,
  visitorId: string,
  identifiedUser: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO visitors (website_id, visitor_id, first_seen, last_seen, identified_user, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (website_id, visitor_id) DO UPDATE SET
       identified_user = CASE
         WHEN visitors.identified_user IS NULL THEN excluded.identified_user
         ELSE visitors.identified_user
       END,
       updated_at = excluded.updated_at`,
  )
    .bind(websiteId, visitorId, now, now, identifiedUser, now)
    .run();
}

async function readBeacon(
  request: Request,
  url: URL,
  wantsGif: boolean,
): Promise<BeaconBody | null> {
  const contentType = request.headers.get('content-type') ?? '';
  if (wantsGif || request.method === 'GET' || contentType.includes('image/gif')) {
    const params = url.searchParams;
    const body: BeaconBody = {};
    const numericKeys = new Set(['v', 'ts', 'vw', 'vh', 'sw', 'sh', 'dpr', 'bs']);
    const stringKeys = [
      's',
      'e',
      'u',
      'p',
      'q',
      'r',
      'vid',
      'sid',
      'uid',
      'lang',
      'tz',
      'pvid',
      'event_id',
      'gid',
    ];
    for (const key of stringKeys) {
      const value = params.get(key);
      if (value !== null) (body as Record<string, unknown>)[key] = value;
    }
    for (const key of numericKeys) {
      const value = params.get(key);
      if (value !== null && value !== '') (body as Record<string, unknown>)[key] = Number(value);
    }
    const props = params.get('props');
    if (props) {
      try {
        body.props = JSON.parse(props);
      } catch {
        body.props = {};
      }
    }
    return body;
  }

  const text = await request.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as BeaconBody;
  } catch {
    return null;
  }
}

/**
 * Ingestion endpoint shared by `POST /t`, `GET /p.gif`, and the legacy
 * `image/gif` form-post path. Returns 204 (or a 1x1 GIF) on success.
 */
export async function handleIngest(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === 'OPTIONS') return noContent();

  const isPixel = url.pathname.endsWith('/p.gif');
  const contentType = request.headers.get('content-type') ?? '';
  const wantsGif = isPixel || contentType.includes('image/gif');

  if (request.method !== 'POST' && !(wantsGif && request.method === 'GET')) {
    return jsonError(405, 'method_not_allowed', 'Use POST /t or GET /p.gif.');
  }

  const body = await readBeacon(request, url, wantsGif);
  if (!body) return jsonError(400, 'invalid_json', 'The beacon body is not valid JSON.');

  const siteToken = str(body.s);
  if (!siteToken) return jsonError(400, 'missing_site_token', 'Missing site token (s).');

  const website = await getWebsite(env, siteToken);
  if (!website) return jsonError(404, 'unknown_site', 'Unknown site token.');

  const pageUrl = str(body.u);
  const host = pageUrl ? hostOf(pageUrl) : null;
  if (!host) return jsonError(400, 'invalid_url', 'The page URL (u) is invalid.');
  if (!hostAllowed(host, website)) {
    return jsonError(400, 'host_not_allowed', 'The page host is not in allowed_hosts.');
  }

  const eventType = str(body.e);
  if (eventType !== 'pageview' && eventType !== 'event') {
    return jsonError(400, 'invalid_event_type', 'e must be "pageview" or "event".');
  }

  let name = 'pageview';
  let props: Record<string, unknown> = {};
  if (body.props && typeof body.props === 'object' && !Array.isArray(body.props)) {
    props = body.props as Record<string, unknown>;
  }
  if (eventType === 'event') {
    const eventName = str(props.name);
    if (!eventName)
      return jsonError(400, 'missing_event_name', 'props.name is required for custom events.');
    name = eventName.slice(0, 255);
  }

  const tsMs = num(body.ts);
  if (tsMs === null) return jsonError(400, 'invalid_ts', 'ts must be a number (epoch ms).');
  const ts = Math.round(tsMs / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(ts - now) > 24 * 3600) {
    return jsonError(400, 'ts_out_of_range', 'ts is more than 24 hours from server time.');
  }

  let path = str(body.p) ?? '/';
  if (path.length > 512) path = path.slice(0, 512);
  let query = str(body.q) ?? '';
  if (query.length > 512) query = query.slice(0, 512);
  const referrer = str(body.r);

  const cookies = parseCookies(request.headers.get('cookie'));
  const cookieVid = str(cookies[COOKIE_VID]);
  let visitorId = str(body.vid) ?? cookieVid;
  if (visitorId && visitorId.length > 128) visitorId = visitorId.slice(0, 128);
  const hadVisitorId = visitorId !== null;

  const ip = clientIp(request);
  const userAgent = request.headers.get('user-agent') ?? '';
  const level = normalizeLevel(website.bot_filter_level);

  const botDecision = evaluateBot({
    userAgent,
    accept: request.headers.get('accept'),
    acceptLanguage: request.headers.get('accept-language'),
    ip,
    path,
    visitorId,
    level,
    excludedIps: parseJsonArray(website.excluded_ips),
    excludedPaths: parseJsonArray(website.excluded_paths),
    excludedUa: parseJsonArray(website.excluded_ua),
    asn: cfAsn(request),
  });

  if (botDecision.isBot && level !== 'off') {
    return wantsGif
      ? new Response(ONE_PIXEL_GIF, {
          status: 200,
          headers: { ...CORS, 'Content-Type': 'image/gif' },
        })
      : noContent();
  }

  const allowed = await checkRateLimit(env, website.id, ip);
  if (!allowed) return noContent();

  if (!visitorId) {
    if (website.allow_cookieless) {
      visitorId = await deriveCookielessVid(
        env.INSTALL_SECRET,
        website.site_token,
        ip,
        userAgent,
        dayBucket(ts, website.timezone),
      );
    } else {
      visitorId = randomHex(16);
    }
  }

  const sessionId = await assignSessionId(env, website.id, visitorId, ts);

  const utm = parseUtm(query, pageUrl ?? '');
  const attribution = classifyAttribution({
    utmSource: utm.source,
    utmMedium: utm.medium,
    utmCampaign: utm.campaign,
    referrer,
    path,
    allowedHosts: allowedHostsList(website),
  });

  const uaInfo = parseUserAgent(userAgent);
  const eventId = computeEventId(body, name, ts);
  const rawBs = num(body.bs);
  const botScore = rawBs === null ? 0 : Math.max(0, Math.min(100, Math.round(rawBs)));

  const result = await env.DB.prepare(
    `INSERT INTO events (
       id, website_id, event_id, session_id, visitor_id, name, ts, path, query, referrer,
       channel, channel_name, direct_type,
       utm_source, utm_medium, utm_campaign, utm_term, utm_content,
       country, region, city, colo,
       device_type, os, browser,
       viewport_w, viewport_h, screen_width, screen_height, dpr,
       language, tz, is_bot, bot_score, bot_reason, group_id, consent, props, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (website_id, event_id) DO NOTHING`,
  )
    .bind(
      ulid(),
      website.id,
      eventId,
      sessionId,
      visitorId,
      name,
      ts,
      path,
      query || null,
      referrer,
      attribution.channel,
      attribution.channel_name,
      attribution.direct_type,
      utm.source,
      utm.medium,
      utm.campaign,
      utm.term,
      utm.content,
      request.cf?.country ?? null,
      request.cf?.region ?? null,
      request.cf?.city ?? null,
      request.cf?.colo ?? null,
      uaInfo.device_type,
      uaInfo.os,
      uaInfo.browser,
      num(body.vw),
      num(body.vh),
      num(body.sw),
      num(body.sh),
      num(body.dpr),
      str(body.lang),
      str(body.tz),
      botDecision.isBot ? 1 : 0,
      botScore,
      botDecision.reason,
      str(body.gid),
      website.privacy_mode === 'cookieless' ? null : 1,
      JSON.stringify(props),
      now,
    )
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    return wantsGif
      ? new Response(ONE_PIXEL_GIF, {
          status: 200,
          headers: { ...CORS, 'Content-Type': 'image/gif' },
        })
      : noContent();
  }

  const uid = str(body.uid);
  if (uid) {
    const identifiedUser = /^[0-9a-f]{64}$/i.test(uid)
      ? uid.toLowerCase()
      : await sha256Hex(uid + env.INSTALL_SECRET);
    await upsertIdentifiedUser(env, website.id, visitorId, identifiedUser);
  }

  if (wantsGif) {
    const headers = new Headers({ ...CORS, 'Content-Type': 'image/gif' });
    if (!hadVisitorId && visitorId) {
      headers.set(
        'Set-Cookie',
        serializeCookie(COOKIE_VID, visitorId, {
          maxAge: 365 * 24 * 3600,
          sameSite: 'Lax',
          secure: url.protocol === 'https:',
        }),
      );
    }
    return new Response(ONE_PIXEL_GIF, { status: 200, headers });
  }

  return noContent();
}
