/**
 * Test data factories. Every factory writes straight to D1 (no HTTP) and returns what tests
 * need to act as that entity. Defaults are realistic and unique per call.
 */
import { env } from "cloudflare:test";
import type { Grant, Role } from "../../shared/permissions";
import { displayKeyOf, generateSecret, hashSecret, keyPrefixOf } from "../../src/auth/credentials";
import { hashSessionToken, SESSION_COOKIE, signSessionToken } from "../../src/auth/sessions";
import { hashPassword } from "../../src/lib/crypto";
import { newId, newTrackingId, randomToken, uuidv4 } from "../../src/lib/ids";
import { loadSiteById, type Site } from "../../src/lib/sites";

let seq = 0;
const next = () => ++seq;

export interface TestUser {
  id: string;
  email: string;
  password: string;
  name: string | null;
}

export async function createUser(overrides: Partial<Omit<TestUser, "id">> = {}): Promise<TestUser> {
  const n = next();
  const user = {
    id: newId(),
    email: overrides.email ?? `user${n}@example.com`,
    password: overrides.password ?? `correct-horse-${n}`,
    name: overrides.name === undefined ? `User ${n}` : overrides.name,
  };
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, name, created_at, updated_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(user.id, user.email, await hashPassword(user.password, 10_000), user.name, now, now, now)
    .run();
  return user;
}

export interface SiteOverrides {
  domain?: string;
  name?: string | null;
  timezone?: string;
  currency?: string;
  publicId?: string;
  privacyMode?: "cookie" | "cookieless" | "consent";
  attributionModel?: "first_touch" | "last_touch" | "last_non_direct";
  includeRenewalRevenue?: boolean;
}

export async function createSite(
  ownerId: string | null,
  overrides: SiteOverrides = {},
): Promise<Site> {
  const n = next();
  const id = newId();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sites (id, public_id, domain, name, timezone, currency, privacy_mode, attribution_model,
       include_renewal_revenue, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      overrides.publicId ?? newTrackingId(),
      overrides.domain ?? `site${n}.example.com`,
      overrides.name === undefined ? `Site ${n}` : overrides.name,
      overrides.timezone ?? "UTC",
      overrides.currency ?? "USD",
      overrides.privacyMode ?? "cookie",
      overrides.attributionModel ?? "first_touch",
      overrides.includeRenewalRevenue === false ? 0 : 1,
      ownerId,
      now,
      now,
    )
    .run();
  if (ownerId) await addMember(id, ownerId, "owner");
  const site = await loadSiteById(env.DB, id);
  if (!site) throw new Error("site not created");
  return site;
}

export async function addMember(siteId: string, userId: string, role: Role): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO memberships (site_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (site_id, user_id) DO UPDATE SET role = excluded.role",
  )
    .bind(siteId, userId, role, Date.now())
    .run();
}

export interface KeyOptions {
  userId: string;
  siteId?: string;
  permissions?: Grant[];
  websiteIds?: string[];
  includePii?: boolean;
  expiresAt?: number | null;
  /** Use this secret instead of a new one (e.g. a `df_` key made before the rename). */
  secret?: string;
}

/** Create a website key (when siteId is set) or account token. Returns the raw secret. */
export async function createApiKey(options: KeyOptions): Promise<{ id: string; secret: string }> {
  const kind = options.siteId ? "df" : "dft";
  const secret = options.secret ?? generateSecret(kind);
  const id = newId();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO api_keys (id, kind, site_id, user_id, name, key_hash, key_prefix, display_key, permissions,
       website_ids, include_pii, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      kind,
      options.siteId ?? null,
      options.userId,
      `${kind} key`,
      await hashSecret(secret),
      keyPrefixOf(secret),
      displayKeyOf(secret),
      JSON.stringify(options.permissions ?? ["*"]),
      JSON.stringify(options.websiteIds ?? (options.siteId ? [options.siteId] : [])),
      options.includePii ? 1 : 0,
      options.expiresAt ?? null,
      now,
      now,
    )
    .run();
  return { id, secret };
}

/** Create a dashboard session for a user and return the Cookie header value. */
export async function sessionCookie(userId: string): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO auth_sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(await hashSessionToken(token), userId, now, now + 86_400_000)
    .run();
  return `${SESSION_COOKIE}=${await signSessionToken(env, token)}`;
}

// ---------------------------------------------------------------------------
// Analytics data
// ---------------------------------------------------------------------------

