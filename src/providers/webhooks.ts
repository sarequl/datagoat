/**
 * Provider webhooks: `POST /webhooks/<provider>/:siteId` (one explicit route per provider; W6 owns
 * `/webhooks/github/:siteId`).
 *
 * Order of work: find the website and its connection → read the raw body (≤ 1 MB) → verify the
 * signature with the stored secret BEFORE parsing → dedupe on `(provider, siteId:eventId)` in
 * `webhook_events` → normalise → ingest. Answers 200 `{received: true}`; duplicates answer 200
 * `{received: true, duplicate: true}`. A failed ingest releases the dedupe row and answers 500 so
 * the provider retries. Unknown website or no connection → 404; no secret configured → 400;
 * bad signature → 401.
 *
 * `processWebhook()` is exported for W8's Shopify app webhook endpoint, which verifies the app
 * signature itself and hands the payload over.
 */
import { Hono } from "hono";
import { ApiError } from "../lib/errors";
import { errorFields, log } from "../lib/log";
import { siteCache } from "../lib/site-cache";
import type { AppEnv } from "../types";
import { ADAPTERS } from "./adapters";
import { decryptConnection, loadConnectionRow } from "./connections";
import { ingestBatch } from "./engine";
import { batchSize, PROVIDER_IDS, type ProviderId, type VerifiedWebhook } from "./types";

export const webhookRoutes = new Hono<AppEnv>();

const MAX_BODY = 1024 * 1024;

export interface WebhookOutcome {
  duplicate: boolean;
  payments: number;
}

/** Dedupe and ingest an already verified webhook for a connected provider. */
export async function processWebhook(
  env: Cloudflare.Env,
  siteId: string,
  provider: ProviderId,
  webhook: VerifiedWebhook,
  now = Date.now(),
): Promise<WebhookOutcome> {
  const db = env.DB;
  const site = await siteCache.byId(db, siteId);
  if (!site) throw new ApiError(404, "Website not found");
  const row = await loadConnectionRow(db, siteId, provider);
  if (!row || row.status === "disconnected")
    throw new ApiError(404, `${ADAPTERS[provider].displayName} is not connected to this website`);
  const conn = await decryptConnection(env, row);
  const eventKey = `${siteId}:${webhook.eventId || crypto.randomUUID()}`;
  const claim = await db
    .prepare(
      "INSERT INTO webhook_events (provider, event_id, site_id, received_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    )
    .bind(provider, eventKey, siteId, now)
    .run();
  if ((claim.meta.changes ?? 0) === 0) return { duplicate: true, payments: 0 };
  try {
    const batch = ADAPTERS[provider].normalizeWebhook(webhook, conn);
    if (!batchSize(batch)) return { duplicate: false, payments: 0 };
    const res = await ingestBatch(db, batch, {
      site,
      provider,
      source: "webhook",
      now,
      planChangesFromRenewals: ADAPTERS[provider].planChangesFromRenewals,
    });
    return { duplicate: false, payments: res.payments.length };
  } catch (err) {
    await db
      .prepare("DELETE FROM webhook_events WHERE provider = ? AND event_id = ?")
      .bind(provider, eventKey)
      .run()
      .catch(() => undefined);
    throw err;
  }
}

for (const provider of PROVIDER_IDS) {
  const adapter = ADAPTERS[provider];
  webhookRoutes.post(`/webhooks/${provider}/:siteId`, async (c) => {
    const siteId = c.req.param("siteId");
    const db = c.env.DB;
    const site = await siteCache.byId(db, siteId);
    if (!site) throw new ApiError(404, "Website not found");
    const row = await loadConnectionRow(db, site.id, provider);
    if (!row || row.status === "disconnected")
      throw new ApiError(404, `${adapter.displayName} is not connected to this website`);
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_BODY) throw new ApiError(413, "Webhook body too large");
    const rawBody = await c.req.text();
    if (rawBody.length > MAX_BODY) throw new ApiError(413, "Webhook body too large");
    const conn = await decryptConnection(c.env, row);
    if (!conn.webhookSecret) {
      throw new ApiError(
        400,
        `No webhook signing secret is configured for ${adapter.displayName}. Add it in the integration settings.`,
      );
    }
    const now = Date.now();
    let verified: VerifiedWebhook | null = null;
    try {
      verified = await adapter.verifyWebhook(rawBody, c.req.raw.headers, conn.webhookSecret, now);
    } catch {
      verified = null; // malformed JSON after a valid signature, or a bad header
    }
    if (!verified) throw new ApiError(401, "Invalid webhook signature");
    try {
      const outcome = await processWebhook(c.env, site.id, provider, verified, now);
      return c.json(outcome.duplicate ? { received: true, duplicate: true } : { received: true });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      log.error("providers.webhook_failed", { provider, ...errorFields(err) });
      throw new ApiError(500, "Webhook processing failed; it will be retried");
    }
  });
}
