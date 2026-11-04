/**
 * Database helpers for Worker tests.
 *
 * - `resetDb()` deletes every row of every application table (keeps the schema and the
 *   d1_migrations bookkeeping), and clears isolate-level caches. Call it in `beforeEach`.
 * - `meterDb()` / `meterEnv()` wrap the D1 binding with the write-budget meter: every statement's
 *   `meta.rows_written` / `meta.rows_read` is summed (`first()` and `raw()` are routed through
 *   `all()` so their meta is counted too), and KV writes are counted.
 */
import { env } from "cloudflare:test";
import { resetCredentialState } from "../../src/auth/credentials";
import { invalidateMembership } from "../../src/auth/memberships";
import { resetRateLimitState } from "../../src/auth/rate-limit";
import { createD1Meter, type D1Usage } from "../../src/lib/d1";
import { siteCache } from "../../src/lib/site-cache";

const SKIP = new Set(["d1_migrations", "sqlite_sequence"]);

export async function tableNames(db: D1Database = env.DB): Promise<string[]> {
  const res = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .all<{ name: string }>();
  return (res.results ?? []).map((r) => r.name).filter((n) => !SKIP.has(n));
}

export async function resetDb(db: D1Database = env.DB): Promise<void> {
  const tables = await tableNames(db);
  await db.batch(tables.map((t) => db.prepare(`DELETE FROM "${t}"`)));
  siteCache.clear();
  resetCredentialState();
  invalidateMembership();
  resetRateLimitState();
}

export interface KvUsage {
  writes: number;
  deletes: number;
  reads: number;
}

/** Wrap a KV namespace and count operations. */
export function meterKv(kv: KVNamespace): { kv: KVNamespace; usage: KvUsage } {
  const usage: KvUsage = { writes: 0, deletes: 0, reads: 0 };
  const wrapped = new Proxy(kv, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (prop === "put") usage.writes += 1;
        else if (prop === "delete") usage.deletes += 1;
        else if (prop === "get" || prop === "getWithMetadata") usage.reads += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { kv: wrapped, usage };
}

export interface WriteMeter {
  env: Cloudflare.Env;
  db: D1Database;
  d1: D1Usage;
  kv: KvUsage;
  reset(): void;
}

/** A metered copy of `env`: D1 rows read/written, query count and KV operations. */
export function meterEnv(base: Cloudflare.Env = env): WriteMeter {
  const d1 = createD1Meter(base.DB);
  const kv = meterKv(base.LOGIN_THROTTLE);
  const meteredEnv = { ...base, DB: d1.db, LOGIN_THROTTLE: kv.kv } as Cloudflare.Env;
  return {
    env: meteredEnv,
    db: d1.db,
    d1: d1.usage,
    kv: kv.usage,
    reset() {
      d1.reset();
      kv.usage.writes = 0;
      kv.usage.deletes = 0;
      kv.usage.reads = 0;
    },
  };
}