export interface SessionInput {
  siteId: string;
  visitorId?: string;
  id?: string;
  startedAt: number;
  durationMs?: number;
  sessionNumber?: number | null;
  pageviews?: number;
  interactions?: number;
  entryPath?: string;
  hostname?: string;
  channel?: string;
  source?: string | null;
  referrerDomain?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  device?: string | null;
  browser?: string | null;
  os?: string | null;
  utm?: Partial<
    Record<"utm_source" | "utm_medium" | "utm_campaign" | "utm_term" | "utm_content", string>
  >;
  ref?: string | null;
  sourceParam?: string | null;
  via?: string | null;
}

export interface CreatedSession {
  id: string;
  visitorId: string;
  startedAt: number;
}

/** Insert a visitor (if new) and a session. Pageview events are added with `createEvent`. */
export async function createSession(input: SessionInput): Promise<CreatedSession> {
  const visitorId = input.visitorId ?? uuidv4();
  const id = input.id ?? `s${uuidv4()}`;
  const end = input.startedAt + (input.durationMs ?? 0);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO visitors (site_id, id, first_seen_at, first_session_id) VALUES (?, ?, ?, ?)",
    ).bind(input.siteId, visitorId, input.startedAt, id),
    env.DB.prepare(
      `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, session_number, cookieless, hostname,
         entry_path, exit_path, pageviews, interactions, referrer_domain, channel, source, utm_source, utm_medium,
         utm_campaign, utm_term, utm_content, ref, source_param, via, country, region, city, device, browser, os)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.siteId,
      id,
      visitorId,
      input.startedAt,
      end,
      input.sessionNumber === undefined ? 1 : input.sessionNumber,
      input.sessionNumber === null ? 1 : 0,
      input.hostname ?? "example.com",
      input.entryPath ?? "/",
      input.entryPath ?? "/",
      input.pageviews ?? 1,
      input.interactions ?? 0,
      input.referrerDomain ?? null,
      input.channel ?? "Direct",
      input.source ?? null,
      input.utm?.utm_source ?? null,
      input.utm?.utm_medium ?? null,
      input.utm?.utm_campaign ?? null,
      input.utm?.utm_term ?? null,
      input.utm?.utm_content ?? null,
      input.ref ?? null,
      input.sourceParam ?? null,
      input.via ?? null,
      input.country ?? null,
      input.region ?? null,
      input.city ?? null,
      input.device ?? null,
      input.browser ?? null,
      input.os ?? null,
    ),
  ]);
  return { id, visitorId, startedAt: input.startedAt };
}

export interface EventInput {
  siteId: string;
  session: CreatedSession;
  type?: "pageview" | "custom" | "identify" | "payment" | "external_link";
  ts?: number;
  path?: string;
  hostname?: string;
  name?: string | null;
  props?: Record<string, unknown> | null;
}

export async function createEvent(input: EventInput): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO events (site_id, ts, session_id, visitor_id, type, hostname, path, name, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      input.siteId,
      input.ts ?? input.session.startedAt,
      input.session.id,
      input.session.visitorId,
      input.type ?? "pageview",
      input.hostname ?? "example.com",
      input.path ?? "/",
      input.name ?? null,
      input.props ? JSON.stringify(input.props) : null,
    )
    .run();
}

export interface PaymentInput {
  siteId: string;
  amountMinor: number;
  currency?: string;
  kind?: "payment" | "renewal" | "refund" | "free_trial";
  occurredAt: number;
  visitorId?: string | null;
  firstSessionId?: string | null;
  lastSessionId?: string | null;
  lastNonDirectSessionId?: string | null;
  provider?: string;
  attributedVia?: "metadata" | "link" | "customer" | "email" | "api" | "none";
}

export async function createPayment(input: PaymentInput): Promise<string> {
  const id = newId();
  const now = Date.now();
  const currency = input.currency ?? "USD";
  await env.DB.prepare(
    `INSERT INTO payments (site_id, id, provider, provider_txn_id, kind, amount_minor, currency, reporting_minor,
       reporting_currency, visitor_id, first_session_id, last_session_id, last_non_direct_session_id, attributed_via,
       source, occurred_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', ?, ?, ?)`,
  )
    .bind(
      input.siteId,
      id,
      input.provider ?? "api",
      `txn_${id}`,
      input.kind ?? "payment",
      input.amountMinor,
      currency,
      input.amountMinor,
      currency,
      input.visitorId ?? null,
      input.firstSessionId ?? null,
      input.lastSessionId ?? input.firstSessionId ?? null,
      input.lastNonDirectSessionId ?? input.firstSessionId ?? null,
      input.attributedVia ?? (input.visitorId ? "api" : "none"),
      input.occurredAt,
      now,
      now,
    )
    .run();
  return id;
}
