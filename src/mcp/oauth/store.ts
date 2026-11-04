/**
 * OAuth connections, authorization codes and tokens (tables from migration 0001). Every secret is
 * stored as its SHA-256 hash. Lifetimes follow DataFast: codes 2 minutes (single use), access
 * tokens 1 hour, refresh tokens 30 days (rotated on every use), connections 90 days.
 *
 * Replaying a consumed code or a rotated refresh token revokes the whole connection, as does
 * revoking it from the dashboard. Credentials minted through a connection (`api_keys` rows with
 * `oauth_connection_id`) are revoked with it.
 */
import { invalidateCredential } from "../../auth/credentials";
import { sha256Hex } from "../../lib/crypto";
import { parseJsonColumn } from "../../lib/d1";
import { newId, randomBase62 } from "../../lib/ids";

export const CODE_TTL_MS = 2 * 60_000;
export const ACCESS_TTL_MS = 3_600_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;
export const CONNECTION_TTL_MS = 90 * 86_400_000;

export const ACCESS_PREFIX = "dgo_";
export const REFRESH_PREFIX = "dgr_";
export const CODE_PREFIX = "dgac_";

export interface Connection {
  id: string;
  userId: string;
  clientId: string;
  scopes: string[];
  siteIds: string[];
  resource: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface ConnectionRow {
  id: string;
  user_id: string;
  client_id: string;
  scopes: string;
  site_ids: string;
  resource: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export function rowToConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    scopes: parseJsonColumn<string[]>(row.scopes, []),
    siteIds: parseJsonColumn<string[]>(row.site_ids, []),
    resource: row.resource,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export function connectionIsLive(conn: Connection, now: number): boolean {
  return conn.revokedAt === null && conn.expiresAt > now;
}

export const hashToken = (token: string) => sha256Hex(token);

export interface NewCode {
  code: string;
  connectionId: string;
  statements: D1PreparedStatement[];
}

/** Statements that create an approved connection and its authorization code. */
export async function prepareConnectionAndCode(
  db: D1Database,
  input: {
    userId: string;
    clientId: string;
    scopes: string[];
    siteIds: string[];
    resource: string;
    redirectUri: string;
    codeChallenge: string;
  },
  now: number,
): Promise<NewCode> {
  const connectionId = newId(now);
  const code = `${CODE_PREFIX}${randomBase62(40)}`;
  return {
    code,
    connectionId,
    statements: [
      db
        .prepare(
          `INSERT INTO oauth_connections (id, user_id, client_id, scopes, site_ids, resource, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          connectionId,
          input.userId,
          input.clientId,
          JSON.stringify(input.scopes),
          JSON.stringify(input.siteIds),
          input.resource,
          now,
          now + CONNECTION_TTL_MS,
        ),
      db
        .prepare(
          `INSERT INTO oauth_codes (code_hash, connection_id, client_id, redirect_uri, code_challenge,
             code_challenge_method, resource, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'S256', ?, ?, ?)`,
        )
        .bind(
          await hashToken(code),
          connectionId,
          input.clientId,
          input.redirectUri,
          input.codeChallenge,
          input.resource,
          now,
          now + CODE_TTL_MS,
        ),
    ],
  };
}

export interface CodeRow {
  code_hash: string;
  connection_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export async function findCode(db: D1Database, code: string): Promise<CodeRow | null> {
  if (!code.startsWith(CODE_PREFIX) || code.length > 100) return null;
  return db
    .prepare("SELECT * FROM oauth_codes WHERE code_hash = ?")
    .bind(await hashToken(code))
    .first<CodeRow>();
}

/** Mark a code consumed; false when another request consumed it first. */
export async function consumeCode(db: D1Database, codeHash: string, now: number): Promise<boolean> {
  const res = await db
    .prepare("UPDATE oauth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL")
    .bind(now, codeHash)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function loadConnection(db: D1Database, id: string): Promise<Connection | null> {
  const row = await db
    .prepare("SELECT * FROM oauth_connections WHERE id = ?")
    .bind(id)
    .first<ConnectionRow>();
  return row ? rowToConnection(row) : null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  statements: D1PreparedStatement[];
}

/** Statements inserting a fresh access + refresh token pair for a connection. */
export async function prepareTokenPair(
  db: D1Database,
  conn: Connection,
  now: number,
): Promise<IssuedTokens> {
  const accessToken = `${ACCESS_PREFIX}${randomBase62(40)}`;
  const refreshToken = `${REFRESH_PREFIX}${randomBase62(48)}`;
  const accessExpiresAt = Math.min(now + ACCESS_TTL_MS, conn.expiresAt);
  const refreshExpiresAt = Math.min(now + REFRESH_TTL_MS, conn.expiresAt);
  const insert = `INSERT INTO oauth_tokens (token_hash, kind, connection_id, client_id, resource, created_at, expires_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`;
  return {
    accessToken,
    refreshToken,
    accessExpiresAt,
    refreshExpiresAt,
    statements: [
      db
        .prepare(insert)
        .bind(
          await hashToken(accessToken),
          "access",
          conn.id,
          conn.clientId,
          conn.resource,
          now,
          accessExpiresAt,
        ),
      db
        .prepare(insert)
        .bind(
          await hashToken(refreshToken),
          "refresh",
          conn.id,
          conn.clientId,
          conn.resource,
          now,
          refreshExpiresAt,
        ),
    ],
  };
}

export interface TokenRow {
  token_hash: string;
  kind: "access" | "refresh";
  connection_id: string;
  client_id: string;
  resource: string;
  created_at: number;
  expires_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
}

export async function findToken(db: D1Database, token: string): Promise<TokenRow | null> {
  if (token.length > 200) return null;
  if (!token.startsWith(ACCESS_PREFIX) && !token.startsWith(REFRESH_PREFIX)) return null;
  return db
    .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ?")
    .bind(await hashToken(token))
    .first<TokenRow>();
}

/** Mark a refresh token rotated; false when it was already rotated (a replay). */
export async function rotateRefreshToken(
  db: D1Database,
  tokenHash: string,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE oauth_tokens SET rotated_at = ? WHERE token_hash = ? AND kind = 'refresh' AND rotated_at IS NULL AND revoked_at IS NULL",
    )
    .bind(now, tokenHash)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Revoke a connection, its tokens and every credential minted through it. */
export async function revokeConnection(
  db: D1Database,
  connectionId: string,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare("UPDATE oauth_connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(now, connectionId),
    db
      .prepare(
        "UPDATE oauth_tokens SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL",
      )
      .bind(now, connectionId),
    db
      .prepare(
        "UPDATE api_keys SET revoked_at = ? WHERE oauth_connection_id = ? AND revoked_at IS NULL",
      )
      .bind(now, connectionId),
  ]);
  invalidateCredential();
}

export async function revokeAccessToken(db: D1Database, tokenHash: string, now: number) {
  await db
    .prepare(
      "UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND kind = 'access' AND revoked_at IS NULL",
    )
    .bind(now, tokenHash)
    .run();
}
