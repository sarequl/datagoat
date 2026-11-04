/**
 * Bot traffic allowance accounting. DataFast includes 100,000 accepted requests per billing cycle
 * and pauses Bot traffic ingestion (only) when they are used up. A self-hosted install has no
 * billing: by default nothing is counted (`isCounting: false`). An operator who wants a cap (for
 * example to protect the Free plan's 100,000 rows written per day) sets BOT_TRAFFIC_ALLOWANCE to
 * the number of accepted requests per UTC calendar month.
 *
 * While counting, ingest keeps per-isolate counters and flushes them to `bot_usage` at most once a
 * minute (one row write), so accounting adds no per-request writes. The cap is therefore
 * approximate by up to a minute of traffic per isolate.
 */

const FLUSH_MS = 60_000;
const BASE_TTL_MS = 60_000;

export function allowanceOf(env: Cloudflare.Env): number | null {
  const n = Number.parseInt(env.BOT_TRAFFIC_ALLOWANCE ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function periodOf(now: number): { key: string; startMs: number; endMs: number } {
  const d = new Date(now);
  const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const endMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { key: new Date(startMs).toISOString().slice(0, 7), startMs, endMs };
}

interface IsolateCounters {
  period: string;
  pendingAccepted: number;
  pendingDropped: number;
  lastFlush: number;
  base: { at: number; accepted: number; dropped: number } | null;
}

let counters: IsolateCounters = {
  period: "",
  pendingAccepted: 0,
  pendingDropped: 0,
  lastFlush: 0,
  base: null,
};

export function resetUsageCounters(): void {
  counters = { period: "", pendingAccepted: 0, pendingDropped: 0, lastFlush: 0, base: null };
}

function roll(now: number) {
  const { key } = periodOf(now);
  if (counters.period !== key) {
    counters = { period: key, pendingAccepted: 0, pendingDropped: 0, lastFlush: 0, base: null };
  }
}

export async function storedUsage(
  db: D1Database,
  now: number,
): Promise<{ accepted: number; dropped: number }> {
  roll(now);
  if (counters.base && now - counters.base.at < BASE_TTL_MS) return counters.base;
  const row = await db
    .prepare("SELECT accepted, dropped FROM bot_usage WHERE period = ?")
    .bind(counters.period)
    .first<{ accepted: number; dropped: number }>();
  counters.base = { at: now, accepted: row?.accepted ?? 0, dropped: row?.dropped ?? 0 };
  return counters.base;
}

/** How many of `n` new requests the allowance still admits. */
export async function allowanceAllows(
  env: Cloudflare.Env,
  db: D1Database,
  n: number,
  now: number,
): Promise<number> {
  const allowance = allowanceOf(env);
  if (allowance === null) return n;
  const base = await storedUsage(db, now);
  const used = base.accepted + counters.pendingAccepted;
  return Math.max(0, Math.min(n, allowance - used));
}

/** Count accepted/dropped requests; returns a flush promise when one is due. */
export function recordUsage(
  env: Cloudflare.Env,
  db: D1Database,
  accepted: number,
  dropped: number,
  now: number,
): Promise<unknown> | null {
  if (allowanceOf(env) === null) return null;
  roll(now);
  counters.pendingAccepted += accepted;
  counters.pendingDropped += dropped;
  const due =
    (counters.pendingAccepted || counters.pendingDropped) &&
    (now - counters.lastFlush >= FLUSH_MS || counters.pendingAccepted >= 1000);
  if (!due) return null;
  const a = counters.pendingAccepted;
  const d = counters.pendingDropped;
  counters.pendingAccepted = 0;
  counters.pendingDropped = 0;
  counters.lastFlush = now;
  if (counters.base) {
    counters.base = {
      ...counters.base,
      accepted: counters.base.accepted + a,
      dropped: counters.base.dropped + d,
    };
  }
  return db
    .prepare(
      `INSERT INTO bot_usage (period, accepted, dropped, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (period) DO UPDATE SET accepted = accepted + ?2, dropped = dropped + ?3, updated_at = ?4`,
    )
    .bind(counters.period, a, d, now)
    .run();
}

/** Pending (unflushed) counts of this isolate, for the usage endpoint. */
export function pendingUsage(): { accepted: number; dropped: number } {
  return { accepted: counters.pendingAccepted, dropped: counters.pendingDropped };
}
