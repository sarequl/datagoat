/**
 * Job definitions for the cron multiplexer. Every area exports `JobDefinition[]` from its
 * module and src/jobs/index.ts concatenates them; teams never edit the scheduler.
 *
 *   export const growthJobs: JobDefinition[] = [
 *     { name: "alerts.deliver", schedule: { every: "minute" }, run: deliverAlerts },
 *     { name: "digest.weekly", schedule: { every: "week", day: 1, at: "08:05" }, run: sendDigests },
 *   ];
 *
 * Names are `<area>.<job>` and must be unique. Schedules are UTC.
 */

export type Schedule =
  /** Every cron tick (once a minute). */
  | { every: "minute" }
  /** Every N minutes, aligned to the hour (N should divide 60). */
  | { every: "minutes"; interval: number }
  /** Once an hour at `minute` past (default 0). */
  | { every: "hour"; minute?: number }
  /** Once a day at `at` = "HH:MM" UTC. */
  | { every: "day"; at: string }
  /** Once a week on ISO `day` (1 = Monday … 7 = Sunday) at "HH:MM" UTC. */
  | { every: "week"; day: 1 | 2 | 3 | 4 | 5 | 6 | 7; at: string };

export interface JobContext {
  /** Bindings. `env.DB` is the budgeted, metered D1 binding for this run. */
  env: Cloudflare.Env;
  /** Same as `env.DB`. */
  db: D1Database;
  /** The cron's scheduled time (epoch ms). Use it instead of Date.now() for determinism. */
  now: number;
  /** Start of the schedule slot this run covers. */
  slot: number;
  /** Start of the previous run, or null on the first run. */
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  /** JSON state the job saved last time (cursors). */
  state: unknown;
  /** Persist new JSON state after the run (written only when it changed). */
  setState(next: unknown): void;
  /** D1 queries this job may still issue in this invocation. */
  remainingQueries(): number;
  /** fetch() that counts against the invocation's subrequest budget. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  waitUntil(promise: Promise<unknown>): void;
}

export interface JobDefinition {
  /** Unique `<area>.<job>` name; also the job_state primary key. */
  name: string;
  schedule: Schedule;
  run(ctx: JobContext): Promise<void>;
  /** Higher runs first when several jobs are due (default 0). */
  priority?: number;
  /** Queries the job needs to make progress; it is skipped this tick if fewer remain (default 2). */
  minQueries?: number;
  description?: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function parseAt(at: string): number {
  const m = HHMM.exec(at);
  if (!m) throw new Error(`Invalid job time "${at}", expected HH:MM`);
  return Number(m[1]) * HOUR + Number(m[2]) * MINUTE;
}

/** Start of the most recent slot of `schedule` at or before `now` (epoch ms, UTC). */
export function currentSlot(schedule: Schedule, now: number): number {
  switch (schedule.every) {
    case "minute":
      return Math.floor(now / MINUTE) * MINUTE;
    case "minutes": {
      const size = Math.max(1, Math.floor(schedule.interval)) * MINUTE;
      return Math.floor(now / size) * size;
    }
    case "hour": {
      const offset = (schedule.minute ?? 0) * MINUTE;
      return Math.floor((now - offset) / HOUR) * HOUR + offset;
    }
    case "day": {
      const offset = parseAt(schedule.at);
      return Math.floor((now - offset) / DAY) * DAY + offset;
    }
    case "week": {
      const offset = parseAt(schedule.at);
      const dayStart = Math.floor(now / DAY) * DAY;
      // 1970-01-01 was a Thursday (ISO day 4).
      const isoDay = ((Math.floor(dayStart / DAY) + 3) % 7) + 1;
      let candidate = dayStart - (isoDay - schedule.day) * DAY + offset;
      if (candidate > now) candidate -= 7 * DAY;
      if (candidate + 7 * DAY <= now) candidate += 7 * DAY;
      return candidate;
    }
  }
}

/** Minute-level jobs run every tick and persist state lazily (see scheduler.ts). */
export function isFrequent(schedule: Schedule): boolean {
  return schedule.every === "minute" || (schedule.every === "minutes" && schedule.interval < 60);
}

export function validateJobs(jobs: readonly JobDefinition[]): void {
  const names = new Set<string>();
  for (const job of jobs) {
    if (!/^[a-z0-9-]+\.[a-z0-9.-]+$/.test(job.name)) {
      throw new Error(`Invalid job name "${job.name}": use <area>.<job> in lowercase`);
    }
    if (names.has(job.name)) throw new Error(`Duplicate job name "${job.name}"`);
    names.add(job.name);
    currentSlot(job.schedule, 0);
  }
}
