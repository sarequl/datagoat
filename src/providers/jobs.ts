/**
 * Revenue cron jobs (registered in src/providers/index.ts `providerJobs`).
 *
 * | job                       | schedule        | work per run (bounded)                                         |
 * |---------------------------|-----------------|----------------------------------------------------------------|
 * | providers.sync            | every minute    | poll providers (events APIs every minute, others every 5–60 min) and one backfill page per connection, at most SYNC_FETCH_BUDGET subrequests and BACKFILL_PAGES_PER_RUN pages |
 * | providers.resolve-hints   | every minute    | up to HINTS_PER_RUN success-page hints, with backoff            |
 * | providers.fx              | hourly at :23   | ECB rates once a day; re-convert pending / re-based payments    |
 * | providers.match-emails    | hourly at :37   | attribute recent unattributed payments whose email matches a visitor |
 * | providers.cleanup         | daily 04:41     | prune webhook dedupe rows (30 d) and resolved hints (90 d)      |
 *
 * Free-plan rules: an idle run writes nothing (cursors and `last_synced_at` are written only when
 * they change, the latter at most hourly), every run stops before the shared query budget, and
 * subrequests stay under SYNC_FETCH_BUDGET + HINT_FETCH_BUDGET + 1 (well under Free's 50).
 */
import type { JobContext, JobDefinition } from "../jobs/registry";
import { QueryBudgetExceeded, runBatch } from "../lib/d1";
import { errorFields, log } from "../lib/log";
import { siteCache } from "../lib/site-cache";
import type { Site } from "../lib/sites";
import { adapterFor } from "./adapters";
import {
  type ConnectionRow,
  decryptConnection,
  type SyncStateRow,
  syncStateUpsert,
} from "./connections";
import { ingestBatch } from "./engine";
import { convert, fetchEcb, loadRates, toPerUsd, utcDay } from "./fx";
import { budgetedFetch, describeError, FetchBudgetExceeded, ProviderHttpError } from "./http";
import { type AdapterContext, batchSize, type Connection, type FetchFn } from "./types";

export const SYNC_FETCH_BUDGET = 20;
export const HINT_FETCH_BUDGET = 8;
export const BACKFILL_PAGES_PER_RUN = 2;
export const HINTS_PER_RUN = 8;
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** Minutes to wait before each retry of an unresolved hint; the last one gives up. */
export const HINT_BACKOFF_MINUTES = [1, 2, 5, 10, 30, 60, 180, 720, 1440];
/** Queries kept free before starting another connection. */
const MIN_QUERIES_PER_CONNECTION = 8;

export function allowTestKeys(env: Cloudflare.Env): boolean {
  return (
    (env as unknown as { ALLOW_TEST_PAYMENT_KEYS?: string }).ALLOW_TEST_PAYMENT_KEYS === "true"
  );
}

export function adapterContext(env: Cloudflare.Env, fetchFn: FetchFn, now: number): AdapterContext {
  return { fetch: fetchFn, now, allowTestKeys: allowTestKeys(env) };
}

function hashSlot(value: string, modulo: number): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h % modulo;
}

/** True when a connection polling every `every` minutes is due at `now` (spread by site). */
export function pollDue(siteId: string, provider: string, every: number, now: number): boolean {
  if (every <= 1) return true;
  return Math.floor(now / MINUTE) % every === hashSlot(`${siteId}:${provider}`, every);
}

async function siteFor(db: D1Database, siteId: string): Promise<Site | null> {
  return siteCache.byId(db, siteId);
}

function connectionUpdate(
  db: D1Database,
  conn: Connection,
  patch: { status?: Connection["status"]; lastError?: string | null; lastSyncedAt?: number },
  now: number,
): D1PreparedStatement | null {
  const status = patch.status ?? conn.status;
  const lastError = patch.lastError === undefined ? conn.lastError : patch.lastError;
  const lastSyncedAt = patch.lastSyncedAt ?? conn.lastSyncedAt;
  if (status === conn.status && lastError === conn.lastError && lastSyncedAt === conn.lastSyncedAt)
    return null;
  return db
    .prepare(
      "UPDATE provider_connections SET status = ?, last_error = ?, last_synced_at = ?, updated_at = ? WHERE site_id = ? AND provider = ?",
    )
    .bind(status, lastError, lastSyncedAt, now, conn.siteId, conn.provider);
}

