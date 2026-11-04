import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { JOBS } from "../../../src/jobs";
import { currentSlot, type JobDefinition, validateJobs } from "../../../src/jobs/registry";
import { runScheduled } from "../../../src/jobs/scheduler";
import { meterEnv, resetDb } from "../../helpers/db";

beforeEach(() => resetDb());

const T = Date.UTC(2026, 10, 4, 10, 30); // Wednesday 10:30 UTC
const MIN = 60_000;

async function run(jobs: JobDefinition[], at: number, base: Cloudflare.Env = env) {
  const ctx = createExecutionContext();
  const result = await runScheduled(jobs, base, ctx, at);
  await waitOnExecutionContext(ctx);
  return result;
}

const status = (r: Awaited<ReturnType<typeof run>>, name: string) =>
  r.results.find((x) => x.name === name)?.status;

describe("schedules", () => {
  it("computes slots in UTC", () => {
    expect(currentSlot({ every: "minute" }, T + 5000)).toBe(T);
    expect(currentSlot({ every: "minutes", interval: 15 }, T + 4 * MIN)).toBe(T);
    expect(new Date(currentSlot({ every: "hour", minute: 41 }, T)).toISOString()).toBe(
      "2026-11-04T09:41:00.000Z",
    );
    expect(new Date(currentSlot({ every: "day", at: "03:17" }, T)).toISOString()).toBe(
      "2026-11-04T03:17:00.000Z",
    );
    expect(new Date(currentSlot({ every: "day", at: "23:00" }, T)).toISOString()).toBe(
      "2026-11-03T23:00:00.000Z",
    );
    expect(new Date(currentSlot({ every: "week", day: 1, at: "08:05" }, T)).toISOString()).toBe(
      "2026-11-02T08:05:00.000Z",
    );
    expect(new Date(currentSlot({ every: "week", day: 5, at: "08:05" }, T)).toISOString()).toBe(
      "2026-10-30T08:05:00.000Z",
    );
    expect(new Date(currentSlot({ every: "week", day: 3, at: "10:30" }, T)).toISOString()).toBe(
      "2026-11-04T10:30:00.000Z",
    );
  });

  it("validates job names and schedules", () => {
    expect(() => validateJobs(JOBS)).not.toThrow();
    const noop = async () => {};
    expect(() =>
      validateJobs([{ name: "Bad Name", schedule: { every: "minute" }, run: noop }]),
    ).toThrow();
    expect(() =>
      validateJobs([{ name: "a.b", schedule: { every: "day", at: "25:00" }, run: noop }]),
    ).toThrow();
    expect(() =>
      validateJobs([
        { name: "a.b", schedule: { every: "minute" }, run: noop },
        { name: "a.b", schedule: { every: "minute" }, run: noop },
      ]),
    ).toThrow("Duplicate");
  });
});

