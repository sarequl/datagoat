import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { maintenanceJobs, siteScopedTables } from "../../../src/jobs/maintenance";
import { runScheduled } from "../../../src/jobs/scheduler";
import { resetDb, tableNames } from "../../helpers/db";
import {
  createApiKey,
  createEvent,
  createPayment,
  createSession,
  createSite,
  createUser,
} from "../../helpers/factories";

beforeEach(() => resetDb());

const purge = maintenanceJobs.filter((j) => j.name === "sites.purge");
const cleanup = maintenanceJobs.filter((j) => j.name === "auth.cleanup");

describe("sites.purge", () => {
  it("discovers every site-scoped table from the schema", async () => {
    const tables = await siteScopedTables(env.DB);
    const names = tables.map((t) => t.name);
    expect(names[0]).toBe("events");
    expect(names).toContain("memberships");
    expect(names).not.toContain("sites");
    expect(tables.find((t) => t.name === "sessions")?.key).toEqual(["site_id", "id"]);
    expect(tables.find((t) => t.name === "events")?.key).toEqual(["rowid"]);
    // Every table that has a site_id column is covered.
    for (const name of await tableNames()) {
      const cols = await env.DB.prepare(`PRAGMA table_info("${name}")`).all<{ name: string }>();
      const hasSite = (cols.results ?? []).some((c) => c.name === "site_id");
      if (hasSite && name !== "sites") expect(names).toContain(name);
    }
  });

  it("deletes a soft-deleted site's data in bounded chunks, then the site", async () => {
    const owner = await createUser();
    const doomed = await createSite(owner.id);
    const kept = await createSite(owner.id);
    await createApiKey({ userId: owner.id, siteId: doomed.id });
    for (let i = 0; i < 3; i++) {
      const s = await createSession({ siteId: doomed.id, startedAt: Date.now() - i * 1000 });
      await createEvent({ siteId: doomed.id, session: s });
      await createEvent({ siteId: doomed.id, session: s, path: "/b" });
    }
    await createPayment({ siteId: doomed.id, amountMinor: 100, occurredAt: Date.now() });
    const k = await createSession({ siteId: kept.id, startedAt: Date.now() });
    await createEvent({ siteId: kept.id, session: k });
    await env.DB.prepare("UPDATE sites SET deleted_at = ? WHERE id = ?")
      .bind(Date.now(), doomed.id)
      .run();

    const tick = async (at: number) =>
      runScheduled(
        purge,
        { ...env, PURGE_ROWS_PER_RUN: "4" } as Cloudflare.Env,
        createExecutionContext(),
        at,
      );
    const count = async () =>
      (
        await env.DB.prepare(
          "SELECT (SELECT COUNT(*) FROM events WHERE site_id = ?1) + (SELECT COUNT(*) FROM sessions WHERE site_id = ?1) + (SELECT COUNT(*) FROM visitors WHERE site_id = ?1) + (SELECT COUNT(*) FROM payments WHERE site_id = ?1) + (SELECT COUNT(*) FROM api_keys WHERE site_id = ?1) AS n",
        )
          .bind(doomed.id)
          .first<{ n: number }>()
      )?.n ?? 0;
    expect(await count()).toBe(14);
    const hour = 3_600_000;
    let at = Date.UTC(2026, 0, 1, 0, 41);
    const first = await tick(at);
    expect(first.results[0]?.status).toBe("ok");
    expect(await count()).toBe(10);
    for (let i = 0; i < 6; i++) {
      at += hour;
      await tick(at);
    }
    expect(await count()).toBe(0);
    expect(
      await env.DB.prepare("SELECT id FROM sites WHERE id = ?").bind(doomed.id).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE site_id = ?")
        .bind(doomed.id)
        .first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE site_id = ?")
        .bind(kept.id)
        .first("n"),
    ).toBe(1);
  });

  it("does nothing (one read) when no site is deleted", async () => {
    await createSite(null);
    const r = await runScheduled(purge, env, createExecutionContext(), Date.UTC(2026, 0, 1, 0, 41));
    expect(r.results[0]?.status).toBe("ok");
  });
});

describe("auth.cleanup", () => {
  it("removes expired sessions, used resets and expired idempotency keys", async () => {
    const user = await createUser();
    const now = Date.UTC(2026, 5, 1, 3, 17);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO auth_sessions (id_hash, user_id, created_at, expires_at) VALUES ('old', ?, 0, 1), ('live', ?, 0, ?)",
      ).bind(user.id, user.id, now + 1000),
      env.DB.prepare(
        "INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, used_at) VALUES ('r', ?, 0, ?, 5)",
      ).bind(user.id, now + 1000),
      env.DB.prepare(
        "INSERT INTO idempotency_keys (scope, key, request_hash, created_at, expires_at) VALUES ('s','k','h',0,1)",
      ),
    ]);
    await runScheduled(cleanup, env, createExecutionContext(), now);
    const sessions = await env.DB.prepare("SELECT id_hash FROM auth_sessions").all<{
      id_hash: string;
    }>();
    expect(sessions.results?.map((r) => r.id_hash)).toEqual(["live"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM password_resets").first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").first("n")).toBe(0);
  });
});