export async function runSync(ctx: JobContext): Promise<void> {
  const { db, env, now } = ctx;
  const [connRes, stateRes] = await db.batch([
    db.prepare("SELECT * FROM provider_connections WHERE status IN ('active', 'error')"),
    db.prepare("SELECT * FROM provider_sync_state"),
  ]);
  const rows = (connRes?.results ?? []) as unknown as ConnectionRow[];
  if (!rows.length) return;
  const states = new Map<string, SyncStateRow>();
  for (const s of (stateRes?.results ?? []) as unknown as SyncStateRow[]) {
    states.set(`${s.site_id}:${s.provider}:${s.stream}`, s);
  }
  const fetchFn = budgetedFetch(ctx.fetch, SYNC_FETCH_BUDGET);
  const actx = adapterContext(env, fetchFn, now);
  let backfillPages = 0;

  // Connections with pending backfill first, then the longest-unsynced.
  rows.sort((a, b) => {
    const ab = states.get(`${a.site_id}:${a.provider}:backfill`)?.done === 0 ? 0 : 1;
    const bb = states.get(`${b.site_id}:${b.provider}:backfill`)?.done === 0 ? 0 : 1;
    return ab - bb || (a.last_synced_at ?? 0) - (b.last_synced_at ?? 0);
  });

  for (const row of rows) {
    if (ctx.remainingQueries() < MIN_QUERIES_PER_CONNECTION) break;
    const adapter = adapterFor(row.provider);
    if (!adapter) continue;
    if (row.status === "error" && now - row.updated_at < HOUR) continue;
    const backfill = states.get(`${row.site_id}:${row.provider}:backfill`);
    const sync = states.get(`${row.site_id}:${row.provider}:sync`);
    const wantBackfill =
      !!adapter.backfill && backfill?.done === 0 && backfillPages < BACKFILL_PAGES_PER_RUN;
    const wantSync =
      !!adapter.sync && pollDue(row.site_id, row.provider, adapter.pollEveryMinutes ?? 1, now);
    if (!wantBackfill && !wantSync) continue;

    const site = await siteFor(db, row.site_id);
    if (!site) continue;
    let conn: Connection;
    try {
      conn = await decryptConnection(env, row);
    } catch (err) {
      log.error("providers.decrypt_failed", { provider: row.provider, ...errorFields(err) });
      continue;
    }
    const writes: D1PreparedStatement[] = [];
    let ingested = false;
    let warning: string | null = null;
    try {
      if (wantBackfill && adapter.backfill) {
        backfillPages += 1;
        const res = await adapter.backfill(conn, backfill?.cursor ?? null, actx);
        if (batchSize(res.batch)) {
          await ingestBatch(db, res.batch, {
            site,
            provider: adapter.id,
            source: "backfill",
            now,
            planChangesFromRenewals: adapter.planChangesFromRenewals,
          });
          ingested = true;
        }
        warning = res.warning ?? null;
        writes.push(
          syncStateUpsert(
            db,
            conn.siteId,
            conn.provider,
            "backfill",
            res.next,
            res.next === null ? 1 : 0,
            now,
            warning ?? backfill?.last_error ?? null,
          ),
        );
      }
      if (wantSync && adapter.sync) {
        const prevCursor = sync?.cursor ?? null;
        const res = await adapter.sync(conn, prevCursor, actx);
        if (batchSize(res.batch)) {
          await ingestBatch(db, res.batch, {
            site,
            provider: adapter.id,
            source: "poll",
            now,
            planChangesFromRenewals: adapter.planChangesFromRenewals,
          });
          ingested = true;
        }
        if (res.cursor !== prevCursor) {
          writes.push(syncStateUpsert(db, conn.siteId, conn.provider, "sync", res.cursor, 0, now));
        }
        if (res.restartBackfill && adapter.backfill) {
          writes.push(syncStateUpsert(db, conn.siteId, conn.provider, "backfill", null, 0, now));
        }
      }
      const update = connectionUpdate(
        db,
        conn,
        {
          status: "active",
          lastError: null,
          lastSyncedAt:
            ingested || now - (conn.lastSyncedAt ?? 0) >= HOUR ? now : (conn.lastSyncedAt ?? now),
        },
        now,
      );
      if (update) writes.push(update);
    } catch (err) {
      if (err instanceof QueryBudgetExceeded) throw err;
      if (err instanceof FetchBudgetExceeded) {
        if (writes.length) await runBatch(db, writes);
        break;
      }
      const message = describeError(err);
      log.warn("providers.sync_failed", { provider: conn.provider, error: message });
      const update = connectionUpdate(
        db,
        conn,
        {
          status: err instanceof ProviderHttpError && err.isAuth ? "error" : conn.status,
          lastError: message,
        },
        now,
      );
      if (update) writes.push(update);
    }
    if (writes.length) await runBatch(db, writes);
  }
}

