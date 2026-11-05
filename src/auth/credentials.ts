/**
 * API credentials (plan §13, DataFast authentication docs):
 *
 * - `dg_…` (or legacy `df_…`) website API key: one website, full website-scoped access capped at
 *   member role.
 * - `dgt_…` (or legacy `dft_…`) account token: scoped permissions plus an optional website allowlist; requires
 *   `?websiteId=` on website endpoints.
 *
 * Secrets are shown once. Only SHA-256(secret) is stored (`api_keys.key_hash`, unique index).
 * Resolving a Bearer credential costs one D1 read, cached per isolate for 30 seconds. Usage
 * (`last_used_at`, `usage_count`) is flushed at most every 10 minutes per key per isolate, so API
 * traffic does not write a row per request.
 *
 * Other Bearer formats (W7's MCP OAuth access tokens) plug in with `registerBearerResolver()`.
 */
import type { Grant } from "../../shared/permissions";
import { sha256Hex } from "../lib/crypto";
import { parseJsonColumn } from "../lib/d1";
import { randomBase62 } from "../lib/ids";
import { log } from "../lib/log";
import { toIsoOrNull } from "../lib/time";
import type { AuthContext } from "./context";

export type KeyKind = "df" | "dft";

export const MAX_TOKENS_PER_USER = 20;
export const MAX_KEYS_PER_SITE = 10;
const SECRET_LENGTH = 40;

/**
 * New secrets use DataGoat's prefixes: `dg_` (website key) and `dgt_` (account token). Keys made
 * before the rename keep working with `df_` / `dft_`. The stored `kind` stays "df" / "dft".
 */
const SECRET_PREFIX: Record<KeyKind, string> = { df: "dg_", dft: "dgt_" };

export function generateSecret(kind: KeyKind): string {
  return `${SECRET_PREFIX[kind]}${randomBase62(SECRET_LENGTH)}`;
}

export function keyKindOf(secret: string): KeyKind | null {
  if (secret.startsWith("dgt_") || secret.startsWith("dft_")) return "dft";
  if (secret.startsWith("dg_") || secret.startsWith("df_")) return "df";
  return null;
}

/** Whether `secret` looks like a website key or account token (either prefix generation). */
export function isApiKeySecret(secret: string): boolean {
  return keyKindOf(secret) !== null;
}

export function hashSecret(secret: string): Promise<string> {
  return sha256Hex(secret);
}

/** First 8 characters, e.g. `dg_ab123`. */
export function keyPrefixOf(secret: string): string {
  return secret.slice(0, 8);
}

/** Masked display value: `dg_ab...xyz9` / `dgt_ab1...xyz9`. */
export function displayKeyOf(secret: string): string {
  const head = keyKindOf(secret) === "dft" ? 7 : 5;
  return `${secret.slice(0, head)}...${secret.slice(-4)}`;
}

export interface ApiKeyRow {
  id: string;
  kind: KeyKind;
  site_id: string | null;
  user_id: string;
  name: string | null;
  key_hash: string;
  key_prefix: string;
  display_key: string;
  permissions: string;
  website_ids: string;
  include_pii: number;
  is_mobile: number;
  oauth_connection_id: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  usage_count: number;
  revoked_at: number | null;
}

/** DataFast access-token DTO (`GET /api/v1/admin/access-tokens`). */
export function accessTokenDto(row: ApiKeyRow, secret?: string) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    displayKey: row.display_key,
    scope: "user" as const,
    websiteId: null,
    permissions: parseJsonColumn<string[]>(row.permissions, ["*"]),
    websiteIds: parseJsonColumn<string[]>(row.website_ids, []),
    keyPrefix: row.key_prefix,
    lastUsedAt: toIsoOrNull(row.last_used_at),
    usageCount: row.usage_count,
    expiresAt: toIsoOrNull(row.expires_at),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(secret ? { key: secret } : {}),
  };
}

/** DataFast website-key DTO (`GET /api/v1/admin/websites/{id}/apikeys`). */
export function websiteKeyDto(row: ApiKeyRow, secret?: string) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    displayKey: row.display_key,
    websiteId: row.site_id ?? "",
    keyPrefix: row.key_prefix,
    lastUsedAt: toIsoOrNull(row.last_used_at),
    usageCount: row.usage_count,
    isMobile: row.is_mobile === 1,
    includePii: row.include_pii === 1,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(secret ? { key: secret } : {}),
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface ResolvedKey {
  row: ApiKeyRow;
  user: AuthContext["user"];
}

interface CacheEntry {
  value: ResolvedKey | null;
  expires: number;
}

