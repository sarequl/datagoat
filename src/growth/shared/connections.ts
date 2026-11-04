/**
 * `integration_connections` rows for the growth integrations (GitHub, Google Search Console,
 * Meta Ads, X). Credentials are AES-GCM encrypted with the `integration:<kind>:<siteId>` AAD so a
 * value copied to another row or kind fails to decrypt. Settings are plain JSON (repo, property,
 * ad accounts, keywords, handles); the cursor is JSON owned by the kind's sync job.
 */
import { decryptJson, encryptJson } from "../../lib/crypto";
import { parseJsonColumn } from "../../lib/d1";

export type IntegrationKind = "github" | "gsc" | "meta_ads" | "x";
export type ConnectionStatus = "active" | "error" | "disconnected" | "pending";

/** URL slug used by the API (`/integrations/<slug>`, `/api/connect/<slug>`) for each kind. */
export const KIND_SLUGS: Record<IntegrationKind, string> = {
  github: "github",
  gsc: "google-search-console",
  meta_ads: "meta-ads",
  x: "x",
};

export function kindFromSlug(slug: string): IntegrationKind | null {
  for (const [kind, s] of Object.entries(KIND_SLUGS))
    if (s === slug) return kind as IntegrationKind;
  return null;
}

export interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string | null;
  /** Epoch ms when the access token expires; null = long-lived. */
  expiresAt?: number | null;
  scope?: string | null;
  /** How the credential was obtained. */
  via?: "oauth" | "token";
}

export interface Connection<S = Record<string, unknown>, C = Record<string, unknown>> {
  siteId: string;
  kind: IntegrationKind;
  status: ConnectionStatus;
  settings: S;
  cursor: C;
  hasCredentials: boolean;
  credentialsEnc: string | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

function aad(kind: IntegrationKind, siteId: string): string {
  return `integration:${kind}:${siteId}`;
}

export function rowToConnection<S, C>(row: Record<string, unknown>): Connection<S, C> {
  return {
    siteId: String(row.site_id),
    kind: row.kind as IntegrationKind,
    status: row.status as ConnectionStatus,
    settings: parseJsonColumn<S>(row.settings, {} as S),
    cursor: parseJsonColumn<C>(row.cursor, {} as C),
    hasCredentials: typeof row.credentials_enc === "string" && row.credentials_enc !== "",
    credentialsEnc: (row.credentials_enc as string | null) ?? null,
    lastSyncedAt: (row.last_synced_at as number | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function getConnection<S = Record<string, unknown>, C = Record<string, unknown>>(
  db: D1Database,
  siteId: string,
  kind: IntegrationKind,
): Promise<Connection<S, C> | null> {
  const row = await db
    .prepare("SELECT * FROM integration_connections WHERE site_id = ? AND kind = ?")
    .bind(siteId, kind)
    .first<Record<string, unknown>>();
  return row ? rowToConnection<S, C>(row) : null;
}

/** Active connections of one kind on live sites, oldest sync first (fair rotation). */
export async function listActiveConnections<S, C>(
  db: D1Database,
  kind: IntegrationKind,
  limit: number,
): Promise<Connection<S, C>[]> {
  const res = await db
    .prepare(
      `SELECT ic.* FROM integration_connections ic JOIN sites s ON s.id = ic.site_id AND s.deleted_at IS NULL
       WHERE ic.kind = ? AND ic.status IN ('active', 'error')
       ORDER BY COALESCE(ic.last_synced_at, 0) LIMIT ?`,
    )
    .bind(kind, limit)
    .all<Record<string, unknown>>();
  return (res.results ?? []).map((r) => rowToConnection<S, C>(r));
}

export async function decryptCredentials<T = OAuthCredentials>(
  env: Cloudflare.Env,
  conn: Pick<Connection, "credentialsEnc" | "kind" | "siteId">,
): Promise<T | null> {
  if (!conn.credentialsEnc) return null;
  return decryptJson<T>(env.ENCRYPTION_KEY, conn.credentialsEnc, aad(conn.kind, conn.siteId));
}

export async function encryptCredentials(
  env: Cloudflare.Env,
  kind: IntegrationKind,
  siteId: string,
  value: unknown,
): Promise<string> {
  return encryptJson(env.ENCRYPTION_KEY, value, aad(kind, siteId));
}

export interface UpsertConnection {
  siteId: string;
  kind: IntegrationKind;
  status: ConnectionStatus;
  settings?: unknown;
  /** undefined keeps the stored credentials, null removes them. */
  credentialsEnc?: string | null;
  now: number;
}

export function upsertConnectionStatement(
  db: D1Database,
  u: UpsertConnection,
): D1PreparedStatement {
  const settings = u.settings === undefined ? null : JSON.stringify(u.settings);
  const keepCreds = u.credentialsEnc === undefined ? 1 : 0;
  return db
    .prepare(
      `INSERT INTO integration_connections (site_id, kind, credentials_enc, status, settings, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, COALESCE(?5, '{}'), ?6, ?6)
       ON CONFLICT (site_id, kind) DO UPDATE SET
         credentials_enc = CASE WHEN ?7 = 1 THEN integration_connections.credentials_enc ELSE ?3 END,
         status = ?4, settings = COALESCE(?5, integration_connections.settings),
         last_error = CASE WHEN ?4 = 'active' THEN NULL ELSE integration_connections.last_error END,
         updated_at = ?6`,
    )
    .bind(u.siteId, u.kind, u.credentialsEnc ?? null, u.status, settings, u.now, keepCreds);
}

/** Record the outcome of a sync run (one row write). */
export function syncResultStatement(
  db: D1Database,
  siteId: string,
  kind: IntegrationKind,
  result: { now: number; error?: string | null; cursor?: unknown; credentialsEnc?: string },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE integration_connections SET
         last_synced_at = ?3,
         last_error = ?4,
         status = CASE WHEN ?4 IS NULL THEN 'active' ELSE 'error' END,
         cursor = COALESCE(?5, cursor),
         credentials_enc = COALESCE(?6, credentials_enc),
         updated_at = ?3
       WHERE site_id = ?1 AND kind = ?2`,
    )
    .bind(
      siteId,
      kind,
      result.now,
      result.error ?? null,
      result.cursor === undefined ? null : JSON.stringify(result.cursor),
      result.credentialsEnc ?? null,
    );
}