interface HintRow {
  site_id: string;
  provider: string;
  ref: string;
  visitor_id: string;
  session_id: string;
  attempts: number;
}

export async function runResolveHints(ctx: JobContext): Promise<void> {
  const { db, env, now } = ctx;
  const res = await db
    .prepare(
      `SELECT site_id, provider, ref, visitor_id, session_id, attempts FROM payment_hints
       WHERE resolved_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at LIMIT ?`,
    )
    .bind(now, HINTS_PER_RUN)
    .all<HintRow>();
  const hints = res.results ?? [];
  if (!hints.length) return;
  const fetchFn = budgetedFetch(ctx.fetch, HINT_FETCH_BUDGET);
  const actx = adapterContext(env, fetchFn, now);
  const connections = new Map<string, Connection | null>();

  for (const hint of hints) {
    if (ctx.remainingQueries() < 6) break;
    const key = `${hint.site_id}:${hint.provider}`;
    if (!connections.has(key)) {
      const row = await db
        .prepare(
          "SELECT * FROM provider_connections WHERE site_id = ? AND provider = ? AND status IN ('active', 'error')",
        )
        .bind(hint.site_id, hint.provider)
        .first<ConnectionRow>();
      connections.set(key, row ? await decryptConnection(env, row).catch(() => null) : null);
    }
    const conn = connections.get(key) ?? null;
    const adapter = adapterFor(hint.provider);
    const site = await siteFor(db, hint.site_id);
    let outcome: "resolved" | "retry" | "gone" = "retry";
    let error: string | null = null;
    try {
      if (!site || !adapter) outcome = "gone";
      else if (conn && adapter.resolveHint) {
        const batch = await adapter.resolveHint(conn, hint.ref, actx);
        if (batch === null) outcome = "retry";
        else if (!batchSize(batch)) {
          outcome = "gone";
          error = "The provider has no paid checkout or order with this reference";
        } else {
          await ingestBatch(db, batch, {
            site,
            provider: adapter.id,
            source: "hint",
            now,
            hint: { ref: hint.ref, visitorId: hint.visitor_id, sessionId: hint.session_id },
          });
          outcome = "resolved";
        }
      } else
        error = conn
          ? "This provider cannot resolve success-page references"
          : "Provider not connected";
    } catch (err) {
      if (err instanceof QueryBudgetExceeded) throw err;
      if (err instanceof FetchBudgetExceeded) break;
      error = describeError(err);
    }
    const attempts = hint.attempts + 1;
    const wait = HINT_BACKOFF_MINUTES[hint.attempts];
    if (outcome === "retry" && wait === undefined) {
      outcome = "gone";
      error ??= "Not paid after the last retry";
    }
    await db
      .prepare(
        `UPDATE payment_hints SET attempts = ?, next_attempt_at = ?, resolved_at = ?, last_error = ?
         WHERE site_id = ? AND provider = ? AND ref = ?`,
      )
      .bind(
        attempts,
        outcome === "retry" ? now + (wait ?? 60) * MINUTE : null,
        outcome === "retry" ? null : now,
        error,
        hint.site_id,
        hint.provider,
        hint.ref,
      )
      .run();
  }
}

