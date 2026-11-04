import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { addMember, createApiKey, createUser } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { RANGE, seedFixture } from "../analytics/fixture";

beforeEach(() => resetDb());

const SIGNUP_FUNNEL = {
  name: "Signup funnel",
  steps: [
    { name: "Landing", type: "pageview", url: "/" },
    { name: "Pricing", type: "pageview", url: "/pricing" },
    { name: "Checkout", type: "goal", goalName: "checkout_started" },
  ],
};

async function create(siteId: string, key: string, body: unknown = SIGNUP_FUNNEL) {
  return api(`/api/v1/admin/websites/${siteId}/funnels`, { token: key, body });
}

describe("funnels CRUD", () => {
  it("creates, lists, updates and soft-deletes funnels", async () => {
    const f = await seedFixture();
    const created = await create(f.site.id, f.key);
    expect(created.status).toBe(200);
    const funnel = created.body.data[0];
    expect(funnel).toMatchObject({
      websiteId: f.site.id,
      name: "Signup funnel",
      slug: "signup-funnel",
      isActive: true,
    });
    expect(funnel.id).toMatch(/^[0-9a-f]{24}$/);
    expect(funnel.steps[0]).toMatchObject({
      id: "landing",
      name: "Landing",
      type: "pageview",
      url: "/",
      goalCompletionType: "completed",
    });
    expect(funnel.steps[0]._id).toMatch(/^[0-9a-f]{24}$/);
    expect(funnel.steps[2]).toMatchObject({ type: "goal", goalName: "checkout_started" });

    const list = await api(`/api/v1/admin/websites/${f.site.id}/funnels`, { token: f.key });
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([funnel.id]);

    const dup = await create(f.site.id, f.key);
    expect(dup.status).toBe(409);

    const renamed = await api(`/api/v1/admin/websites/${f.site.id}/funnels/${funnel.id}`, {
      token: f.key,
      method: "PUT",
      body: { name: "Renamed" },
    });
    expect(renamed.body.data[0]).toMatchObject({ name: "Renamed", slug: "renamed" });

    const del = await api(`/api/v1/admin/websites/${f.site.id}/funnels/${funnel.id}`, {
      token: f.key,
      method: "DELETE",
    });
    expect(del.body.data).toEqual([{ message: "Funnel deleted successfully" }]);
    const after = await api(`/api/v1/admin/websites/${f.site.id}/funnels`, { token: f.key });
    expect(after.body.data).toEqual([]);
    const results = await api(`/api/v1/analytics/funnels/${funnel.id}`, { token: f.key });
    expect(results.status).toBe(404);

    // Reactivate; the name is free again so a new funnel can take it.
    const again = await create(f.site.id, f.key, { ...SIGNUP_FUNNEL, name: "Renamed" });
    expect(again.status).toBe(200);
    const clash = await api(`/api/v1/admin/websites/${f.site.id}/funnels/${funnel.id}`, {
      token: f.key,
      method: "PUT",
      body: { isActive: true },
    });
    expect(clash.status).toBe(409);
  });

  it.each([
    [{ name: "x", steps: [{ name: "a", type: "pageview", url: "/" }] }, "2 to 8 steps"],
    [
      {
        name: "x",
        steps: Array.from({ length: 9 }, () => ({ name: "a", type: "pageview", url: "/" })),
      },
      "2 to 8",
    ],
    [
      {
        name: "x",
        steps: [
          { name: "a", type: "pageview" },
          { name: "b", type: "pageview", url: "/" },
        ],
      },
      "url",
    ],
    [
      {
        name: "x",
        steps: [
          { name: "a", type: "goal" },
          { name: "b", type: "pageview", url: "/" },
        ],
      },
      "goalName",
    ],
    [
      {
        name: "x",
        steps: [
          { name: "a", type: "goal", goalName: "Bad Name!" },
          { name: "b", type: "pageview", url: "/" },
        ],
      },
      "goalName",
    ],
    [
      {
        name: "x",
        steps: [
          { name: "a", type: "pageview", url: "/", urlMatchType: "regex" },
          { name: "b", type: "pageview", url: "/" },
        ],
      },
      "urlMatchType",
    ],
  ])("rejects invalid funnels (%#)", async (body, message) => {
    const f = await seedFixture();
    const res = await create(f.site.id, f.key, body);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(message);
  });

  it("allows up to 10 steps on update and validates ids", async () => {
    const f = await seedFixture();
    const id = (await create(f.site.id, f.key)).body.data[0].id;
    const ten = Array.from({ length: 10 }, (_, i) => ({
      name: `Step ${i}`,
      type: "pageview",
      url: "/",
    }));
    const res = await api(`/api/v1/admin/websites/${f.site.id}/funnels/${id}`, {
      token: f.key,
      method: "PUT",
      body: { steps: ten },
    });
    expect(res.status).toBe(200);
    expect(res.body.data[0].steps.map((s: { id: string }) => s.id).slice(0, 2)).toEqual([
      "step-0",
      "step-1",
    ]);
    const bad = await api(`/api/v1/admin/websites/${f.site.id}/funnels/nope`, {
      token: f.key,
      method: "PUT",
      body: { name: "x" },
    });
    expect(bad.status).toBe(400);
    const missing = await api(`/api/v1/admin/websites/${f.site.id}/funnels/${"a".repeat(24)}`, {
      token: f.key,
      method: "DELETE",
    });
    expect(missing.status).toBe(404);
  });

  it("enforces funnels:read / funnels:write and viewer roles", async () => {
    const f = await seedFixture();
    const viewer = await createUser();
    await addMember(f.site.id, viewer.id, "viewer");
    const token = (await createApiKey({ userId: viewer.id, websiteIds: [f.site.id] })).secret;
    expect((await api(`/api/v1/admin/websites/${f.site.id}/funnels`, { token })).status).toBe(200);
    const write = await create(f.site.id, token);
    expect(write.status).toBe(403);
    expect(write.body.error.message).toContain("viewer");
    const readOnly = (
      await createApiKey({
        userId: f.owner.id,
        permissions: ["funnels:read"],
        websiteIds: [f.site.id],
      })
    ).secret;
    expect((await create(f.site.id, readOnly)).status).toBe(403);
  });
});

