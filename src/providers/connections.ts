/**
 * Provider connections: encrypted credentials at rest (AES-GCM with ENCRYPTION_KEY, AAD
 * `provider:<provider>:<siteId>`; webhook secrets use `provider:<provider>:<siteId>:webhook`),
 * status, and the sync cursors in `provider_sync_state`.
 *
 * Other teams create connections through `saveConnection()` (W8's Shopify app and WooCommerce
 * plugin flows); nothing outside this module reads the ciphertext.
 */
import { decryptJson, decryptString, encryptJson, encryptString } from "../lib/crypto";
import { parseJsonColumn } from "../lib/d1";
import type { Connection, ProviderId } from "./types";

export const credentialsAad = (provider: string, siteId: string) =>
  `provider:${provider}:${siteId}`;
export const webhookAad = (provider: string, siteId: string) =>
  `provider:${provider}:${siteId}:webhook`;

export interface ConnectionRow {
  site_id: string;
  provider: string;
  credentials_enc: string;
  webhook_secret_enc: string | null;
  status: Connection["status"];
  account_id: string | null;
  account_name: string | null;
  currency: string | null;
  settings: string;
  key_expires_at: number | null;
  last_synced_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export async function decryptConnection(
  env: Pick<Cloudflare.Env, "ENCRYPTION_KEY">,
  row: ConnectionRow,
): Promise<Connection> {
  const provider = row.provider as ProviderId;
  const credentials = row.credentials_enc
    ? await decryptJson<Record<string, string>>(
        env.ENCRYPTION_KEY,
        row.credentials_enc,
        credentialsAad(provider, row.site_id),
      )
    : {};
  const webhookSecret = row.webhook_secret_enc
    ? await decryptString(
        env.ENCRYPTION_KEY,
        row.webhook_secret_enc,
        webhookAad(provider, row.site_id),
      )
    : null;
  return {
    siteId: row.site_id,
    provider,
    credentials,
    webhookSecret,
    settings: parseJsonColumn<Record<string, unknown>>(row.settings, {}),
    accountId: row.account_id,
    accountName: row.account_name,
    currency: row.currency,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadConnectionRow(
  db: D1Database,
  siteId: string,
  provider: string,
): Promise<ConnectionRow | null> {
  return db
    .prepare("SELECT * FROM provider_connections WHERE site_id = ? AND provider = ?")
    .bind(siteId, provider)
    .first<ConnectionRow>();
}

export async function loadConnection(
  env: Cloudflare.Env,
  siteId: string,
  provider: ProviderId,
): Promise<Connection | null> {
  const row = await loadConnectionRow(env.DB, siteId, provider);
  return row ? decryptConnection(env, row) : null;
}

export interface SaveConnectionInput {
  siteId: string;
  provider: ProviderId;
  credentials: Record<string, string>;
  webhookSecret?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  currency?: string | null;
  settings?: Record<string, unknown>;
  keyExpiresAt?: number | null;
  status?: Connection["status"];
  now?: number;
  /** Start (or restart) the historical backfill. Default true. */
  backfill?: boolean;
  /** Initial polling cursor (e.g. the newest Stripe event id at connect time). */
  syncCursor?: string | null;
}

/**
 * Create or replace a connection (encrypting its secrets) and reset its sync state, in one batch.
 * Exported for W8 (Shopify app install, WooCommerce plugin connect).
 */
export async function saveConnection(
  env: Pick<Cloudflare.Env, "DB" | "ENCRYPTION_KEY">,
  input: SaveConnectionInput,
): Promise<void> {
  const now = input.now ?? Date.now();
  const credentialsEnc = await encryptJson(
    env.ENCRYPTION_KEY,
    input.credentials,
    credentialsAad(input.provider, input.siteId),
  );
  const webhookEnc = input.webhookSecret
    ? await encryptString(
        env.ENCRYPTION_KEY,
        input.webhookSecret,
        webhookAad(input.provider, input.siteId),
      )
    : null;
  const db = env.DB;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO provider_connections (site_id, provider, credentials_enc, webhook_secret_enc, status, account_id,
           account_name, currency, settings, key_expires_at, last_synced_at, last_error, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?11, ?11)
         ON CONFLICT (site_id, provider) DO UPDATE SET credentials_enc = excluded.credentials_enc,
           webhook_secret_enc = excluded.webhook_secret_enc, status = excluded.status,
           account_id = excluded.account_id, account_name = excluded.account_name,
           currency = excluded.currency, settings = excluded.settings,
           key_expires_at = excluded.key_expires_at, last_synced_at = excluded.last_synced_at,
           last_error = NULL, updated_at = excluded.updated_at`,
      )
      .bind(
        input.siteId,
        input.provider,
        credentialsEnc,
        webhookEnc,
        input.status ?? "active",
        input.accountId ?? null,
        input.accountName ?? null,
        input.currency ?? null,
        JSON.stringify(input.settings ?? {}),
        input.keyExpiresAt ?? null,
        now,
      ),
    db
      .prepare("DELETE FROM provider_sync_state WHERE site_id = ? AND provider = ?")
      .bind(input.siteId, input.provider),
  ];
  if (input.syncCursor !== undefined) {
    stmts.push(syncStateUpsert(db, input.siteId, input.provider, "sync", input.syncCursor, 0, now));
  }
  if (input.backfill !== false) {
    stmts.push(syncStateUpsert(db, input.siteId, input.provider, "backfill", null, 0, now));
  }
  await db.batch(stmts);
}

/** Replace only the webhook secret (e.g. after the operator pastes it, or auto-setup). */
export async function saveWebhookSecret(
  env: Pick<Cloudflare.Env, "DB" | "ENCRYPTION_KEY">,
  siteId: string,
  provider: ProviderId,
  secret: string | null,
  settingsPatch: Record<string, unknown> = {},
  now = Date.now(),
): Promise<void> {
  const enc = secret
    ? await encryptString(env.ENCRYPTION_KEY, secret, webhookAad(provider, siteId))
    : null;
  await env.DB.prepare(
    `UPDATE provider_connections SET webhook_secret_enc = ?, settings = json_patch(settings, ?), updated_at = ?
     WHERE site_id = ? AND provider = ?`,
  )
    .bind(enc, JSON.stringify(settingsPatch), now, siteId, provider)
    .run();
}

export function syncStateUpsert(
  db: D1Database,
  siteId: string,
  provider: string,
  stream: string,
  cursor: string | null,
  done: number,
  now: number,
  lastError: string | null = null,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO provider_sync_state (site_id, provider, stream, cursor, done, last_run_at, last_error, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6)
       ON CONFLICT (site_id, provider, stream) DO UPDATE SET cursor = excluded.cursor, done = excluded.done,
         last_run_at = excluded.last_run_at, last_error = excluded.last_error, updated_at = excluded.updated_at`,
    )
    .bind(siteId, provider, stream, cursor, done, now, lastError);
}

/** Remove a connection and its cursors; payments, customers and subscriptions are kept. */
export async function deleteConnection(
  db: D1Database,
  siteId: string,
  provider: ProviderId,
): Promise<boolean> {
  const res = await db.batch([
    db
      .prepare("DELETE FROM provider_connections WHERE site_id = ? AND provider = ?")
      .bind(siteId, provider),
    db
      .prepare("DELETE FROM provider_sync_state WHERE site_id = ? AND provider = ?")
      .bind(siteId, provider),
  ]);
  return (res[0]?.meta.changes ?? 0) > 0;
}

export interface SyncStateRow {
  site_id: string;
  provider: string;
  stream: string;
  cursor: string | null;
  done: number;
  last_run_at: number | null;
  last_error: string | null;
  updated_at: number;
}
