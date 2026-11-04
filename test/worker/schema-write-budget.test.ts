/**
 * Guards the write budget of plan §7 at the schema level: the statements the ingest pipeline
 * runs per pageview must write exactly the rows the plan budgets (D1 counts the table row plus
 * one per index entry touched). Adding an index to `events`, `sessions` or `visitors` breaks
 * this test on purpose; justify the index against the budget table and update both.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { meterEnv, resetDb } from "../helpers/db";

const insertEvent = (db: D1Database, sessionId: string) =>
  db
    .prepare(
      "INSERT INTO events (site_id, ts, session_id, visitor_id, type, hostname, path) VALUES ('site1', ?, ?, 'v1', 'pageview', 'example.com', '/')",
    )
    .bind(Date.now(), sessionId);

const upsertSession = (db: D1Database, sessionId: string) =>
  db
    .prepare(
      `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, session_number, entry_path, exit_path,
         pageviews, channel, country, device, browser, os)
       VALUES ('site1', ?, 'v1', ?, ?, 1, '/', '/', 1, 'Direct', 'US', 'desktop', 'Chrome', 'Mac OS')
       ON CONFLICT (site_id, id) DO UPDATE SET last_seen_at = excluded.last_seen_at,
         exit_path = excluded.exit_path, pageviews = pageviews + 1`,
    )
    .bind(sessionId, Date.now(), Date.now());

const insertVisitor = (db: D1Database) =>
  db
    .prepare(
      "INSERT OR IGNORE INTO visitors (site_id, id, first_seen_at, first_session_id) VALUES ('site1', 'v1', ?, 's-a')",
    )
    .bind(Date.now());

describe("schema write budget (plan §7)", () => {
  beforeEach(() => resetDb());

  it("first pageview of a new visitor writes 6 rows", async () => {
    const m = meterEnv();
    await m.db.batch([insertEvent(m.db, "s-a"), upsertSession(m.db, "s-a"), insertVisitor(m.db)]);
    expect(m.d1.rowsWritten).toBe(6);
    expect(m.d1.queries).toBe(1);
  });

  it("first pageview of a new session for a known visitor writes 5 rows", async () => {
    await insertVisitor(env.DB).run();
    const m = meterEnv();
    await m.db.batch([insertEvent(m.db, "s-b"), upsertSession(m.db, "s-b"), insertVisitor(m.db)]);
    expect(m.d1.rowsWritten).toBe(5);
  });

  it("a pageview within an existing session writes 3 rows", async () => {
    await env.DB.batch([upsertSession(env.DB, "s-a"), insertVisitor(env.DB)]);
    const m = meterEnv();
    await m.db.batch([insertEvent(m.db, "s-a"), upsertSession(m.db, "s-a")]);
    expect(m.d1.rowsWritten).toBe(3);
  });

  it("an INSERT OR IGNORE on an existing visitor writes nothing", async () => {
    await insertVisitor(env.DB).run();
    const m = meterEnv();
    await insertVisitor(m.db).run();
    expect(m.d1.rowsWritten).toBe(0);
  });

  it("hot tables carry only the budgeted indexes", async () => {
    const res = await env.DB.prepare(
      "SELECT tbl_name, name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('events','sessions','visitors') AND sql IS NOT NULL ORDER BY name",
    ).all<{ tbl_name: string; name: string }>();
    expect((res.results ?? []).map((r) => r.name)).toEqual([
      "events_time",
      "sessions_time",
      "sessions_visitor",
      "visitors_email",
      "visitors_user",
    ]);
  });
});
