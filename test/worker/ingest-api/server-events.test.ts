import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { createApiKey, createSite, createUser } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { seedFixture, V1, V2, V3 } from "../analytics/fixture";

beforeEach(() => resetDb());

const goalCount = async (siteId: string, where = "1=1") =>
  (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND type = 'custom' AND ${where}`,
  )
    .bind(siteId)
    .first<number>("n")) ?? 0;

describe("POST /api/v1/goals", () => {
  it("records a server-side goal on the visitor's latest session", async () => {
    const f = await seedFixture();
    const res = await api("/api/v1/goals", {
      token: f.key,
      body: {
        datafast_visitor_id: V2,
        name: "Newsletter Signup",
        description: "Form",
        metadata: { plan: "pro", seats: 3 },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data[0].message).toBe("Custom event created successfully");
    expect(res.body.data[0].eventId).toMatch(/^\d+$/);
    const row = await env.DB.prepare("SELECT * FROM events WHERE id = ?")
      .bind(Number(res.body.data[0].eventId))
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      session_id: f.sessions.C.id,
      visitor_id: V2,
      name: "newsletter_signup",
      path: "/pricing",
    });
    expect(JSON.parse(String(row?.props))).toEqual({ plan: "pro", seats: 3, $description: "Form" });
    // Visible to goal properties; `$description` is not a custom property.
    const props = await api("/api/v1/analytics/goals/properties?eventName=newsletter_signup", {
      token: f.key,
    });
    expect(props.body.data.map((r: { property: string }) => r.property).sort()).toEqual([
      "plan",
      "seats",
    ]);
    // visitorId alias
    const alias = await api("/api/v1/goals", { token: f.key, body: { visitorId: V1, name: "x" } });
    expect(alias.status).toBe(200);
  });

  it("writes 4 rows (event + 3 index entries)", async () => {
    const f = await seedFixture();
    const { meterEnv } = await import("../../helpers/db");
    const m = meterEnv();
    await m.db
      .prepare(
        "INSERT INTO events (site_id, ts, session_id, visitor_id, type, hostname, path, name) VALUES (?, ?, ?, ?, 'custom', 'example.com', '/', 'x')",
      )
      .bind(f.site.id, Date.now(), f.sessions.A.id, V1)
      .run();
    expect(m.d1.rowsWritten).toBe(4);
  });

  it.each([
    [{ name: "x" }, 400, "datafast_visitor_id is required"],
    [{ datafast_visitor_id: "nope", name: "x" }, 400, "UUID"],
    [{ datafast_visitor_id: V1, name: "identify" }, 400, "reserved"],
    [{ datafast_visitor_id: V1, name: "Bad!" }, 400, "name"],
    [{ datafast_visitor_id: V1, name: "x", metadata: { Bad: "1" } }, 400, "metadata keys"],
    [{ datafast_visitor_id: V1, name: "x", metadata: { a: "x".repeat(256) } }, 400, "255"],
    [
      {
        datafast_visitor_id: V1,
        name: "x",
        metadata: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"])),
      },
      400,
      "at most 10",
    ],
    [
      { datafast_visitor_id: "44444444-4444-4444-8444-444444444444", name: "x" },
      404,
      "no pageviews",
    ],
  ])("rejects %j", async (body, status, message) => {
    const f = await seedFixture();
    const res = await api("/api/v1/goals", { token: f.key, body });
    expect(res.status).toBe(status);
    expect(res.body.error.message).toContain(message);
  });

  it("rejects invalid JSON and needs goals:write", async () => {
    const f = await seedFixture();
    const bad = await api("/api/v1/goals", { token: f.key, method: "POST", body: "{nope" });
    expect(bad.status).toBe(400);
    const token = (
      await createApiKey({
        userId: f.owner.id,
        permissions: ["analytics:read"],
        websiteIds: [f.site.id],
      })
    ).secret;
    const res = await api(`/api/v1/goals?websiteId=${f.site.id}`, {
      token,
      body: { datafast_visitor_id: V1, name: "x" },
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/v1/goals", () => {
  it("deletes by visitor, by name and by range with DataFast's messages", async () => {
    const f = await seedFixture();
    const byVisitor = await api(`/api/v1/goals?datafast_visitor_id=${V1}`, {
      token: f.key,
      method: "DELETE",
    });
    expect(byVisitor.body.data[0]).toMatchObject({
      message: "Goal events deleted successfully for visitor",
      datafast_visitor_id: V1,
      deleted: 1,
    });
    expect(await goalCount(f.site.id)).toBe(1);
    const byName = await api(
      "/api/v1/goals?name=checkout_started&startAt=2026-03-11T00:00:00Z&endAt=2026-03-11T23:59:59Z",
      { token: f.key, method: "DELETE" },
    );
    expect(byName.body.data[0]).toEqual({
      message: "Goal events deleted successfully within time range",
      goal_name: "checkout_started",
      timeRange: { start: "2026-03-11T00:00:00.000Z", end: "2026-03-11T23:59:59.000Z" },
      deleted: 1,
    });
    expect(await goalCount(f.site.id)).toBe(0);
    // Pageviews are never touched.
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND type = 'pageview'",
      )
        .bind(f.site.id)
        .first("n"),
    ).toBe(7);
  });

  it("bulk deletes need a range; deprecated start/end work; payment goals are kept", async () => {
    const f = await seedFixture();
    await env.DB.prepare(
      "INSERT INTO events (site_id, ts, session_id, visitor_id, type, name) VALUES (?, ?, ?, ?, 'custom', 'payment')",
    )
      .bind(f.site.id, Date.parse("2026-03-10T10:06:00Z"), f.sessions.A.id, V1)
      .run();
    expect((await api("/api/v1/goals", { token: f.key, method: "DELETE" })).status).toBe(400);
    expect(
      (await api("/api/v1/goals?startAt=2026-03-10", { token: f.key, method: "DELETE" })).status,
    ).toBe(400);
    expect(
      (
        await api(
          "/api/v1/goals?startAt=2026-03-10&endAt=2026-03-11&start=2026-03-01&end=2026-03-02",
          {
            token: f.key,
            method: "DELETE",
          },
        )
      ).status,
    ).toBe(400);
    const res = await api("/api/v1/goals?start=2026-03-01&end=2026-03-31", {
      token: f.key,
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(res.body.data[0].deleted).toBe(2);
    expect(await goalCount(f.site.id)).toBe(1);
    expect((await api("/api/v1/goals?name=Bad!", { token: f.key, method: "DELETE" })).status).toBe(
      400,
    );
    expect(
      (await api("/api/v1/goals?datafast_visitor_id=x", { token: f.key, method: "DELETE" })).status,
    ).toBe(400);
  });

  it("invalidates rolled-up goal days so the rollup job rebuilds them", async () => {
    const f = await seedFixture();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO rollup_state (site_id, timezone, first_day, through_day, updated_at) VALUES (?, 'UTC', '2026-03-10', '2026-03-20', 0)",
      ).bind(f.site.id),
      env.DB.prepare(
        "INSERT INTO daily_goals (site_id, day, name, completions, visitors) VALUES (?, '2026-03-10', 'signup', 1, 1), (?, '2026-03-11', 'checkout_started', 1, 1)",
      ).bind(f.site.id, f.site.id),
    ]);
    await api("/api/v1/goals?name=signup", { token: f.key, method: "DELETE" });
    expect(
      await env.DB.prepare("SELECT through_day FROM rollup_state WHERE site_id = ?")
        .bind(f.site.id)
        .first("through_day"),
    ).toBe("2026-03-09");
    const rows = await env.DB.prepare("SELECT name FROM daily_goals WHERE site_id = ?")
      .bind(f.site.id)
      .all();
    expect(rows.results?.map((r) => r.name)).toEqual(["checkout_started"]);
  });
});

describe("POST /api/v1/identify", () => {
  it("creates, updates (shallow merge) and reports unchanged profiles", async () => {
    const f = await seedFixture();
    const first = await api("/api/v1/identify", {
      token: f.key,
      body: {
        user_id: "user_123",
        datafast_visitor_id: V1,
        email: "Jane@Example.com",
        plan: "pro",
        name: "Jane",
      },
    });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      message: "User profile created successfully",
      action: "created",
    });
    expect(first.body.data.profileId).toMatch(/^[0-9a-f]{24}$/);
    const row = await env.DB.prepare("SELECT * FROM visitors WHERE site_id = ? AND id = ?")
      .bind(f.site.id, V1)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({ user_id: "user_123", name: "Jane", email: "jane@example.com" });
    expect(row?.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(String(row?.profile))).toEqual({
      email: "jane@example.com",
      plan: "pro",
      name: "Jane",
    });

    const same = await api("/api/v1/identify", {
      token: f.key,
      body: { user_id: "user_123", datafast_visitor_id: V1, plan: "pro" },
    });
    expect(same.body.data.action).toBe("unchanged");
    expect(same.body.data.profileId).toBe(first.body.data.profileId);

    const upd = await api("/api/v1/identify", {
      token: f.key,
      body: {
        user_id: "user_123",
        datafast_visitor_id: V1,
        company: "Acme",
        name: "undefined undefined",
      },
    });
    expect(upd.body.data.action).toBe("updated");
    const after = await env.DB.prepare(
      "SELECT name, profile FROM visitors WHERE site_id = ? AND id = ?",
    )
      .bind(f.site.id, V1)
      .first<{ name: string; profile: string }>();
    expect(after?.name).toBe("Jane");
    expect(JSON.parse(after?.profile ?? "{}")).toMatchObject({
      plan: "pro",
      company: "Acme",
      name: "Jane",
    });

    const profile = await api(`/api/v1/visitors/${V1}`, { token: f.key });
    expect(profile.body.data.profile).toMatchObject({
      userId: "user_123",
      metadata: { plan: "pro", company: "Acme" },
    });
  });

  it("does not store emails when the website opts out, and skips cookieless websites", async () => {
    const f = await seedFixture();
    await env.DB.prepare("UPDATE sites SET store_customer_emails = 0 WHERE id = ?")
      .bind(f.site.id)
      .run();
    const { siteCache } = await import("../../../src/lib/site-cache");
    siteCache.clear();
    await api("/api/v1/identify", {
      token: f.key,
      body: { user_id: "u", datafast_visitor_id: V3, email: "a@b.co" },
    });
    const row = await env.DB.prepare(
      "SELECT email, email_hash, profile FROM visitors WHERE site_id = ? AND id = ?",
    )
      .bind(f.site.id, V3)
      .first<Record<string, unknown>>();
    expect(row?.email).toBeNull();
    expect(row?.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(String(row?.profile))).toEqual({});

    const owner = await createUser();
    const cookieless = await createSite(owner.id, { privacyMode: "cookieless" });
    const key = (await createApiKey({ userId: owner.id, siteId: cookieless.id })).secret;
    const res = await api("/api/v1/identify", {
      token: key,
      body: { user_id: "u", datafast_visitor_id: V1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty("action");
  });

  it.each([
    [{ datafast_visitor_id: V1 }, 400],
    [{ user_id: "u" }, 400],
    [{ user_id: "x".repeat(256), datafast_visitor_id: V1 }, 400],
    [{ user_id: "u", datafast_visitor_id: "not-a-uuid" }, 400],
    [{ user_id: "u", datafast_visitor_id: "44444444-4444-4444-8444-444444444444" }, 404],
  ])("rejects %j", async (body, status) => {
    const f = await seedFixture();
    expect((await api("/api/v1/identify", { token: f.key, body })).status).toBe(status);
  });

  it("needs identify:write", async () => {
    const f = await seedFixture();
    const token = (
      await createApiKey({
        userId: f.owner.id,
        permissions: ["goals:write"],
        websiteIds: [f.site.id],
      })
    ).secret;
    const res = await api(`/api/v1/identify?websiteId=${f.site.id}`, {
      token,
      body: { user_id: "u", datafast_visitor_id: V1 },
    });
    expect(res.status).toBe(403);
  });
});
