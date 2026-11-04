/**
 * MCP tools over endpoints other teams build (W2 analytics/visitors/goals/funnels/notes,
 * W3 revenue/integrations, W6 alerts/mentions/bot traffic), written against
 * docs/api/contract.md.
 *
 * Until an endpoint is merged it answers 501; each test then checks that the tool reached the
 * contract's route (the 501 names it) and skips its data assertions. After the merge the same
 * tests run in full with no change: they enable themselves.
 */
import { beforeEach, describe, expect, it, type TestContext } from "vitest";
import { resetDb } from "../../helpers/db";
import {
  createApiKey,
  createEvent,
  createPayment,
  createSession,
  createSite,
  createUser,
} from "../../helpers/factories";
import { callTool, pendingOwner, type ToolCallResult } from "./helpers";

beforeEach(() => resetDb());

const HOUR = 3_600_000;

async function world() {
  const owner = await createUser();
  const site = await createSite(owner.id, { domain: "shop.example.com", timezone: "UTC" });
  const token = (await createApiKey({ userId: owner.id, includePii: true })).secret;
  const t0 = Date.now() - 3 * HOUR;
  const a = await createSession({
    siteId: site.id,
    startedAt: t0,
    country: "US",
    device: "desktop",
    browser: "Chrome",
    os: "Mac OS",
    channel: "Organic Search",
    source: "Google",
    referrerDomain: "google.com",
    entryPath: "/pricing",
    pageviews: 2,
  });
  await createEvent({ siteId: site.id, session: a, path: "/pricing" });
  await createEvent({ siteId: site.id, session: a, path: "/signup", ts: t0 + 60_000 });
  await createEvent({
    siteId: site.id,
    session: a,
    type: "custom",
    name: "signup",
    props: { plan: "pro" },
    ts: t0 + 90_000,
  });
  const b = await createSession({
    siteId: site.id,
    startedAt: t0 + HOUR,
    country: "FR",
    device: "mobile",
    browser: "Safari",
    os: "iOS",
    entryPath: "/",
  });
  await createEvent({ siteId: site.id, session: b, path: "/" });
  await createPayment({
    siteId: site.id,
    amountMinor: 4900,
    occurredAt: t0 + 2 * HOUR,
    visitorId: a.visitorId,
    firstSessionId: a.id,
  });
  return { owner, site, token, a, b };
}

/** Call a tool; when its endpoint is still a 501 stub, check the route it reached and skip. */
async function call(
  ctx: TestContext,
  token: string,
  name: string,
  args: Record<string, unknown>,
  route: string,
): Promise<ToolCallResult> {
  const res = await callTool(token, name, args);
  const owner = pendingOwner(res);
  if (owner) {
    expect(res.structuredContent.error.message).toContain(route);
    ctx.skip(`${route} is not merged yet (owner ${owner}); enable after merge`);
  }
  expect(res.isError, JSON.stringify(res.structuredContent)).toBeUndefined();
  return res;
}

