import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { addMember, createApiKey, createUser, sessionCookie } from "../../helpers/factories";
import { api } from "../../helpers/http";
import { RANGE, seedFixture } from "../analytics/fixture";

beforeEach(() => resetDb());

const W = (id: string) => `/api/v1/admin/websites/${id}`;

describe("share link admin", () => {
  it("enables, rotates and disables the public link", async () => {
    const f = await seedFixture();
    const off = await api(`${W(f.site.id)}/share`, { token: f.key });
    expect(off.body.data).toEqual({
      enabled: false,
      token: null,
      url: null,
      isPublicDataEnabled: false,
    });
    const on = await api(`${W(f.site.id)}/share`, { token: f.key, body: {} });
    expect(on.body.data.enabled).toBe(true);
    expect(on.body.data.url).toBe(`https://datagoat.test/share/${on.body.data.token}`);
    const rotated = await api(`${W(f.site.id)}/share`, {
      token: f.key,
      body: { isPublicDataEnabled: true },
    });
    expect(rotated.body.data.token).not.toBe(on.body.data.token);
    expect(rotated.body.data.isPublicDataEnabled).toBe(true);
    expect((await api(`/api/share/${on.body.data.token}`)).status).toBe(404);
    expect((await api(`/api/share/${rotated.body.data.token}`)).status).toBe(200);
    const get = await api(`${W(f.site.id)}/share`, { token: f.key });
    expect(get.body.data.token).toBe(rotated.body.data.token);
    const disabled = await api(`${W(f.site.id)}/share`, { token: f.key, method: "DELETE" });
    expect(disabled.body.data.enabled).toBe(false);
    expect((await api(`/api/share/${rotated.body.data.token}`)).status).toBe(404);
  });

  it("needs settings:write to change and viewers cannot", async () => {
    const f = await seedFixture();
    const viewer = await createUser();
    await addMember(f.site.id, viewer.id, "viewer");
    const cookie = await sessionCookie(viewer.id);
    expect((await api(`${W(f.site.id)}/share`, { cookie })).status).toBe(200);
    expect((await api(`${W(f.site.id)}/share`, { cookie, body: {} })).status).toBe(403);
    const token = (
      await createApiKey({
        userId: f.owner.id,
        permissions: ["settings:read"],
        websiteIds: [f.site.id],
      })
    ).secret;
    expect((await api(`${W(f.site.id)}/share`, { token, method: "DELETE" })).status).toBe(403);
  });
});

describe("public share API", () => {
  async function shared(publicData: boolean) {
    const f = await seedFixture();
    const res = await api(`${W(f.site.id)}/share`, {
      token: f.key,
      body: { isPublicDataEnabled: publicData },
    });
    return { f, token: res.body.data.token as string };
  }

  it("describes the shared website", async () => {
    const { f, token } = await shared(false);
    const res = await api(`/api/share/${token}`);
    expect(res.body.data).toEqual({
      domain: "example.com",
      name: f.site.name,
      logo: null,
      timezone: "UTC",
      currency: "USD",
      showRevenue: false,
    });
  });

  it("serves analytics without revenue unless public data is enabled", async () => {
    const { token } = await shared(false);
    const ov = await api(`/api/share/${token}/analytics/overview?${RANGE}`);
    expect(ov.status).toBe(200);
    expect(ov.body.data[0]).toMatchObject({ visitors: 3, sessions: 4, currency: "USD" });
    expect(ov.body.data[0]).not.toHaveProperty("revenue");
    expect(ov.body.data[0]).not.toHaveProperty("conversion_rate");
    const refs = await api(`/api/share/${token}/analytics/referrers?${RANGE}`);
    expect(refs.body.data[0]).toEqual({ referrer: "Direct / None", visitors: 2 });
    const ts = await api(`/api/share/${token}/analytics/timeseries?interval=day&${RANGE}`);
    expect(ts.body.fields).not.toContain("revenue");
    expect(ts.body.totals).not.toHaveProperty("revenueBreakdown");
    const goals = await api(`/api/share/${token}/analytics/goals?${RANGE}`);
    expect(goals.body.data[0]).not.toHaveProperty("revenue");
    const map = await api(`/api/share/${token}/analytics/realtime/map`);
    expect(map.status).toBe(200);
    expect(map.body.data.recentPayments).toEqual([]);
  });

  it("includes revenue when the website shares public data", async () => {
    const { token } = await shared(true);
    const ov = await api(`/api/share/${token}/analytics/overview?${RANGE}`);
    expect(ov.body.data[0]).toMatchObject({ revenue: 59.99, payments: 2 });
    const countries = await api(
      `/api/share/${token}/analytics/countries?${RANGE}&filter_device=desktop`,
    );
    expect(countries.body.data).toEqual([
      {
        country: "United States",
        image: "🇺🇸",
        code: "US",
        visitors: 1,
        revenue: 49.99,
        payments: 1,
      },
    ]);
  });

  it("exposes only the listed endpoints and 404s bad tokens", async () => {
    const { token } = await shared(true);
    for (const ep of ["metadata", "goals/properties?eventName=signup", "funnels/abc", "nope"]) {
      expect((await api(`/api/share/${token}/analytics/${ep}`)).status).toBe(404);
    }
    expect((await api("/api/share/short/analytics/overview")).status).toBe(404);
    expect((await api(`/api/share/${"x".repeat(24)}/analytics/overview`)).status).toBe(404);
    expect(
      (await api("/api/v1/visitors", { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(401);
  });

  it("serves the dashboard shell only for valid tokens", async () => {
    const { token } = await shared(false);
    const bad = await api(`/share/${"y".repeat(24)}`);
    expect(bad.status).toBe(404);
    expect(bad.headers.get("x-robots-tag")).toBe("noindex");
    const good = await api(`/share/${token}`);
    // The response is the static dashboard index (404 here only because tests run unbuilt).
    expect(good.body).not.toBe("Shared dashboard not found");
    expect(good.headers.get("x-robots-tag")).toBe("noindex");
    expect(good.headers.get("cache-control")).toBe("no-store");
  });
});