interface FxState {
  lastFetchAt?: number;
  sites?: string;
  pending?: boolean;
}

const RECONVERT_LIMIT = 200;

export async function runFx(ctx: JobContext): Promise<void> {
  const { db, now } = ctx;
  const state = (ctx.state ?? {}) as FxState;
  const today = utcDay(now);
  const [maxRes, sitesRes] = await db.batch([
    db.prepare("SELECT MAX(day) AS day, COUNT(*) AS n FROM fx_rates"),
    db.prepare("SELECT id, currency FROM sites WHERE deleted_at IS NULL ORDER BY id"),
  ]);
  const max = (maxRes?.results?.[0] ?? {}) as { day: string | null; n: number };
  let inserted = 0;
  const stale = !max.day || max.day < today;
  const recentlyTried = state.lastFetchAt !== undefined && now - state.lastFetchAt < 3 * HOUR;
  const next: FxState = { ...state };
  if (stale && !recentlyTried) {
    next.lastFetchAt = now;
    try {
      const days = await fetchEcb(ctx.fetch, !max.n);
      const stmts: D1PreparedStatement[] = [];
      for (const d of days) {
        if (max.day && d.day <= max.day) continue;
        const perUsd = toPerUsd(d);
        if (!perUsd) continue;
        const entries = Object.entries(perUsd);
        for (let i = 0; i < entries.length; i += 33) {
          const slice = entries.slice(i, i + 33);
          stmts.push(
            db
              .prepare(
                `INSERT INTO fx_rates (day, currency, per_usd) VALUES ${slice.map(() => "(?, ?, ?)").join(", ")}
                 ON CONFLICT (day, currency) DO NOTHING`,
              )
              .bind(...slice.flatMap(([c, r]) => [d.day, c, r])),
          );
        }
      }
      if (stmts.length) {
        const results = await runBatch(db, stmts);
        inserted = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
      }
    } catch (err) {
      if (err instanceof QueryBudgetExceeded) throw err;
      log.warn("providers.fx_fetch_failed", errorFields(err));
    }
  }
  const sites = ((sitesRes?.results ?? []) as Array<{ id: string; currency: string }>)
    .map((s) => `${s.id}:${s.currency}`)
    .join(",");
  const sitesChanged = state.sites !== undefined && state.sites !== sites;
  next.sites = sites;
  if (inserted > 0 || sitesChanged || state.pending) {
    next.pending = (await reconvertPayments(db)) >= RECONVERT_LIMIT;
  }
  if (JSON.stringify(next) !== JSON.stringify(state)) ctx.setState(next);
}

/** Re-convert payments whose rate was missing or whose website currency changed. */
export async function reconvertPayments(db: D1Database): Promise<number> {
  const res = await db
    .prepare(
      `SELECT p.site_id, p.id, p.amount_minor, p.currency, p.occurred_at, p.reporting_currency, p.fx_rate,
         s.currency AS site_currency
       FROM payments p JOIN sites s ON s.id = p.site_id
       WHERE (p.fx_rate IS NULL AND p.currency <> p.reporting_currency) OR p.reporting_currency <> s.currency
       LIMIT ?`,
    )
    .bind(RECONVERT_LIMIT)
    .all<{
      site_id: string;
      id: string;
      amount_minor: number;
      currency: string;
      occurred_at: number;
      reporting_currency: string;
      fx_rate: number | null;
      site_currency: string;
    }>();
  const rows = res.results ?? [];
  if (!rows.length) return 0;
  const currencies = [...new Set(rows.flatMap((r) => [r.currency, r.site_currency]))];
  const times = rows.map((r) => r.occurred_at);
  const rates = await loadRates(db, currencies, Math.min(...times), Math.max(...times));
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const c = convert(rates, r.amount_minor, r.currency, r.site_currency, r.occurred_at);
    if (c.fxRate === null && r.reporting_currency === r.site_currency) continue;
    stmts.push(
      db
        .prepare(
          "UPDATE payments SET reporting_minor = ?, reporting_currency = ?, fx_rate = ? WHERE site_id = ? AND id = ?",
        )
        .bind(c.reportingMinor, r.site_currency, c.fxRate, r.site_id, r.id),
    );
  }
  if (stmts.length) await runBatch(db, stmts);
  return rows.length;
}