describe("analytics tools (W2)", () => {
  it("analytics_overview", async (ctx) => {
    const { site, token } = await world();
    const res = await call(
      ctx,
      token,
      "analytics_overview",
      { websiteId: site.id },
      "GET /api/v1/analytics/overview",
    );
    const row = res.structuredContent.data[0];
    expect(row).toMatchObject({ visitors: 2, sessions: 2 });
    expect(row.pageviews).toBe(3);
    expect(row.revenue).toBe(49);
  });

  it("analytics_overview with filters", async (ctx) => {
    const { site, token } = await world();
    const res = await call(
      ctx,
      token,
      "analytics_overview",
      { websiteId: site.id, filters: { country: "US" } },
      "GET /api/v1/analytics/overview",
    );
    expect(res.structuredContent.data[0].visitors).toBe(1);
  });

  it("analytics_timeseries", async (ctx) => {
    const { site, token } = await world();
    const res = await call(
      ctx,
      token,
      "analytics_timeseries",
      { websiteId: site.id, period: "last7d", interval: "day" },
      "GET /api/v1/analytics/timeseries",
    );
    expect(res.structuredContent.interval).toBe("day");
    expect(Array.isArray(res.structuredContent.data)).toBe(true);
    const total = res.structuredContent.data.reduce(
      (n: number, p: { visitors: number }) => n + p.visitors,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it.for([
    ["analytics_pages", "pages", "path"],
    ["analytics_referrers", "referrers", "referrer"],
    ["analytics_countries", "countries", "country"],
    ["analytics_devices", "devices", "device"],
    ["analytics_browsers", "browsers", "browser"],
    ["analytics_operating_systems", "operating-systems", "operating_system"],
    ["analytics_campaigns", "campaigns", "utm_source"],
    ["analytics_hostnames", "hostnames", "hostname"],
    ["analytics_regions", "regions", "region"],
    ["analytics_cities", "cities", "city"],
    ["analytics_exit_clicks", "exit-clicks", "url"],
    ["analytics_entry_pages", "entry-pages", "path"],
    ["analytics_exit_pages", "exit-pages", "path"],
    ["analytics_channels", "channels", "channel"],
  ] as const)("%s", async ([name, slug, column], ctx) => {
    const { site, token } = await world();
    const res = await call(
      ctx,
      token,
      name,
      { websiteId: site.id, limit: 10 },
      `GET /api/v1/analytics/${slug}`,
    );
    expect(Array.isArray(res.structuredContent.data)).toBe(true);
    for (const row of res.structuredContent.data) expect(row).toHaveProperty(column);
    expect(res.structuredContent.pagination).toMatchObject({ limit: 10, offset: 0 });
  });

  it("analytics_goals_breakdown and analytics_goal_properties", async (ctx) => {
    const { site, token } = await world();
    const goals = await call(
      ctx,
      token,
      "analytics_goals_breakdown",
      { websiteId: site.id },
      "GET /api/v1/analytics/goals",
    );
    expect(goals.structuredContent.data).toContainEqual(
      expect.objectContaining({ goal: "signup", completions: 1, visitors: 1 }),
    );
    const props = await call(
      ctx,
      token,
      "analytics_goal_properties",
      { websiteId: site.id, eventName: "signup", propertyName: "plan" },
      "GET /api/v1/analytics/goals/properties",
    );
    expect(props.structuredContent.meta).toMatchObject({
      eventName: "signup",
      propertyName: "plan",
    });
  });

  it("analytics_realtime and analytics_metadata", async (ctx) => {
    const { site, token } = await world();
    const live = await call(
      ctx,
      token,
      "analytics_realtime",
      { websiteId: site.id },
      "GET /api/v1/analytics/realtime",
    );
    expect(live.structuredContent.data[0]).toHaveProperty("visitors");
    const meta = await call(
      ctx,
      token,
      "analytics_metadata",
      { websiteId: site.id },
      "GET /api/v1/analytics/metadata",
    );
    expect(meta.structuredContent.data[0]).toMatchObject({ domain: "shop.example.com" });
  });

  it("analytics_realtime_map", async (ctx) => {
    const { site, token } = await world();
    const map = await call(
      ctx,
      token,
      "analytics_realtime_map",
      { websiteId: site.id },
      "GET /api/v1/analytics/realtime/map",
    );
    expect(map.structuredContent.data).toHaveProperty("count");
  });
});

describe("visitor tools (W2)", () => {
  it("visitors_search then visitors_get", async (ctx) => {
    const { site, token, a } = await world();
    const found = await call(
      ctx,
      token,
      "visitors_search",
      { websiteId: site.id, completedGoal: "signup" },
      "GET /api/v1/visitors",
    );
    expect(found.structuredContent.data.map((v: { visitorId: string }) => v.visitorId)).toEqual([
      a.visitorId,
    ]);
    const one = await call(
      ctx,
      token,
      "visitors_get",
      { websiteId: site.id, visitorId: a.visitorId },
      `GET /api/v1/visitors/${a.visitorId}`,
    );
    expect(JSON.stringify(one.structuredContent.data)).toContain(a.visitorId);
  });
});

describe("goal, funnel and note tools (W2)", () => {
  it("goals_track records a goal for a visitor", async (ctx) => {
    const { site, token, b } = await world();
    const res = await call(
      ctx,
      token,
      "goals_track",
      { websiteId: site.id, visitorId: b.visitorId, name: "newsletter", confirm: true },
      "POST /api/v1/goals",
    );
    expect(res.structuredContent.data[0]).toHaveProperty("eventId");
    const list = await call(ctx, token, "goals_list", { websiteId: site.id }, "/goals");
    expect(JSON.stringify(list.structuredContent.data)).toContain("newsletter");
  });

  it("goals_delete_events", async (ctx) => {
    const { site, token, a } = await world();
    await call(
      ctx,
      token,
      "goals_delete_events",
      { websiteId: site.id, visitorId: a.visitorId, name: "signup", confirm: true },
      "DELETE /api/v1/goals",
    );
  });

  it("goal customizations", async (ctx) => {
    const { site, token } = await world();
    const route = `/api/v1/admin/websites/${site.id}/goals/customizations`;
    const updated = await call(
      ctx,
      token,
      "goals_customizations_update",
      { websiteId: site.id, goalName: "signup", displayName: "Sign up", confirm: true },
      route,
    );
    expect(updated.structuredContent.data[0]).toMatchObject({
      goalName: "signup",
      displayName: "Sign up",
    });
    const list = await call(ctx, token, "goals_customizations_list", { websiteId: site.id }, route);
    expect(list.structuredContent.colors.length).toBeGreaterThan(0);
    const reset = await call(
      ctx,
      token,
      "goals_customizations_reset",
      { websiteId: site.id, goalName: "signup", confirm: true },
      route,
    );
    expect(reset.structuredContent.data[0]).toMatchObject({ deleted: true, goalName: "signup" });
  });

  it("funnels CRUD and results", async (ctx) => {
    const { site, token } = await world();
    const route = `/api/v1/admin/websites/${site.id}/funnels`;
    const created = await call(
      ctx,
      token,
      "funnels_create",
      {
        websiteId: site.id,
        name: "Signup",
        steps: [
          { name: "Pricing", type: "pageview", url: "/pricing" },
          { name: "Signed up", type: "goal", goalName: "signup" },
        ],
        confirm: true,
      },
      route,
    );
    const funnel = created.structuredContent.data[0];
    expect(funnel.name).toBe("Signup");
    const list = await call(ctx, token, "funnels_list", { websiteId: site.id }, route);
    expect(list.structuredContent.data).toHaveLength(1);
    const id = funnel.id ?? funnel._id;
    const results = await call(
      ctx,
      token,
      "analytics_funnel",
      { websiteId: site.id, funnelId: id },
      `/api/v1/analytics/funnels/${id}`,
    );
    expect(results.structuredContent.data).toHaveLength(1);
    await call(
      ctx,
      token,
      "funnels_update",
      { websiteId: site.id, funnelId: id, name: "Renamed", confirm: true },
      route,
    );
    await call(
      ctx,
      token,
      "funnels_delete",
      { websiteId: site.id, funnelId: id, confirm: true },
      route,
    );
    const after = await call(ctx, token, "funnels_list", { websiteId: site.id }, route);
    expect(after.structuredContent.data).toHaveLength(0);
  });

  it("notes CRUD", async (ctx) => {
    const { site, token } = await world();
    const route = `/api/v1/admin/websites/${site.id}/notes`;
    const created = await call(
      ctx,
      token,
      "notes_create",
      {
        websiteId: site.id,
        text: "Launched pricing page",
        timestamp: new Date().toISOString(),
        confirm: true,
        idempotencyKey: "note-launch-1",
      },
      route,
    );
    const note = created.structuredContent.data[0];
    expect(note.text).toBe("Launched pricing page");
    const list = await call(ctx, token, "notes_list", { websiteId: site.id }, route);
    expect(list.structuredContent.data).toHaveLength(1);
    await call(
      ctx,
      token,
      "notes_update",
      { websiteId: site.id, noteId: note.id, text: "Edited", confirm: true },
      route,
    );
    const deleted = await call(
      ctx,
      token,
      "notes_delete",
      { websiteId: site.id, noteId: note.id, confirm: true },
      route,
    );
    expect(deleted.structuredContent.data[0]).toMatchObject({ deleted: true });
  });
});

describe("revenue tools (W3)", () => {
  it("analytics_revenue", async (ctx) => {
    const { site, token } = await world();
    const res = await call(
      ctx,
      token,
      "analytics_revenue",
      { websiteId: site.id },
      "GET /api/v1/analytics/revenue",
    );
    expect(res.structuredContent.data).toBeTruthy();
  });

  it("integrations_status", async (ctx) => {
    const { site, token } = await world();
    const res = await call(
      ctx,
      token,
      "integrations_status",
      { websiteId: site.id },
      `/api/v1/admin/websites/${site.id}/integrations`,
    );
    expect(res.structuredContent.data[0]).toHaveProperty("stripe");
  });
});

describe("growth tools (W6)", () => {
  it("alerts CRUD and history", async (ctx) => {
    const { site, token } = await world();
    const route = `/api/v1/admin/websites/${site.id}/alerts`;
    const created = await call(
      ctx,
      token,
      "alerts_create",
      {
        websiteId: site.id,
        name: "New signup",
        trigger: { goalName: "signup" },
        template: { message: "Someone signed up just now" },
        // A webhook needs no server-side email provider (email alerts are refused without one).
        destination: { type: "webhook", url: "https://hooks.example.com/datagoat" },
        confirm: true,
      },
      route,
    );
    const alert = created.structuredContent.data[0];
    const list = await call(ctx, token, "alerts_list", { websiteId: site.id }, route);
    expect(list.structuredContent.data).toHaveLength(1);
    await call(
      ctx,
      token,
      "alerts_update",
      { websiteId: site.id, alertId: alert.id, isEnabled: false, confirm: true },
      route,
    );
    const history = await call(
      ctx,
      token,
      "alerts_history",
      { websiteId: site.id },
      `${route}/history`,
    );
    expect(history.structuredContent.counts).toMatchObject({ total: expect.any(Number) });
    await call(
      ctx,
      token,
      "alerts_delete",
      { websiteId: site.id, alertId: alert.id, confirm: true },
      route,
    );
  });

  it("mentions_list", async (ctx) => {
    const { site, token } = await world();
    const res = await call(
      ctx,
      token,
      "mentions_list",
      { websiteId: site.id },
      "GET /api/v1/mentions",
    );
    expect(res.structuredContent.meta).toHaveProperty("totalMentions");
  });

  it("bot traffic summary, pages, settings and token", async (ctx) => {
    const { site, token } = await world();
    await call(
      ctx,
      token,
      "bot_traffic_summary",
      { websiteId: site.id },
      "GET /api/v1/analytics/bot-traffic",
    );
    const pages = await call(
      ctx,
      token,
      "bot_traffic_pages",
      { websiteId: site.id },
      "GET /api/v1/analytics/bot-traffic/pages",
    );
    expect(pages.structuredContent.pagination).toHaveProperty("hasMore");
    const settings = await call(
      ctx,
      token,
      "bot_traffic_settings_get",
      { websiteId: site.id },
      `/api/v1/admin/websites/${site.id}/bot-traffic/settings`,
    );
    expect(settings.structuredContent.data[0]).toMatchObject({ websiteId: site.id });
    const status = await call(
      ctx,
      token,
      "bot_traffic_token_get",
      { websiteId: site.id },
      `/api/v1/admin/websites/${site.id}/bot-traffic/token`,
    );
    expect(status.structuredContent.data).toHaveLength(1);
  });

  it("bot_traffic_usage", async (ctx) => {
    const { token } = await world();
    await call(ctx, token, "bot_traffic_usage", {}, "GET /api/v1/admin/bot-traffic/usage");
  });
});