const KEY_CACHE_TTL_MS = 30_000;
const keyCache = new Map<string, CacheEntry>();

/** Forget cached credentials in this isolate (after revoke/roll). */
export function invalidateCredential(keyHash?: string): void {
  if (keyHash) keyCache.delete(keyHash);
  else keyCache.clear();
}

async function loadKey(db: D1Database, keyHash: string, now: number): Promise<ResolvedKey | null> {
  const cached = keyCache.get(keyHash);
  if (cached && cached.expires > now) return cached.value;
  const row = await db
    .prepare(
      `SELECT k.*, u.email AS u_email, u.name AS u_name, u.image AS u_image, u.created_at AS u_created_at
         FROM api_keys k JOIN users u ON u.id = k.user_id
        WHERE k.key_hash = ?`,
    )
    .bind(keyHash)
    .first<
      ApiKeyRow & {
        u_email: string;
        u_name: string | null;
        u_image: string | null;
        u_created_at: number;
      }
    >();
  const value = row
    ? {
        row,
        user: {
          id: row.user_id,
          email: row.u_email,
          name: row.u_name,
          image: row.u_image,
          createdAt: row.u_created_at,
        },
      }
    : null;
  if (keyCache.size > 1000) keyCache.clear();
  keyCache.set(keyHash, { value, expires: now + KEY_CACHE_TTL_MS });
  return value;
}

export type BearerResolver = (
  token: string,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
) => Promise<AuthContext | null>;

const extraResolvers: Array<{ prefix: string; resolve: BearerResolver }> = [];

/**
 * Register a resolver for another Bearer format (e.g. W7's MCP OAuth tokens, prefix `dgo_`).
 * Call it at module load from your area's index.ts.
 */
export function registerBearerResolver(prefix: string, resolve: BearerResolver): void {
  if (keyKindOf(`${prefix}x`) !== null) throw new Error("dg_/dgt_/df_/dft_ are built in");
  extraResolvers.push({ prefix, resolve });
}

/** Resolve a Bearer token to an AuthContext; null when unknown, revoked or expired. */
export async function resolveBearer(
  token: string,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  now = Date.now(),
): Promise<AuthContext | null> {
  const extra = extraResolvers.find((r) => token.startsWith(r.prefix));
  if (extra) return extra.resolve(token, env, ctx);
  const kind = keyKindOf(token);
  if (!kind || token.length > 200) return null;
  const keyHash = await hashSecret(token);
  const resolved = await loadKey(env.DB, keyHash, now);
  if (!resolved) return null;
  const { row, user } = resolved;
  if (row.kind !== kind || row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at <= now) return null;
  recordUsage(env.DB, ctx, row, now);
  if (row.kind === "df") {
    if (!row.site_id) return null;
    return {
      kind: "site_key",
      user,
      credentialId: row.id,
      scopes: ["*"],
      websiteIds: [row.site_id],
      keySiteId: row.site_id,
      roleCap: "member",
      includePii: row.include_pii === 1,
    };
  }
  const websiteIds = parseJsonColumn<string[]>(row.website_ids, []);
  return {
    kind: "account_token",
    user,
    credentialId: row.id,
    scopes: parseJsonColumn<Grant[]>(row.permissions, []),
    websiteIds: websiteIds.length === 0 ? "all" : websiteIds,
    includePii: row.include_pii === 1,
  };
}

// ---------------------------------------------------------------------------
// Lazy usage accounting
// ---------------------------------------------------------------------------

const USAGE_FLUSH_MS = 10 * 60_000;
const pendingUsage = new Map<string, { count: number; flushedAt: number }>();

function recordUsage(db: D1Database, ctx: ExecutionContext, row: ApiKeyRow, now: number): void {
  const entry = pendingUsage.get(row.id) ?? { count: 0, flushedAt: row.last_used_at ?? 0 };
  entry.count += 1;
  pendingUsage.set(row.id, entry);
  if (now - entry.flushedAt < USAGE_FLUSH_MS) return;
  const count = entry.count;
  entry.count = 0;
  entry.flushedAt = now;
  ctx.waitUntil(
    db
      .prepare("UPDATE api_keys SET last_used_at = ?, usage_count = usage_count + ? WHERE id = ?")
      .bind(now, count, row.id)
      .run()
      .then(() => undefined)
      .catch((err: unknown) =>
        log.warn("api_key.usage_flush_failed", { keyId: row.id, error: String(err) }),
      ),
  );
}

/** Test helper: reset isolate-level credential state. */
export function resetCredentialState(): void {
  keyCache.clear();
  pendingUsage.clear();
}