describe("runScheduled", () => {
  it("runs daily jobs once per slot and catches up after missed ticks", async () => {
    let runs = 0;
    const job: JobDefinition = {
      name: "test.daily",
      schedule: { every: "day", at: "03:00" },
      run: async () => void runs++,
    };
    await run([job], T);
    await run([job], T + MIN);
    expect(runs).toBe(1);
    // Next day, the 03:00 tick was missed; 03:07 still runs it.
    await run([job], Date.UTC(2026, 10, 5, 3, 7));
    expect(runs).toBe(2);
  });

  it("never runs a claimed slot twice, even for overlapping invocations", async () => {
    let runs = 0;
    const job: JobDefinition = {
      name: "test.hourly",
      schedule: { every: "hour" },
      run: async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 20));
      },
    };
    const [a, b] = await Promise.all([run([job], T), run([job], T + 1000)]);
    expect(runs).toBe(1);
    expect([status(a, "test.hourly"), status(b, "test.hourly")].sort()).toEqual([
      "claimed_elsewhere",
      "ok",
    ]);
  });

  it("isolates errors, records them, and backs off after three failures", async () => {
    let good = 0;
    let bad = 0;
    const jobs: JobDefinition[] = [
      {
        name: "test.bad",
        schedule: { every: "minute" },
        priority: 1,
        run: async () => {
          bad++;
          throw new Error("boom");
        },
      },
      { name: "test.good", schedule: { every: "minute" }, run: async () => void good++ },
    ];
    for (let i = 0; i < 3; i++) await run(jobs, T + i * MIN);
    expect([bad, good]).toEqual([3, 3]);
    const row = await env.DB.prepare("SELECT * FROM job_state WHERE name = 'test.bad'").first<
      Record<string, unknown>
    >();
    expect(row).toMatchObject({ last_error: "boom", consecutive_failures: 3 });
    const r4 = await run(jobs, T + 3 * MIN);
    expect(status(r4, "test.bad")).toBe("skipped_backoff");
    expect(good).toBe(4);
    await run(jobs, T + 10 * MIN);
    expect(bad).toBe(4);
  });

  it("persists state for frequent jobs only when it changes", async () => {
    const job: JobDefinition = {
      name: "test.cursor",
      schedule: { every: "minute" },
      run: async (ctx) => {
        const cursor = (ctx.state as { n: number } | null)?.n ?? 0;
        if (cursor < 2) ctx.setState({ n: cursor + 1 });
      },
    };
    const m = meterEnv();
    await run([job], T, m.env); // state {n: 1}
    m.reset();
    await run([job], T + MIN, m.env); // state {n: 2}: one write
    await run([job], T + 2 * MIN, m.env); // unchanged: no write
    await run([job], T + 3 * MIN, m.env); // unchanged: no write
    const row = await env.DB.prepare(
      "SELECT state FROM job_state WHERE name = 'test.cursor'",
    ).first<{ state: string }>();
    expect(JSON.parse(row?.state ?? "null")).toEqual({ n: 2 });
    expect(m.d1.rowsWritten).toBe(1);
  });

  it("writes nothing for idle frequent jobs within the heartbeat window", async () => {
    const job: JobDefinition = {
      name: "test.idle",
      schedule: { every: "minute" },
      run: async () => {},
    };
    await run([job], T);
    const m = meterEnv();
    await run([job], T + MIN, m.env);
    expect(m.d1.rowsWritten).toBe(0);
    expect(m.d1.queries).toBe(1);
  });

  it("stops at the query budget and leaves remaining jobs due", async () => {
    const hungry: JobDefinition = {
      name: "test.hungry",
      schedule: { every: "minute" },
      priority: 2,
      run: async (ctx) => {
        for (let i = 0; i < 100; i++) await ctx.db.prepare("SELECT 1").all();
      },
    };
    let later = 0;
    const daily: JobDefinition = {
      name: "test.later",
      schedule: { every: "day", at: "00:00" },
      run: async () => void later++,
    };
    const r = await run([hungry, daily], T, { ...env, CRON_QUERY_BUDGET: "10" });
    expect(status(r, "test.hungry")).toBe("skipped_budget");
    expect(status(r, "test.later")).toBe("skipped_budget");
    expect(r.queriesUsed).toBeLessThanOrEqual(10);
    expect(later).toBe(0);
    await run([daily], T + MIN);
    expect(later).toBe(1);
  });

  it("caps subrequests made with ctx.fetch", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("ok");
    }) as typeof fetch;
    let error = "";
    const job: JobDefinition = {
      name: "test.fetch",
      schedule: { every: "minute" },
      run: async (ctx) => {
        for (let i = 0; i < 40; i++) await ctx.fetch("https://provider.example/api");
        error = await ctx.fetch("https://provider.example/api").then(
          () => "",
          (e: Error) => e.message,
        );
      },
    };
    try {
      await run([job], T);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toBe(40);
    expect(error).toContain("Subrequest budget");
  });
});
