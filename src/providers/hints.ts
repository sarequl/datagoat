/**
 * Helpers other teams call from the ingest path (W1), so payment references and payment emails
 * seen by the tracker reach the revenue engine without W1 knowing its internals.
 *
 * - `paymentHintStatement()`: the `INSERT OR IGNORE INTO payment_hints` statement for a tracker
 *   `payment` event with `{stripe_session_id}`, `{polar_checkout_id}`, `{lemonsqueezy_order_id}`
 *   (DataFast's three) or DataGoat's extra references. Add it to the ingest `db.batch()`
 *   (1 row + 1 partial-index entry); the `providers.resolve-hints` cron resolves it.
 * - `hintFromExtraData()`: maps the event's `extraData` to `{provider, ref}`.
 * - `attributeByEmail()`: after storing a visitor's email hash (identify / payment `{email}`),
 *   attribute that site's unattributed payments with the same email (run it in `waitUntil`).
 */
import { siteCache } from "../lib/site-cache";
import { emailHash } from "./attribution";
import { ingestBatch } from "./engine";
import type { ProviderId } from "./types";

/** Tracker `extraData` keys → provider. DataFast's script sends the first three. */
export const HINT_KEYS: Record<string, ProviderId> = {
  stripe_session_id: "stripe",
  polar_checkout_id: "polar",
  lemonsqueezy_order_id: "lemonsqueezy",
  paddle_transaction_id: "paddle",
  dodo_payment_id: "dodo",
  creem_checkout_id: "creem",
};

const REF_RE = /^[A-Za-z0-9_\-:.]{1,200}$/;

export function hintFromExtraData(
  extraData: Record<string, unknown> | null | undefined,
): { provider: ProviderId; ref: string } | null {
  if (!extraData) return null;
  for (const [key, provider] of Object.entries(HINT_KEYS)) {
    const v = extraData[key];
    const ref = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
    if (ref && REF_RE.test(ref)) return { provider, ref };
  }
  return null;
}

export function paymentHintStatement(
  db: D1Database,
  hint: { siteId: string; provider: ProviderId; ref: string; visitorId: string; sessionId: string },
  now = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO payment_hints (site_id, provider, ref, visitor_id, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(hint.siteId, hint.provider, hint.ref, hint.visitorId, hint.sessionId, now);
}

/**
 * Attribute unattributed payments of `siteId` whose customer email equals `email` to `visitorId`
 * (attributed_via `email`). Costs one indexed read when nothing matches.
 */
export async function attributeByEmail(
  env: Pick<Cloudflare.Env, "DB">,
  siteId: string,
  visitorId: string,
  email: string,
  now = Date.now(),
): Promise<number> {
  const hash = await emailHash(email);
  if (!hash) return 0;
  const db = env.DB;
  const res = await db
    .prepare(
      `SELECT provider, provider_txn_id, provider_customer_id, occurred_at FROM payments
       WHERE site_id = ? AND email_hash = ? AND visitor_id IS NULL LIMIT 50`,
    )
    .bind(siteId, hash)
    .all<{
      provider: string;
      provider_txn_id: string;
      provider_customer_id: string | null;
      occurred_at: number;
    }>();
  const rows = res.results ?? [];
  if (!rows.length) return 0;
  const site = await siteCache.byId(db, siteId);
  if (!site) return 0;
  let attributed = 0;
  const providers = [...new Set(rows.map((r) => r.provider))];
  for (const provider of providers) {
    const list = rows.filter((r) => r.provider === provider);
    const out = await ingestBatch(
      db,
      {
        payments: [],
        subscriptions: [],
        customers: list.map((r) => ({
          customerId: r.provider_customer_id ?? undefined,
          visitorId,
          visitorVia: "email",
          occurredAt: r.occurred_at,
          attachTxnIds: [r.provider_txn_id],
        })),
      },
      { site, provider: provider as ProviderId, source: "import", now },
    );
    attributed += out.statements > 0 ? list.length : 0;
  }
  return attributed;
}
