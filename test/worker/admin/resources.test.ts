import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { addMember, createApiKey, createUser, sessionCookie } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { RANGE, seedFixture } from "../analytics/fixture";

beforeEach(() => resetDb());

const W = (id: string) => `/api/v1/admin/websites/${id}`;

describe("tracked goals and goal customizations", () => {
  it("lists tracked goals with counts and customization fields", async () => {
    const f = await seedFixture();
    const now = Date.now();
    const { createSession, createEvent } = await import("../../helpers/factories");
    const s = await createSession({ siteId: f.site.id, startedAt: now - 3_600_000 });
    await createEvent({
      siteId: f.site.id,
      session: s,
      ts: now - 3_000_000,
      type: "custom",
      name: "signup",
    });
    await createEvent({
      siteId: f.site.id,
      session: s,
      ts: now - 2_000_000,
      type: "custom",
      name: "signup",
    });
    await api(`${W(f.site.id)}/goals/customizations`, {
      token: f.key,
      method: "PATCH",
      body: { goalName: "signup", displayName: "Signed up", color: "#8DCDFF" },
    });
    const res = await api(`${W(f.site.id)}/goals`, { token: f.key });
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toEqual({
      name: "signup",
      displayName: "Signed up",
      color: "#8dcdff",
      description: null,
      hidden: false,
      total: 2,
      uv: 1,
      conversionRate: 1,
      eventType: "custom",
    });
  });

  it("PATCH creates/updates, null clears, GET filters, DELETE resets", async () => {
    const f = await seedFixture();
    const url = `${W(f.site.id)}/goals/customizations`;
    const first = await api(url, {
      token: f.key,
      method: "PATCH",
      body: {
        goalName: "Signup Started",
        displayName: "Signup started",
        description: "Opened the flow",
      },
    });
    expect(first.status).toBe(200);
    expect(first.body.data[0]).toMatchObject({
      goalName: "signup_started",
      displayName: "Signup started",
      color: null,
      description: "Opened the flow",
      hidden: false,
    });
    expect(first.body.colors.length).toBeGreaterThan(5);
    const second = await api(url, {
      token: f.key,
      method: "PATCH",
      body: { goalName: "signup_started", description: null, hidden: true },
    });
    expect(second.body.data[0]).toMatchObject({
      displayName: "Signup started",
      description: null,
      hidden: true,
    });
    await api(url, {
      token: f.key,
      method: "PATCH",
      body: { goalName: "other", color: "#ff5861" },
    });
    const one = await api(`${url}?goalName=signup_started`, { token: f.key });
    expect(one.body.data).toHaveLength(1);
    const all = await api(url, { token: f.key });
    expect(all.body.data).toHaveLength(2);
    const del = await api(`${url}?goalName=signup_started`, { token: f.key, method: "DELETE" });
    expect(del.body.data).toEqual([{ deleted: true, goalName: "signup_started" }]);
    const again = await api(`${url}?goalName=signup_started`, { token: f.key, method: "DELETE" });
    expect(again.body.data).toEqual([{ deleted: false, goalName: "signup_started" }]);
  });

  it.each([
    [{ goalName: "x" }, "at least one"],
    [{ goalName: "x", color: "#123456" }, "palette"],
    [{ goalName: "x", displayName: "a".repeat(81) }, "displayName"],
    [{ goalName: "identify", hidden: true }, "reserved"],
    [{ goalName: "x", unknown: 1 }, "Unrecognized"],
  ])("PATCH rejects %j", async (body, message) => {
    const f = await seedFixture();
    const res = await api(`${W(f.site.id)}/goals/customizations`, {
      token: f.key,
      method: "PATCH",
      body,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(message);
  });

  it("PATCH rejects bodies over 4 KB and DELETE needs goalName", async () => {
    const f = await seedFixture();
    const big = await api(`${W(f.site.id)}/goals/customizations`, {
      token: f.key,
      method: "PATCH",
      body: { goalName: "x", description: "a".repeat(5000) },
    });
    expect(big.status).toBe(413);
    const del = await api(`${W(f.site.id)}/goals/customizations`, {
      token: f.key,
      method: "DELETE",
    });
    expect(del.status).toBe(400);
  });

  it("needs goals:read / goals:write / settings:read", async () => {
    const f = await seedFixture();
    const token = (
      await createApiKey({
        userId: f.owner.id,
        permissions: ["analytics:read"],
        websiteIds: [f.site.id],
      })
    ).secret;
    expect((await api(`${W(f.site.id)}/goals`, { token })).status).toBe(403);
    expect((await api(`${W(f.site.id)}/goals/customizations`, { token })).status).toBe(403);
  });
});

describe("notes", () => {
  it("creates (201), replays (200), conflicts (409), lists, searches, updates and deletes", async () => {
    const f = await seedFixture();
    const url = `${W(f.site.id)}/notes`;
    const ts = new Date(Date.now() - 86_400_000).toISOString();
    const created = await api(url, {
      token: f.key,
      body: { text: "  Launched the landing page  ", timestamp: ts, idempotencyKey: "sha.abc123" },
    });
    expect(created.status).toBe(201);
    const note = created.body.data[0];
    expect(note).toMatchObject({
      websiteId: f.site.id,
      text: "Launched the landing page",
      timestamp: ts,
      author: { id: f.owner.id },
    });
    const replay = await api(url, {
      token: f.key,
      body: { text: "Launched the landing page", timestamp: ts, idempotencyKey: "sha.abc123" },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data[0].id).toBe(note.id);
    const conflict = await api(url, {
      token: f.key,
      body: { text: "Different", timestamp: ts, idempotencyKey: "sha.abc123" },
    });
    expect(conflict.status).toBe(409);
    await api(url, { token: f.key, body: { text: "Pricing change", timestamp: "2026-03-10" } });

    const list = await api(url, { token: f.key });
    expect(list.body.data.map((n: { id: string }) => n.id)).toEqual([note.id]);
    expect(list.body.pagination).toEqual({ limit: 100, offset: 0, total: 1, hasMore: false });
    const march = await api(`${url}?${RANGE}&q=PRICING&order=asc`, { token: f.key });
    expect(march.body.data).toHaveLength(1);
    expect(march.body.data[0].timestamp).toBe("2026-03-10T00:00:00.000Z");

    const updated = await api(`${url}/${note.id}`, {
      token: f.key,
      method: "PUT",
      body: { text: "Edited" },
    });
    expect(updated.body.data[0]).toMatchObject({ id: note.id, text: "Edited", timestamp: ts });
    const deleted = await api(`${url}/${note.id}`, { token: f.key, method: "DELETE" });
    expect(deleted.body.data).toEqual([{ id: note.id, deleted: true }]);
    expect((await api(`${url}/${note.id}`, { token: f.key, method: "DELETE" })).status).toBe(404);
  });

  it.each([
    ["POST", { text: "", timestamp: "2026-01-01" }, 400],
    ["POST", { text: "a".repeat(501), timestamp: "2026-01-01" }, 400],
    ["POST", { text: "x", timestamp: "2026-01-01T10:00:00" }, 400],
    ["POST", { text: "x", timestamp: "2026-01-01", idempotencyKey: "bad key!" }, 400],
  ])("%s rejects invalid bodies", async (method, body, status) => {
    const f = await seedFixture();
    const res = await api(`${W(f.site.id)}/notes`, { token: f.key, method, body });
    expect(res.status).toBe(status);
  });

  it("rejects unknown list parameters and needs notes permissions", async () => {
    const f = await seedFixture();
    expect((await api(`${W(f.site.id)}/notes?foo=1`, { token: f.key })).status).toBe(400);
    expect((await api(`${W(f.site.id)}/notes?order=up`, { token: f.key })).status).toBe(400);
    const token = (
      await createApiKey({
        userId: f.owner.id,
        permissions: ["notes:read"],
        websiteIds: [f.site.id],
      })
    ).secret;
    expect((await api(`${W(f.site.id)}/notes`, { token })).status).toBe(200);
    const write = await api(`${W(f.site.id)}/notes`, {
      token,
      body: { text: "x", timestamp: "2026-01-01" },
    });
    expect(write.status).toBe(403);
  });

  it("keys are scoped per author", async () => {
    const f = await seedFixture();
    const other = await createUser();
    await addMember(f.site.id, other.id, "member");
    const cookie = await sessionCookie(other.id);
    const body = { text: "Same key", timestamp: "2026-01-01", idempotencyKey: "k1" };
    expect((await api(`${W(f.site.id)}/notes`, { token: f.key, body })).status).toBe(201);
    expect((await api(`${W(f.site.id)}/notes`, { cookie, body })).status).toBe(201);
  });
});

describe("segments", () => {
  it("CRUD with normalised filters", async () => {
    const f = await seedFixture();
    const url = `${W(f.site.id)}/segments`;
    const created = await api(url, {
      token: f.key,
      body: {
        name: "Customers from USA",
        filters: { filter_goal: "payment", filter_country: "United States" },
      },
    });
    expect(created.status).toBe(200);
    expect(created.body.data[0]).toMatchObject({
      name: "Customers from USA",
      filters: { filter_goal: "is:payment", filter_country: "is:US" },
    });
    const id = created.body.data[0].id;
    const list = await api(url, { token: f.key });
    expect(list.body.data).toHaveLength(1);
    const upd = await api(`${url}/${id}`, { token: f.key, method: "PUT", body: { name: "USA" } });
    expect(upd.body.data[0].name).toBe("USA");
    const bad = await api(url, {
      token: f.key,
      body: { name: "x", filters: { filter_nope: "1" } },
    });
    expect(bad.status).toBe(400);
    const notFilter = await api(url, {
      token: f.key,
      body: { name: "x", filters: { country: "US" } },
    });
    expect(notFilter.status).toBe(400);
    const del = await api(`${url}/${id}`, { token: f.key, method: "DELETE" });
    expect(del.body.data).toEqual([{ deleted: true }]);
  });

  it("viewers can read but not write segments", async () => {
    const f = await seedFixture();
    const viewer = await createUser();
    await addMember(f.site.id, viewer.id, "viewer");
    const cookie = await sessionCookie(viewer.id);
    expect((await api(`${W(f.site.id)}/segments`, { cookie })).status).toBe(200);
    const w = await api(`${W(f.site.id)}/segments`, {
      cookie,
      body: { name: "x", filters: { filter_device: "mobile" } },
    });
    expect(w.status).toBe(403);
  });
});

describe("usage", () => {
  it("reports rows, last-24h activity, database size and plan limits", async () => {
    const f = await seedFixture();
    const res = await api(`${W(f.site.id)}/usage`, { token: f.key });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      plan: "unknown",
      databaseLimitBytes: 500 * 1024 * 1024,
      rows: { events: 10, sessions: 4, visitors: 3, payments: 2 },
      last24h: { events: 0, sessions: 0, estimatedRowsWritten: 0 },
      estimatedDailyWriteLimit: 100000,
      retentionDays: null,
      oldestEventAt: "2026-03-10T10:00:00.000Z",
    });
    expect(res.body.data.databaseSizeBytes).toBeGreaterThan(0);
  });
});
