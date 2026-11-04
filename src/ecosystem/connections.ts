/**
 * provider_connections rows for the Shopify app and the WooCommerce connect flow. W3's adapters
 * read these rows (credential shapes are documented in docs/api/contract.md §13).
 */
import { decryptJson, encryptJson, encryptString } from "../lib/crypto";

export type EcosystemProvider = "shopify" | "woocommerce";

export function connectionAad(provider: EcosystemProvider, siteId: string): string {
  return `provider:${provider}:${siteId}`;
}

export interface ConnectionInput {
  siteId: string;
  provider: EcosystemProvider;
  credentials: Record<string, unknown>;
  /** Secret that signs this provider's webhooks to DataGoat. */
  webhookSecret: string | null;
  status: "active" | "error" | "pending";
  accountId: string;
  accountName: string | null;
  currency: string | null;
  settings: Record<string, unknown>;
  lastError?: string | null;
}

export async function upsertConnection(
  env: Cloudflare.Env,
  input: ConnectionInput,
  now = Date.now(),
): Promise<void> {
  const aad = connectionAad(input.provider, input.siteId);
  await env.DB.prepare(
    `INSERT INTO provider_connections (site_id, provider, credentials_enc, webhook_secret_enc, status,
       account_id, account_name, currency, settings, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_id, provider) DO UPDATE SET
       credentials_enc = excluded.credentials_enc, webhook_secret_enc = excluded.webhook_secret_enc,
       status = excluded.status, account_id = excluded.account_id,
       account_name = excluded.account_name, currency = excluded.currency,
       settings = excluded.settings, last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  )
    .bind(
      input.siteId,
      input.provider,
      await encryptJson(env.ENCRYPTION_KEY, input.credentials, aad),
      input.webhookSecret
        ? await encryptString(env.ENCRYPTION_KEY, input.webhookSecret, aad)
        : null,
      input.status,
      input.accountId,
      input.accountName,
      input.currency,
      JSON.stringify(input.settings),
      input.lastError ?? null,
      now,
      now,
    )
    .run();
}

export interface StoredConnection<C> {
  siteId: string;
  status: string;
  accountId: string | null;
  credentials: C;
  settings: Record<string, unknown>;
}

export async function loadConnection<C>(
  env: Cloudflare.Env,
  provider: EcosystemProvider,
  siteId: string,
): Promise<StoredConnection<C> | null> {
  const row = await env.DB.prepare(
    "SELECT site_id, status, account_id, credentials_enc, settings FROM provider_connections WHERE site_id = ? AND provider = ?",
  )
    .bind(siteId, provider)
    .first<{
      site_id: string;
      status: string;
      account_id: string | null;
      credentials_enc: string;
      settings: string;
    }>();
  if (!row) return null;
  return {
    siteId: row.site_id,
    status: row.status,
    accountId: row.account_id,
    credentials: await decryptJson<C>(
      env.ENCRYPTION_KEY,
      row.credentials_enc,
      connectionAad(provider, siteId),
    ),
    settings: JSON.parse(row.settings || "{}") as Record<string, unknown>,
  };
}