describe("GET /api/v1/analytics/funnels/:funnelId", () => {
  it("counts ordered first occurrences per step with revenue and drop-off", async () => {
    const f = await seedFixture();
    const id = (await create(f.site.id, f.key)).body.data[0].id;
    const res = await api(`/api/v1/analytics/funnels/${id}?${RANGE}`, { token: f.key });
    expect(res.status).toBe(200);
    const result = res.body.data[0];
    expect(result.funnel).toMatchObject({ id, name: "Signup funnel", slug: "signup-funnel" });
    expect(result.data).toEqual([
      {
        id: "landing",
        label: "Landing",
        value: 2,
        stepIndex: 0,
        stepType: "pageview",
        revenue: 59.99,
        conversionRate: 100,
        dropoffFromPrevious: 0,
      },
      {
        id: "pricing",
        label: "Pricing",
        value: 2,
        stepIndex: 1,
        stepType: "pageview",
        revenue: 59.99,
        conversionRate: 100,
        dropoffFromPrevious: 0,
      },
      {
        id: "checkout",
        label: "Checkout",
        value: 1,
        stepIndex: 2,
        stepType: "goal",
        revenue: 10,
        conversionRate: 50,
        dropoffFromPrevious: 50,
      },
    ]);
    expect(result.metrics).toMatchObject({
      totalVisitors: 2,
      completions: 1,
      overallConversionRate: 50,
      overallRevenuePerVisitor: 30,
      timezone: "UTC",
      startAt: "2026-03-10T00:00:00.000Z",
      endAt: "2026-03-11T23:59:59.999Z",
    });
    const all = await api(`/api/v1/analytics/funnels/${id}`, { token: f.key });
    expect(all.body.data[0].metrics.startAt).toBeNull();
    const filtered = await api(`/api/v1/analytics/funnels/${id}?${RANGE}&filter_country=DE`, {
      token: f.key,
    });
    expect(filtered.body.data[0].data.map((d: { value: number }) => d.value)).toEqual([1, 1, 1]);
  });

  it("supports URL match types, hostnames and not_completed goal steps", async () => {
    const f = await seedFixture();
    const steps = async (s: unknown[]) => {
      const id = (await create(f.site.id, f.key, { name: `f${Math.random()}`, steps: s })).body
        .data[0].id;
      const res = await api(`/api/v1/analytics/funnels/${id}?${RANGE}`, { token: f.key });
      return res.body.data[0].data.map((d: { value: number }) => d.value);
    };
    expect(
      await steps([
        { name: "Home", type: "pageview", url: "/" },
        {
          name: "No signup",
          type: "goal",
          goalName: "signup",
          goalCompletionType: "not_completed",
        },
      ]),
    ).toEqual([2, 1]);
    expect(
      await steps([
        { name: "Pricing", type: "pageview", url: "/pri*", urlMatchType: "wildcard" },
        { name: "Signup", type: "pageview", url: "signup", urlMatchType: "contains" },
      ]),
    ).toEqual([3, 1]);
    expect(
      await steps([
        { name: "Blog", type: "pageview", url: "/blog", urlMatchType: "starts_with" },
        { name: "Any but home", type: "pageview", url: "/", urlMatchType: "not_equals" },
      ]),
    ).toEqual([1, 1]);
    expect(
      await steps([
        { name: "Full URL", type: "pageview", url: "https://example.com/pricing/" },
        { name: "Other host", type: "pageview", url: "/pricing", hostname: "app.example.com" },
      ]),
    ).toEqual([3, 0]);
    expect(
      await steps([
        { name: "Ends", type: "pageview", url: "ing", urlMatchType: "ends_with" },
        { name: "Not blog", type: "pageview", url: "blog", urlMatchType: "not_contains" },
      ]),
    ).toEqual([3, 3]);
  });

  it("rejects bad ids and unknown funnels", async () => {
    const f = await seedFixture();
    expect((await api("/api/v1/analytics/funnels/xyz", { token: f.key })).status).toBe(400);
    expect(
      (await api(`/api/v1/analytics/funnels/${"b".repeat(24)}`, { token: f.key })).status,
    ).toBe(404);
  });
});
