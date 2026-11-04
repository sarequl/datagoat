/**
 * The cron multiplexer: one `* * * * *` trigger runs every registered job that is due.
 *
 * Per tick it costs one D1 query to read `job_state`, one batch to claim due non-frequent jobs
 * (so overlapping invocations never double-run an hourly/daily/weekly job), and one batch to
 * record results. Frequent (minute-level) jobs persist state only when something changed: an
 * error, recovery, new JSON state, or an hourly heartbeat. That keeps idle cron writes near
 * 24 rows per job per day.
 *
 * Free-plan constraints this enforces:
 * - D1 queries per invocation: jobs share a metered binding capped at CRON_QUERY_BUDGET (40 by
 *   default, under Free's 50). A job that hits the cap stops; it stays due and runs next tick.
 * - Subrequests (fetch): `ctx.fetch` counts against a 40-call budget per invocation.
 * - CPU (10 ms on Free): do work in SQL (INSERT ... SELECT) and keep JS loops small. Jobs run
 *   sequentially; the most overdue job goes first so none starves.
 * - Error isolation: a throwing job is recorded in job_state and backs off exponentially
 *   (2^failures minutes, max 60) after 3 consecutive failures; other jobs still run.
 */
import { createD1Meter, instrumentD1, QueryBudgetExceeded } from "../lib/d1";
import { errorFields, log } from "../lib/log";
import { currentSlot, isFrequent, type JobContext, type JobDefinition } from "./registry";

const HEARTBEAT_MS = 60 * 60_000;
const DEFAULT_QUERY_BUDGET = 40;
const FETCH_BUDGET = 40;
/** Queries reserved for the scheduler itself (read state, claim, record). */
const RESERVED_QUERIES = 3;

interface StateRow {
  name: string;
  last_run_at: number | null;
  last_slot: number | null;
  last_success_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
  state: string | null;
  updated_at: number;
}

export interface JobRunResult {
  name: string;
  status: "ok" | "error" | "skipped_budget" | "skipped_backoff" | "not_due" | "claimed_elsewhere";
  error?: string;
  durationMs?: number;
}

export interface SchedulerResult {
  results: JobRunResult[];
  queriesUsed: number;
}

function backoffActive(row: StateRow | undefined, now: number): boolean {
  if (!row || row.consecutive_failures < 3 || row.last_run_at === null) return false;
  const waitMinutes = Math.min(60, 2 ** (row.consecutive_failures - 2));
  return now < row.last_run_at + waitMinutes * 60_000;
}

export function isDue(job: JobDefinition, row: StateRow | undefined, now: number): boolean {
  const slot = currentSlot(job.schedule, now);
  if (job.schedule.every === "minute") return true;
  return row?.last_slot === null || row?.last_slot === undefined || row.last_slot < slot;
}

/**
 * Run all due jobs. `scheduledTime` is the cron's scheduled time (controller.scheduledTime).
 */
