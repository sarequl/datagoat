# Cron jobs

One trigger (`* * * * *`) runs `src/jobs/scheduler.ts`, which multiplexes every job in
`src/jobs/index.ts` (each area exports its own `*Jobs` array).

| Schedule                                 | Meaning (UTC)                        |
| ---------------------------------------- | ------------------------------------ |
| `{ every: "minute" }`                    | every tick                           |
| `{ every: "minutes", interval: 5 }`      | every 5 minutes, aligned to the hour |
| `{ every: "hour", minute: 41 }`          | hourly at :41                        |
| `{ every: "day", at: "03:17" }`          | daily                                |
| `{ every: "week", day: 1, at: "08:05" }` | Mondays                              |

Behaviour:

- **Due:** a job runs when its latest slot is newer than `job_state.last_slot`, so missed ticks
  catch up on the next run. Minute jobs run every tick.
- **Claims:** hourly and slower jobs claim their slot atomically before running, so overlapping
  cron invocations never run them twice. Minute jobs must be idempotent.
- **Budgets:** jobs share a D1 binding capped at `CRON_QUERY_BUDGET` (40) queries, minus 3 kept for
  the scheduler; `ctx.fetch` allows 40 subrequests. A job that hits a budget stops and runs next
  tick. `ctx.remainingQueries()` lets long jobs stop cleanly.
- **Order:** higher `priority` first, then the job that ran longest ago.
- **Errors:** caught per job, logged, stored in `job_state.last_error`; after three consecutive
  failures a job backs off 2, 4, 8 … up to 60 minutes.
- **Writes:** non-frequent jobs write their state row each run; minute jobs only when state changed,
  after an error or recovery, or once an hour as a heartbeat.

Foundation jobs: `auth.cleanup` (daily) and `sites.purge` (hourly, bounded deletes of soft-deleted
websites).
