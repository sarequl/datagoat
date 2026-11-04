/**
 * `mcp.cleanup` (daily): delete expired OAuth codes, tokens, connections and client
 * registrations, and expired MCP idempotency records. Deletes are bounded per run (each deleted
 * row is a billed write) and done in SQL; an idle install writes nothing.
 */
import type { JobDefinition } from "../jobs/registry";
import { SCOPE_PREFIX } from "./idempotency";

export const CLEANUP_BATCH = 500;
/** Revoked or expired connections are kept this long so the user can see what happened. */
export const CONNECTION_GRACE_MS = 30 * 86_400_000;

export function cleanupStatements(db: D1Database, now: number, limit = CLEANUP_BATCH) {
  const graceCutoff = now - CONNECTION_GRACE_MS;
  return [
    db
      .prepare(
        `DELETE FROM oauth_codes WHERE code_hash IN (
           SELECT code_hash FROM oauth_codes WHERE expires_at < ? LIMIT ?)`,
      )
      .bind(now - 86_400_000, limit),
    db
      .prepare(
        `DELETE FROM oauth_tokens WHERE token_hash IN (
           SELECT token_hash FROM oauth_tokens WHERE expires_at < ? LIMIT ?)`,
      )
      .bind(now, limit),
    db
      .prepare(
        `DELETE FROM oauth_connections WHERE id IN (
           SELECT id FROM oauth_connections
            WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ? LIMIT ?)`,
      )
      .bind(graceCutoff, graceCutoff, limit),
    db
      .prepare(
        `DELETE FROM oauth_clients WHERE id IN (
           SELECT cl.id FROM oauth_clients cl
            WHERE cl.expires_at IS NOT NULL AND cl.expires_at < ?
              AND NOT EXISTS (SELECT 1 FROM oauth_connections c
                               WHERE c.client_id = cl.id AND c.revoked_at IS NULL AND c.expires_at > ?)
            LIMIT ?)`,
      )
      .bind(now, now, limit),
    db
      .prepare(
        `DELETE FROM idempotency_keys WHERE (scope, key) IN (
           SELECT scope, key FROM idempotency_keys
            WHERE scope >= ? AND scope < ? AND expires_at < ? LIMIT ?)`,
      )
      .bind(SCOPE_PREFIX, `${SCOPE_PREFIX.slice(0, -1)};`, now, limit),
  ];
}

export const mcpCleanupJob: JobDefinition = {
  name: "mcp.cleanup",
  schedule: { every: "day", at: "03:17" },
  minQueries: 1,
  description: "Delete expired MCP OAuth codes, tokens, connections, clients and retry records",
  run: async (ctx) => {
    await ctx.db.batch(cleanupStatements(ctx.db, ctx.now));
  },
};