export async function runScheduled(
  jobs: readonly JobDefinition[],
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  scheduledTime: number = Date.now(),
): Promise<SchedulerResult> {
  const budget = Number.parseInt(env.CRON_QUERY_BUDGET ?? "", 10) || DEFAULT_QUERY_BUDGET;
  const meter = createD1Meter(env.DB, { maxQueries: budget });
  const db = meter.db;
  const now = scheduledTime;
  const results: JobRunResult[] = [];

  const stateRes = await db.prepare("SELECT * FROM job_state").all<StateRow>();
  const states = new Map((stateRes.results ?? []).map((r) => [r.name, r]));

  const due = jobs
    .filter((job) => {
      const row = states.get(job.name);
      if (!isDue(job, row, now)) {
        results.push({ name: job.name, status: "not_due" });
        return false;
      }
      if (backoffActive(row, now)) {
        results.push({ name: job.name, status: "skipped_backoff" });
        return false;
      }
      return true;
    })
    .sort(
      (a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) ||
        (states.get(a.name)?.last_run_at ?? 0) - (states.get(b.name)?.last_run_at ?? 0),
    );

  // Claim slots of non-frequent jobs atomically (one batch).
  const toClaim = due.filter((job) => !isFrequent(job.schedule));
  const claimed = new Set<string>();
  if (toClaim.length) {
    const claimResults = await db.batch(
      toClaim.map((job) => {
        const slot = currentSlot(job.schedule, now);
        return db
          .prepare(
            `INSERT INTO job_state (name, last_run_at, last_slot, updated_at) VALUES (?1, ?2, ?3, ?2)
             ON CONFLICT (name) DO UPDATE SET last_run_at = ?2, last_slot = ?3, updated_at = ?2
             WHERE job_state.last_slot IS NULL OR job_state.last_slot < ?3`,
          )
          .bind(job.name, now, slot);
      }),
    );
    toClaim.forEach((job, i) => {
      if ((claimResults[i]?.meta.changes ?? 0) > 0) claimed.add(job.name);
    });
  }

  // Jobs get a view of the metered binding that stops RESERVED_QUERIES short of the budget, so
  // the scheduler can always record results and release claims.
  const jobDb = instrumentD1(
    db,
    () => {},
    () => {
      if (meter.usage.queries >= budget - RESERVED_QUERIES)
        throw new QueryBudgetExceeded(budget - RESERVED_QUERIES);
    },
  );
  let fetchesUsed = 0;
  const writes: D1PreparedStatement[] = [];
  let budgetExhausted = false;

  for (const job of due) {
    if (!isFrequent(job.schedule) && !claimed.has(job.name)) {
      results.push({ name: job.name, status: "claimed_elsewhere" });
      continue;
    }
    const remaining = budget - meter.usage.queries - RESERVED_QUERIES;
    if (budgetExhausted || remaining < (job.minQueries ?? 2)) {
      results.push({ name: job.name, status: "skipped_budget" });
      // Release the claim so the job runs next tick.
      if (claimed.has(job.name)) {
        const row = states.get(job.name);
        writes.push(
          db
            .prepare("UPDATE job_state SET last_slot = ?, last_run_at = ? WHERE name = ?")
            .bind(row?.last_slot ?? null, row?.last_run_at ?? null, job.name),
        );
      }
      continue;
    }
    const row = states.get(job.name);
    const previousState = row?.state ?? null;
    let nextState: string | null = previousState;
    const slot = currentSlot(job.schedule, now);
    const jobCtx: JobContext = {
      env: { ...env, DB: jobDb },
      db: jobDb,
      now,
      slot,
      lastRunAt: row?.last_run_at ?? null,
      lastSuccessAt: row?.last_success_at ?? null,
      state: previousState === null ? null : JSON.parse(previousState),
      setState(value) {
        nextState = value === undefined || value === null ? null : JSON.stringify(value);
      },
      remainingQueries: () => Math.max(0, budget - meter.usage.queries - RESERVED_QUERIES),
      fetch(input, init) {
        if (fetchesUsed >= FETCH_BUDGET) {
          return Promise.reject(
            new Error(`Subrequest budget of ${FETCH_BUDGET} exhausted for this cron run`),
          );
        }
        fetchesUsed += 1;
        return fetch(input, init);
      },
      waitUntil: (p) => ctx.waitUntil(p),
    };
    const started = Date.now();
    let error: string | null = null;
    let budgetHit = false;
    try {
      await job.run(jobCtx);
    } catch (err) {
      if (err instanceof QueryBudgetExceeded) budgetHit = true;
      else {
        error = err instanceof Error ? err.message : String(err);
        log.error("job.failed", { job: job.name, ...errorFields(err) });
      }
    }
    const durationMs = Date.now() - started;
    if (budgetHit) {
      budgetExhausted = true;
      results.push({ name: job.name, status: "skipped_budget", durationMs });
    } else {
      results.push(
        error
          ? { name: job.name, status: "error", error, durationMs }
          : { name: job.name, status: "ok", durationMs },
      );
    }

    const failures = error ? (row?.consecutive_failures ?? 0) + 1 : 0;
    const frequent = isFrequent(job.schedule);
    const mustWrite =
      !frequent ||
      error !== null ||
      (row?.consecutive_failures ?? 0) > 0 ||
      nextState !== previousState ||
      !row ||
      now - row.updated_at >= HEARTBEAT_MS;
    if (mustWrite && !budgetHit) {
      writes.push(
        db
          .prepare(
            `INSERT INTO job_state (name, last_run_at, last_slot, last_success_at, last_error, last_duration_ms,
               consecutive_failures, state, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?2)
             ON CONFLICT (name) DO UPDATE SET last_run_at = ?2, last_slot = ?3,
               last_success_at = COALESCE(?4, job_state.last_success_at), last_error = ?5,
               last_duration_ms = ?6, consecutive_failures = ?7, state = ?8, updated_at = ?2`,
          )
          .bind(job.name, now, slot, error ? null : now, error, durationMs, failures, nextState),
      );
    }
  }

  if (writes.length) {
    try {
      await db.batch(writes);
    } catch (err) {
      log.error("job.state_write_failed", errorFields(err));
    }
  }
  const queriesUsed = meter.usage.queries;
  log.info("cron.finished", {
    ran: results.filter((r) => r.status === "ok" || r.status === "error").map((r) => r.name),
    failed: results.filter((r) => r.status === "error").map((r) => r.name),
    queries: queriesUsed,
  });
  return { results, queriesUsed };
}
