/**
 * Retry safety for MCP write tools (DataFast's `idempotencyKey`): the first confirmed call with a
 * key records its result for 24 hours in `idempotency_keys` (scope `mcp:<kind>:<credentialId>`),
 * so a retry with the same key and arguments returns the recorded result instead of writing again.
 *
 * - Same key, different arguments → rejected.
 * - A call whose outcome is unknown (still running, or failed with a 5xx) is never re-run
 *   automatically; the caller has to inspect and use a new key.
 * - A 4xx result changed nothing, so its row is dropped and the call may be retried.
 * - Newly issued secrets are never stored; a replay says the secret was already shown.
 */
import { sha256Hex } from "../lib/crypto";

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
export const SCOPE_PREFIX = "mcp:";
const MAX_STORED_BYTES = 32 * 1024;

export type Begin =
  | { kind: "new" }
  | { kind: "replay"; status: number; response: unknown }
  | { kind: "conflict"; message: string };

/** Canonical JSON (sorted keys) so equivalent arguments hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestHash(tool: string, args: Record<string, unknown>): Promise<string> {
  const { confirm: _c, idempotencyKey: _k, ...rest } = args;
  return sha256Hex(`${tool}\n${canonicalJson(rest)}`);
}

interface Row {
  request_hash: string;
  status: number | null;
  response: string | null;
  expires_at: number;
}

export async function beginIdempotent(
  db: D1Database,
  scope: string,
  key: string,
  hash: string,
  now: number,
): Promise<Begin> {
  const insert = () =>
    db
      .prepare(
        `INSERT OR IGNORE INTO idempotency_keys (scope, key, request_hash, status, response, created_at, expires_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .bind(scope, key, hash, now, now + IDEMPOTENCY_TTL_MS)
      .run();
  if (((await insert()).meta.changes ?? 0) > 0) return { kind: "new" };
  const row = await db
    .prepare(
      "SELECT request_hash, status, response, expires_at FROM idempotency_keys WHERE scope = ? AND key = ?",
    )
    .bind(scope, key)
    .first<Row>();
  if (!row) {
    return ((await insert()).meta.changes ?? 0) > 0
      ? { kind: "new" }
      : { kind: "conflict", message: "idempotencyKey is in use by a concurrent call" };
  }
  if (row.expires_at <= now) {
    await db
      .prepare("DELETE FROM idempotency_keys WHERE scope = ? AND key = ? AND expires_at <= ?")
      .bind(scope, key, now)
      .run();
    return ((await insert()).meta.changes ?? 0) > 0
      ? { kind: "new" }
      : { kind: "conflict", message: "idempotencyKey is in use by a concurrent call" };
  }
  if (row.request_hash !== hash) {
    return {
      kind: "conflict",
      message:
        "This idempotencyKey was already used with different arguments. Use a new key for a different operation.",
    };
  }
  if (row.status === null) {
    return {
      kind: "conflict",
      message:
        "A call with this idempotencyKey is still running or its outcome is unknown. Inspect the website before deliberately issuing the operation again with a new key.",
    };
  }
  let response: unknown = null;
  try {
    response = row.response ? JSON.parse(row.response) : null;
  } catch {
    response = null;
  }
  return { kind: "replay", status: row.status, response };
}

const SECRET_FIELDS = new Set(["key", "requestAuthToken", "token", "secret", "client_secret"]);
export const REDACTED_SECRET =
  "[already issued: secrets are shown only in the first response and are not stored for replay]";

/** Copy of a response with newly issued secrets replaced. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_FIELDS.has(k) && typeof v === "string" ? REDACTED_SECRET : redactSecrets(v);
    }
    return out;
  }
  return value;
}

/** Record the outcome of the call started by beginIdempotent. */
export async function finishIdempotent(
  db: D1Database,
  scope: string,
  key: string,
  status: number,
  response: unknown,
): Promise<void> {
  if (status >= 400 && status < 500) {
    await db
      .prepare("DELETE FROM idempotency_keys WHERE scope = ? AND key = ? AND status IS NULL")
      .bind(scope, key)
      .run();
    return;
  }
  if (status >= 500) return; // outcome unknown: leave the row pending until it expires
  let stored = JSON.stringify(redactSecrets(response));
  if (stored.length > MAX_STORED_BYTES) {
    stored = JSON.stringify({ note: "The original response was too large to keep for replay." });
  }
  await db
    .prepare("UPDATE idempotency_keys SET status = ?, response = ? WHERE scope = ? AND key = ?")
    .bind(status, stored, scope, key)
    .run();
}
