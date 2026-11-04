import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  chunk,
  chunkForParams,
  createD1Meter,
  firstWithMeta,
  parseJsonColumn,
  placeholders,
  QueryBudgetExceeded,
  runBatch,
  selectInChunks,
} from "../../../src/lib/d1";
import { escapeLike, join, list, prepare, raw, sql } from "../../../src/lib/sql";
import { resetDb } from "../../helpers/db";

beforeEach(() => resetDb());

async function seedFxRates(n: number) {
  const stmts = Array.from({ length: n }, (_, i) =>
    env.DB.prepare(
      "INSERT INTO fx_rates (day, currency, per_usd) VALUES ('2026-01-01', ?, ?)",
    ).bind(`C${i}`, i),
  );
  await runBatch(env.DB, stmts);
}

describe("D1 helpers", () => {
  it("chunks arrays and IN lists under 100 bound parameters", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(
      chunkForParams(
        Array.from({ length: 250 }, (_, i) => i),
        10,
      ).map((c) => c.length),
    ).toEqual([90, 90, 70]);
    expect(() => chunkForParams([1], 100)).toThrow();
    expect(placeholders(3)).toBe("?, ?, ?");
  });

  it("runs statements in batches and selects across many IN chunks in one query", async () => {
    await seedFxRates(230);
    const meter = createD1Meter(env.DB);
    const codes = Array.from({ length: 230 }, (_, i) => `C${i}`);
    const rows = await selectInChunks<{ currency: string }, string>(
      meter.db,
      codes,
      1,
      (ph, values) =>
        meter.db
          .prepare(`SELECT currency FROM fx_rates WHERE day = ? AND currency IN (${ph})`)
          .bind("2026-01-01", ...values),
    );
    expect(rows).toHaveLength(230);
    expect(meter.usage.queries).toBe(1);
  });

  it("meters first() and raw() through all() so meta is counted", async () => {
    await seedFxRates(5);
    const meter = createD1Meter(env.DB);
    const row = await meter.db.prepare("SELECT COUNT(*) AS n FROM fx_rates").first<{ n: number }>();
    expect(row?.n).toBe(5);
    expect(await meter.db.prepare("SELECT COUNT(*) AS n FROM fx_rates").first("n")).toBe(5);
    const arrays = await meter.db
      .prepare("SELECT currency, per_usd FROM fx_rates ORDER BY per_usd LIMIT 2")
      .raw({ columnNames: true });
    expect(arrays).toEqual([
      ["currency", "per_usd"],
      ["C0", 0],
      ["C1", 1],
    ]);
    expect(meter.usage.queries).toBe(3);
    expect(meter.usage.rowsRead).toBeGreaterThanOrEqual(15);
    await meter.db
      .prepare("INSERT INTO fx_rates (day, currency, per_usd) VALUES ('2026-01-02','X',1)")
      .run();
    expect(meter.usage.rowsWritten).toBe(1);
    meter.reset();
    expect(meter.usage).toEqual({ queries: 0, statements: 0, rowsRead: 0, rowsWritten: 0 });
  });

  it("enforces a query budget", async () => {
    const meter = createD1Meter(env.DB, { maxQueries: 2 });
    await meter.db.prepare("SELECT 1").all();
    await meter.db.batch([meter.db.prepare("SELECT 1"), meter.db.prepare("SELECT 2")]);
    await expect(meter.db.prepare("SELECT 1").all()).rejects.toBeInstanceOf(QueryBudgetExceeded);
  });

  it("keeps meta on firstWithMeta and parses JSON columns", async () => {
    const { row, meta } = await firstWithMeta<{ x: number }>(env.DB.prepare("SELECT 1 AS x"));
    expect(row?.x).toBe(1);
    expect(meta).toHaveProperty("rows_read");
    expect(parseJsonColumn('["a"]', [])).toEqual(["a"]);
    expect(parseJsonColumn("{bad", [])).toEqual([]);
    expect(parseJsonColumn(null, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("sql builder", () => {
  it("binds values and splices fragments in order", async () => {
    const where = join([sql`currency = ${"EUR"}`, sql`per_usd > ${0.5}`]);
    const q = sql`SELECT ${raw("1")} AS one, ${true} AS t WHERE ${where} OR ${list(["a", "b"])} IS NOT NULL`;
    expect(q.sql).toBe(
      "SELECT 1 AS one, ? AS t WHERE ((currency = ?) AND (per_usd > ?)) OR (?, ?) IS NOT NULL",
    );
    expect(q.params).toEqual([1, "EUR", 0.5, "a", "b"]);
  });

  it("joins empty lists to neutral predicates and parenthesises OR", () => {
    expect(join([]).sql).toBe("1=1");
    expect(join([], " OR ").sql).toBe("1=0");
    expect(join([sql`a = ${1}`, sql`b = ${2}`], " OR ").sql).toBe("((a = ?) OR (b = ?))");
  });

  it("refuses more than 100 bound parameters", () => {
    const many = sql`SELECT 1 WHERE x IN ${list(Array.from({ length: 101 }, (_, i) => i))}`;
    expect(() => prepare(env.DB, many)).toThrow("100");
  });

  it("escapes LIKE wildcards", async () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
    const row = await prepare(
      env.DB,
      sql`SELECT ${"a50%x"} LIKE ${`%${escapeLike("50%")}%`} ESCAPE '\\' AS hit, ${"a50x"} LIKE ${`%${escapeLike("50%")}%`} ESCAPE '\\' AS miss`,
    ).first<{ hit: number; miss: number }>();
    expect(row).toEqual({ hit: 1, miss: 0 });
  });
});
