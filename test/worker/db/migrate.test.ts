import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/app";
import {
  applyPendingMigrations,
  ensureSchema,
  resetSchemaState,
  SchemaNotReadyError,
} from "../../../src/db/migrate";
import { MIGRATIONS } from "../../../src/db/migrations.generated";
import { splitSqlStatements } from "../../../src/db/sql-split";

async function dropEverything(db: D1Database): Promise<void> {
  const res = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    )
    .all<{ name: string }>();
  const names = (res.results ?? []).map((r) => r.name);
  if (names.length) await db.batch(names.map((n) => db.prepare(`DROP TABLE "${n}"`)));
}

async function tableCount(db: D1Database): Promise<number> {
  return (
    (
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
        )
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

async function call(
  app: ReturnType<typeof createApp>,
  base: Cloudflare.Env,
  path: string,
  init: RequestInit = {},
) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://datagoat.test${path}`, init), base, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(async () => {
  resetSchemaState();
  await dropEverything(env.EMPTY_DB);
});

describe("self-applying migrations", () => {
  it("completes first-run setup on an empty, unmigrated database", async () => {
    expect(await tableCount(env.EMPTY_DB)).toBe(0);
    const emptyEnv = { ...env, DB: env.EMPTY_DB };
    const app = createApp();
    const status = await call(app, emptyEnv, "/api/setup");
    expect(await status.json()).toEqual({
      status: "success",
      data: { needsSetup: true, configErrors: [] },
    });
    const res = await call(app, emptyEnv, "/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://datagoat.test" },
      body: JSON.stringify({
        token: env.SETUP_TOKEN,
        email: "owner@example.com",
        password: "a-long-password",
        website: { domain: "example.com" },
      }),
    });
    expect(res.status).toBe(200);
    const names = await env.EMPTY_DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{
      name: string;
    }>();
    expect(names.results?.map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));
    expect(await env.EMPTY_DB.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(1);
  });

  it("is idempotent: a second run applies nothing", async () => {
    expect((await applyPendingMigrations(env.EMPTY_DB)).applied).toEqual(
      MIGRATIONS.map((m) => m.name),
    );
    expect(await applyPendingMigrations(env.EMPTY_DB)).toEqual({
      applied: [],
      alreadyApplied: MIGRATIONS.map((m) => m.name),
    });
  });

  it("detects a database migrated by wrangler as current", async () => {
    // env.DB was migrated by applyD1Migrations (wrangler's d1_migrations bookkeeping).
    const result = await applyPendingMigrations(env.DB);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual(MIGRATIONS.map((m) => m.name));
  });

  it("applies a migration added later", async () => {
    await applyPendingMigrations(env.EMPTY_DB);
    const later = [
      ...MIGRATIONS,
      {
        name: "9999_later.sql",
        sql: "-- added later\nCREATE TABLE later_feature (id INTEGER PRIMARY KEY, note TEXT);\nINSERT INTO later_feature (note) VALUES ('a;b');\n",
      },
    ];
    expect((await applyPendingMigrations(env.EMPTY_DB, later)).applied).toEqual(["9999_later.sql"]);
    expect(await env.EMPTY_DB.prepare("SELECT note FROM later_feature").first("note")).toBe("a;b");
  });

  it("rolls back a failing migration and reports it", async () => {
    await applyPendingMigrations(env.EMPTY_DB);
    const broken = [
      ...MIGRATIONS,
      {
        name: "9998_broken.sql",
        sql: "CREATE TABLE half_done (id INTEGER); SELECT * FROM no_such_table;",
      },
    ];
    await expect(applyPendingMigrations(env.EMPTY_DB, broken)).rejects.toBeInstanceOf(
      SchemaNotReadyError,
    );
    expect(
      await env.EMPTY_DB.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half_done'",
      ).first("n"),
    ).toBe(0);
    expect(
      await env.EMPTY_DB.prepare(
        "SELECT COUNT(*) AS n FROM d1_migrations WHERE name = '9998_broken.sql'",
      ).first("n"),
    ).toBe(0);
  });

  it("survives concurrent first requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => applyPendingMigrations(env.EMPTY_DB)),
    );
    expect(results.flatMap((r) => r.applied)).toEqual(MIGRATIONS.map((m) => m.name));
    expect(await env.EMPTY_DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first("n")).toBe(
      MIGRATIONS.length,
    );
    const app = createApp();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => call(app, { ...env, DB: env.EMPTY_DB }, "/api/setup")),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
  });

  it("checks the schema once per isolate", async () => {
    let batches = 0;
    const counting = new Proxy(env.EMPTY_DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "batch") {
          return (...a: unknown[]) => {
            batches++;
            return (v as (...x: unknown[]) => unknown).apply(target, a);
          };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    await ensureSchema(counting);
    const after = batches;
    await ensureSchema(counting);
    await ensureSchema(counting);
    expect(batches).toBe(after);
  });

  it("answers 503 with the reason when the database cannot be initialised", async () => {
    const broken = {
      prepare: () => ({
        bind() {
          return this;
        },
      }),
      batch: async () => {
        throw new Error("D1_ERROR: database unavailable");
      },
    } as unknown as D1Database;
    const res = await call(createApp(), { ...env, DB: broken }, "/api/setup");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "error",
      error: { code: 503, message: "Database is not initialised: D1_ERROR: database unavailable" },
    });
  });

  it("reports schema status on the health endpoint", async () => {
    const res = await call(createApp(), env, "/api/health");
    expect(await res.json()).toEqual({
      status: "success",
      data: { ok: true, schema: "current", migrations: MIGRATIONS.length },
    });
  });
});

describe("splitSqlStatements", () => {
  it("splits on semicolons outside strings, comments and trigger bodies", () => {
    const sql = `-- comment; not a statement
CREATE TABLE a (x TEXT DEFAULT 'it''s; fine'); /* block; comment */
INSERT INTO a VALUES ("q;uoted");
CREATE TRIGGER t AFTER INSERT ON a BEGIN
  UPDATE a SET x = 'y'; DELETE FROM a WHERE x = 'z';
END;
SELECT 1`;
    expect(splitSqlStatements(sql)).toEqual([
      "CREATE TABLE a (x TEXT DEFAULT 'it''s; fine')",
      'INSERT INTO a VALUES ("q;uoted")',
      "CREATE TRIGGER t AFTER INSERT ON a BEGIN\n  UPDATE a SET x = 'y'; DELETE FROM a WHERE x = 'z';\nEND",
      "SELECT 1",
    ]);
  });

  it("splits the real init migration into its statements", () => {
    const statements = splitSqlStatements(MIGRATIONS[0]?.sql ?? "");
    expect(statements.length).toBe(76);
    expect(statements.every((s) => s.startsWith("CREATE "))).toBe(true);
  });
});