/** Attribute unattributed payments whose customer email now matches a visitor (identify/payment). */
export async function runMatchEmails(ctx: JobContext): Promise<void> {
  const { db, now } = ctx;
  const res = await db
    .prepare(
      `SELECT p.site_id, p.provider, p.provider_txn_id, p.provider_customer_id, p.occurred_at,
         (SELECT v.id FROM visitors v WHERE v.site_id = p.site_id AND v.email_hash = p.email_hash
          ORDER BY v.first_seen_at DESC LIMIT 1) AS visitor_id
       FROM payments p
       WHERE p.visitor_id IS NULL AND p.email_hash IS NOT NULL AND p.created_at >= ?
       LIMIT 100`,
    )
    .bind(now - 30 * 24 * HOUR)
    .all<{
      site_id: string;
      provider: string;
      provider_txn_id: string;
      provider_customer_id: string | null;
      occurred_at: number;
      visitor_id: string | null;
    }>();
  const matched = (res.results ?? []).filter((r) => r.visitor_id);
  const groups = new Map<string, typeof matched>();
  for (const r of matched) {
    const key = `${r.site_id}\u0000${r.provider}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, list] of groups) {
    if (ctx.remainingQueries() < 5) break;
    const [siteId, provider] = key.split("\u0000") as [string, string];
    const site = await siteFor(db, siteId);
    if (!site) continue;
    await ingestBatch(
      db,
      {
        payments: [],
        subscriptions: [],
        customers: list.map((r) => ({
          customerId: r.provider_customer_id ?? undefined,
          visitorId: r.visitor_id ?? undefined,
          visitorVia: "email",
          occurredAt: r.occurred_at,
          attachTxnIds: [r.provider_txn_id],
        })),
      },
      { site, provider: provider as never, source: "import", now },
    );
  }
}

export async function runCleanup(ctx: JobContext): Promise<void> {
  const { db, now } = ctx;
  await db.batch([
    db.prepare("DELETE FROM webhook_events WHERE received_at < ?").bind(now - 30 * 24 * HOUR),
    db
      .prepare("DELETE FROM payment_hints WHERE resolved_at IS NOT NULL AND resolved_at < ?")
      .bind(now - 90 * 24 * HOUR),
  ]);
}

export const providerJobDefinitions: JobDefinition[] = [
  {
    name: "providers.sync",
    schedule: { every: "minute" },
    run: runSync,
    priority: 5,
    minQueries: 4,
    description: "Poll payment providers and run backfill pages",
  },
  {
    name: "providers.resolve-hints",
    schedule: { every: "minute" },
    run: runResolveHints,
    priority: 4,
    minQueries: 3,
    description: "Resolve success-page payment references",
  },
  {
    name: "providers.fx",
    schedule: { every: "hour", minute: 23 },
    run: runFx,
    minQueries: 4,
    description: "Fetch ECB reference rates and re-convert pending payments",
  },
  {
    name: "providers.match-emails",
    schedule: { every: "hour", minute: 37 },
    run: runMatchEmails,
    minQueries: 3,
    description: "Attribute unattributed payments by customer email",
  },
  {
    name: "providers.cleanup",
    schedule: { every: "day", at: "04:41" },
    run: runCleanup,
    description: "Prune webhook dedupe rows and old resolved hints",
  },
];
