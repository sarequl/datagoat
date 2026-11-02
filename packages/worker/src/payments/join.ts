import type { Env } from '../env';
import { ulid } from '../util/ids';
import type { JoinMethod, PaymentEvent } from './types';

export interface JoinResult {
  visitorId: string | null;
  sessionId: string | null;
  joinMethod: JoinMethod;
  confidence: number;
}

/**
 * Four-way payment -> visitor join, first match wins (design/attribution.md §6.1).
 * 1. `metadata`        — explicit checkout handoff, confidence 1.0.
 * 2. `provider_customer` — provider customer id link, confidence 0.9.
 * 3. `email`           — email link, confidence 0.7.
 * 4. `unresolved`      — stored unattributed and queued for back-fill (§9.2).
 */
export async function resolvePaymentVisitor(
  env: Env,
  websiteId: string,
  event: PaymentEvent,
): Promise<JoinResult> {
  if (event.visitor_id) {
    return {
      visitorId: event.visitor_id,
      sessionId: event.session_id,
      joinMethod: 'metadata',
      confidence: 1.0,
    };
  }

  if (event.provider_customer_id) {
    const row = await env.DB.prepare(
      `SELECT visitor_id FROM customers
       WHERE website_id = ? AND provider = ? AND provider_customer_id = ? AND visitor_id IS NOT NULL
       ORDER BY last_seen_at DESC LIMIT 1`,
    )
      .bind(websiteId, event.provider, event.provider_customer_id)
      .first<{ visitor_id: string }>();
    if (row?.visitor_id) {
      return {
        visitorId: row.visitor_id,
        sessionId: null,
        joinMethod: 'provider_customer',
        confidence: 0.9,
      };
    }
  }

  if (event.email) {
    const row = await env.DB.prepare(
      `SELECT visitor_id FROM customers
       WHERE website_id = ? AND email = ? AND visitor_id IS NOT NULL
       ORDER BY last_seen_at DESC LIMIT 1`,
    )
      .bind(websiteId, event.email)
      .first<{ visitor_id: string }>();
    if (row?.visitor_id) {
      return { visitorId: row.visitor_id, sessionId: null, joinMethod: 'email', confidence: 0.7 };
    }
  }

  return { visitorId: null, sessionId: null, joinMethod: 'unresolved', confidence: 0 };
}

/**
 * Writes the identity bridge (§1.4). `customers` keeps the active mapping for
 * the email and provider-customer lookup paths; `customer_links` keeps the
 * full history so LTV can be re-computed under a different merge policy.
 */
export async function linkCustomer(
  env: Env,
  websiteId: string,
  event: PaymentEvent,
  visitorId: string | null,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const email = event.email;
  const providerCustomerId = event.provider_customer_id;
  if (!email && !providerCustomerId) return;

  // One upsert, not two: `customers` has two unique indexes (email and
  // provider_customer_id). Two statements each with their own conflict target
  // would insert a row that then violates the *other* index (e.g. an email
  // miss with a known provider_customer_id). A target-less upsert resolves
  // whichever unique key already holds this identity and coalesces the rest.
  await env.DB.prepare(
    `INSERT INTO customers (id, website_id, email, visitor_id, provider, provider_customer_id, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET
       visitor_id = COALESCE(excluded.visitor_id, customers.visitor_id),
       email = COALESCE(excluded.email, customers.email),
       provider_customer_id = COALESCE(excluded.provider_customer_id, customers.provider_customer_id),
       last_seen_at = excluded.last_seen_at`,
  )
    .bind(ulid(), websiteId, email, visitorId, event.provider, providerCustomerId, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO customer_links (id, website_id, email, visitor_id, provider, provider_customer_id, linked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(ulid(), websiteId, email, visitorId, event.provider, providerCustomerId, now)
    .run();
}
