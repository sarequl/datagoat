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

Growth jobs (W6, `src/growth/index.ts`; details in [docs/growth/](../growth/README.md)):

| Job | Schedule | Does | Idle cost |
| --- | --- | --- | --- |
| `outbox.deliver` | minute (priority 5) | sends ≤ 10 pending emails/Telegram messages/webhooks, retries with backoff, writes alert history | 1 indexed read |
| `alerts.evaluate` | minute (priority 4) | goal and new-sale alerts from the last 3 minutes, deduplicated by outbox key | 1 read of `alerts` |
| `alerts.traffic-spike` | hourly :03 | traffic-spike rules and viral-traffic emails | 2 small reads |
| `alerts.digest` | every 10 min | daily (07:00 UTC) and weekly (Mondays) digests and weekly email reports, 8 sites per run with a cursor | nothing before 07:00 |
| `outbox.cleanup` | daily 03:41 | prunes settled outbox rows (30 d) and alert history (180 d) | 2 deletes |
| `attack.detect` | every 5 min | automatic attack mode on/off | 1 read |
| `bots.ip-ranges` | daily 04:11 | downloads published crawler IP ranges (13 subrequests) | rewrites only changed rows |
| `mentions.sync` | every 30 min | X/Reddit mentions, t.co → post mapping, link-in-bio profiles (3 sites per run) | 1 read |
| `github.sync` | hourly :37 | new commits and line stats (3 sites per run) | 1 read |
| `gsc.sync` | hourly :17 | Search Console daily refresh and 2-day backfill per run | 1 read |
| `meta.sync` | hourly :23 | Meta spend per selected campaign | 1 read |

W2 jobs (src/query/jobs): `query.rollups` (hourly at :07, closed days into the daily rollup tables,
changed rows only), `query.retention` (hourly at :23, bounded pruning of events past
`retention_days`, only for rolled-up days) and `query.predictions` (daily at 04:43, purchase-likelihood
models, written only when they change).
