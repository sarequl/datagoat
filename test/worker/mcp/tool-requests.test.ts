/**
 * Every tool maps its arguments to the `/api/v1` request the API contract documents
 * (docs/api/contract.md): method, path, query and body. Pure: no handler runs.
 */
import { describe, expect, it } from "vitest";
import type { AuthContext } from "../../../src/auth/context";
import type { McpCaller } from "../../../src/mcp/auth";
import { findTool, TOOLS } from "../../../src/mcp/tools";
import type { ToolContext } from "../../../src/mcp/tools/kit";

const SITE = "6728f0a0a1b2c3d4e5f6a001";
const NOW = Date.parse("2026-11-04T15:00:00Z");

function context(auth: Partial<AuthContext> = {}): ToolContext {
  const caller: McpCaller = {
    auth: {
      kind: "account_token",
      user: { id: "u1", email: "a@b.c", name: null, image: null, createdAt: 0 },
      credentialId: "k1",
      scopes: ["*"],
      websiteIds: "all",
      includePii: false,
      ...auth,
    },
    connection: null,
    oauthScopes: [],
  };
  const tc: ToolContext = {
    caller,
    now: NOW,
    origin: "https://dg.test",
    env: {} as Cloudflare.Env,
    call: () => Promise.reject(new Error("not used")),
    siteRef: (args) => args.websiteId ?? caller.auth.keySiteId,
    requireSite: (args) => {
      const ref = tc.siteRef(args);
      if (!ref) throw new Error("websiteId is required");
      return ref;
    },
    siteTimezone: async () => "America/New_York",
  };
  return tc;
}

async function req(name: string, args: Record<string, unknown>, tc = context()) {
  const tool = findTool(name);
  if (!tool?.request) throw new Error(`no request builder for ${name}`);
  const parsed = tool.input.parse(args);
  const r = await tool.request(parsed, tc);
  const query = Object.fromEntries(
    Object.entries(r.query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );
  return { method: r.method, path: r.path, query, body: r.body };
}

const A = "/api/v1/analytics";
const W = `/api/v1/admin/websites/${SITE}`;

describe("analytics tool requests", () => {
  it("overview passes the range, filters and fields", async () => {
    expect(
      await req("analytics_overview", {
        websiteId: SITE,
        startAt: "2026-10-01",
        endAt: "2026-10-31",
        timezone: "Europe/Paris",
        fields: "visitors,revenue",
        filters: { country: "US", filter_page: "contains:/docs", browser: ["Chrome", "Safari"] },
      }),
    ).toEqual({
      method: "GET",
      path: `${A}/overview`,
      query: {
        websiteId: SITE,
        startAt: "2026-10-01",
        endAt: "2026-10-31",
        timezone: "Europe/Paris",
        fields: "visitors,revenue",
        filter_country: "US",
        filter_page: "contains:/docs",
        filter_browser: "Chrome,Safari",
      },
      body: undefined,
    });
  });

  it("resolves period presets in the website timezone", async () => {
    const r = await req("analytics_overview", { websiteId: SITE, period: "last7d" });
    // 2026-11-04 15:00 UTC is 10:00 in New York.
    expect(r.query).toEqual({ websiteId: SITE, startAt: "2026-10-29", endAt: "2026-11-04" });
    const day = await req("analytics_pages", { websiteId: SITE, period: "yesterday", limit: 5 });
    expect(day.query).toMatchObject({ startAt: "2026-11-03", endAt: "2026-11-03", limit: 5 });
  });

  it("rejects mixing period with dates and lone bounds", async () => {
    await expect(
      req("analytics_overview", { period: "today", startAt: "2026-01-01", endAt: "2026-01-02" }),
    ).rejects.toThrow("either period");
    await expect(req("analytics_overview", { startAt: "2026-01-01" })).rejects.toThrow("together");
    await expect(req("analytics_overview", { filters: { "bad key": "x" } })).rejects.toThrow(
      "Invalid filter key",
    );
  });

  it("timeseries defaults interval and fields", async () => {
    expect((await req("analytics_timeseries", { websiteId: SITE })).query).toEqual({
      websiteId: SITE,
      interval: "day",
      fields: "name,visitors,sessions,pageviews,revenue,payments,conversion_rate",
    });
    expect(
      (await req("analytics_timeseries", { websiteId: SITE, interval: "hour", fields: "visitors" }))
        .query,
    ).toMatchObject({ interval: "hour", fields: "visitors" });
  });

  it.each([
    ["analytics_realtime", `${A}/realtime`],
    ["analytics_realtime_map", `${A}/realtime/map`],
    ["analytics_metadata", `${A}/metadata`],
    ["analytics_pages", `${A}/pages`],
    ["analytics_entry_pages", `${A}/entry-pages`],
    ["analytics_exit_pages", `${A}/exit-pages`],
    ["analytics_exit_clicks", `${A}/exit-clicks`],
    ["analytics_referrers", `${A}/referrers`],
    ["analytics_channels", `${A}/channels`],
    ["analytics_campaigns", `${A}/campaigns`],
    ["analytics_countries", `${A}/countries`],
    ["analytics_regions", `${A}/regions`],
    ["analytics_cities", `${A}/cities`],
    ["analytics_devices", `${A}/devices`],
    ["analytics_browsers", `${A}/browsers`],
    ["analytics_operating_systems", `${A}/operating-systems`],
    ["analytics_hostnames", `${A}/hostnames`],
    ["analytics_goals_breakdown", `${A}/goals`],
    ["analytics_revenue", `${A}/revenue`],
    ["bot_traffic_summary", `${A}/bot-traffic`],
    ["bot_traffic_pages", `${A}/bot-traffic/pages`],
    ["mentions_list", "/api/v1/mentions"],
  ])("%s → GET %s", async (name, path) => {
    const r = await req(name, { websiteId: SITE });
    expect(r).toMatchObject({ method: "GET", path, query: { websiteId: SITE } });
  });

  it("goal properties, funnels and tool-specific parameters", async () => {
    expect(
      (
        await req("analytics_goal_properties", {
          websiteId: SITE,
          eventName: "signup",
          propertyName: "plan",
        })
      ).query,
    ).toMatchObject({ eventName: "signup", propertyName: "plan" });
    expect((await req("analytics_funnel", { websiteId: SITE, funnelId: "f/1" })).path).toBe(
      `${A}/funnels/f%2F1`,
    );
    expect(
      (await req("mentions_list", { websiteId: SITE, q: "goat", platform: "reddit", order: "asc" }))
        .query,
    ).toMatchObject({ q: "goat", platform: "reddit", order: "asc" });
    expect(
      (await req("bot_traffic_pages", { websiteId: SITE, pageSearch: "/docs", limit: 10 })).query,
    ).toMatchObject({ pageSearch: "/docs", limit: 10 });
  });

  it("a df_ key's website is used when websiteId is omitted", async () => {
    const tc = context({ kind: "site_key", keySiteId: SITE, websiteIds: [SITE] });
    expect((await req("analytics_overview", {}, tc)).query).toEqual({ websiteId: SITE });
    expect((await req("funnels_list", {}, tc)).path).toBe(`${W}/funnels`);
  });
});

describe("visitor tool requests", () => {
  it("visitors_search passes the documented parameters", async () => {
    const r = await req("visitors_search", {
      websiteId: SITE,
      period: "today",
      visitedPage: "/pricing",
      completedGoal: "signup",
      country: "France",
      isCustomer: true,
      limit: 25,
    });
    expect(r).toEqual({
      method: "GET",
      path: "/api/v1/visitors",
      query: {
        websiteId: SITE,
        startAt: "2026-11-04",
        endAt: "2026-11-04",
        visitedPage: "/pricing",
        completedGoal: "signup",
        country: "France",
        isCustomer: true,
        limit: 25,
      },
      body: undefined,
    });
  });

  it("visitors_get", async () => {
    const id = "0b9c8a4e-1d2f-4a3b-9c8d-7e6f5a4b3c2d";
    expect(await req("visitors_get", { websiteId: SITE, visitorId: id })).toMatchObject({
      method: "GET",
      path: `/api/v1/visitors/${id}`,
    });
  });
});

describe("resource tool requests", () => {
  it.each([
    ["websites_list", {}, "GET", "/api/v1/admin/websites", undefined],
    ["websites_get", { websiteId: SITE }, "GET", W, undefined],
    [
      "websites_create",
      { domain: "x.com", timezone: "UTC", name: "X" },
      "POST",
      "/api/v1/admin/websites",
      { domain: "x.com", timezone: "UTC", name: "X" },
    ],
    ["websites_update", { websiteId: SITE, changes: { name: "N" } }, "PUT", W, { name: "N" }],
    ["apikeys_list", { websiteId: SITE }, "GET", `${W}/apikeys`, undefined],
    ["apikeys_create", { websiteId: SITE, name: "K" }, "POST", `${W}/apikeys`, { name: "K" }],
    ["apikeys_roll", { websiteId: SITE, apiKeyId: "k1" }, "PUT", `${W}/apikeys/k1`, undefined],
    ["apikeys_delete", { websiteId: SITE, apiKeyId: "k1" }, "DELETE", `${W}/apikeys/k1`, undefined],
    ["team_list", { websiteId: SITE }, "GET", `${W}/team`, undefined],
    [
      "team_invite",
      { websiteId: SITE, email: "a@b.co", role: "viewer" },
      "POST",
      `${W}/team`,
      { email: "a@b.co", role: "viewer" },
    ],
    ["team_remove", { websiteId: SITE, userId: "u2" }, "DELETE", `${W}/team`, { userId: "u2" }],
    [
      "team_update_role",
      { websiteId: SITE, userId: "u2", role: "member" },
      "PUT",
      `${W}/team`,
      { userId: "u2", role: "member" },
    ],
    [
      "goals_track",
      { websiteId: SITE, visitorId: "v1", name: "signup", metadata: { plan: "pro" } },
      "POST",
      "/api/v1/goals",
      { datafast_visitor_id: "v1", name: "signup", metadata: { plan: "pro" } },
    ],
    ["goals_list", { websiteId: SITE }, "GET", `${W}/goals`, undefined],
    [
      "goals_customizations_list",
      { websiteId: SITE },
      "GET",
      `${W}/goals/customizations`,
      undefined,
    ],
    [
      "goals_customizations_update",
      { websiteId: SITE, goalName: "signup", displayName: "Sign up", color: "#8dcdff" },
      "PATCH",
      `${W}/goals/customizations`,
      { goalName: "signup", displayName: "Sign up", color: "#8dcdff" },
    ],
    [
      "goals_customizations_reset",
      { websiteId: SITE, goalName: "signup" },
      "DELETE",
      `${W}/goals/customizations`,
      undefined,
    ],
    ["funnels_list", { websiteId: SITE }, "GET", `${W}/funnels`, undefined],
    [
      "funnels_create",
      {
        websiteId: SITE,
        name: "Checkout",
        steps: [
          { name: "Pricing", type: "pageview", url: "/pricing" },
          { name: "Buy", type: "goal", goalName: "purchase" },
        ],
      },
      "POST",
      `${W}/funnels`,
      {
        name: "Checkout",
        steps: [
          { name: "Pricing", type: "pageview", url: "/pricing" },
          { name: "Buy", type: "goal", goalName: "purchase" },
        ],
      },
    ],
    [
      "funnels_update",
      { websiteId: SITE, funnelId: "f1", isActive: false },
      "PUT",
      `${W}/funnels/f1`,
      { isActive: false },
    ],
    ["funnels_delete", { websiteId: SITE, funnelId: "f1" }, "DELETE", `${W}/funnels/f1`, undefined],
    [
      "notes_create",
      {
        websiteId: SITE,
        text: "Launch",
        timestamp: "2026-11-04T10:00:00Z",
        idempotencyKey: "note-0001",
      },
      "POST",
      `${W}/notes`,
      { text: "Launch", timestamp: "2026-11-04T10:00:00Z", idempotencyKey: "note-0001" },
    ],
    [
      "notes_update",
      { websiteId: SITE, noteId: "n1", text: "T" },
      "PUT",
      `${W}/notes/n1`,
      { text: "T" },
    ],
    ["notes_delete", { websiteId: SITE, noteId: "n1" }, "DELETE", `${W}/notes/n1`, undefined],
    ["alerts_list", { websiteId: SITE }, "GET", `${W}/alerts`, undefined],
    [
      "alerts_create",
      {
        websiteId: SITE,
        name: "Sale",
        trigger: { goalName: "purchase" },
        template: { message: "Someone just bought" },
      },
      "POST",
      `${W}/alerts`,
      {
        name: "Sale",
        trigger: { goalName: "purchase" },
        template: { message: "Someone just bought" },
      },
    ],
    [
      "alerts_update",
      { websiteId: SITE, alertId: "a1", isEnabled: false },
      "PUT",
      `${W}/alerts/a1`,
      { isEnabled: false },
    ],
    ["alerts_delete", { websiteId: SITE, alertId: "a1" }, "DELETE", `${W}/alerts/a1`, undefined],
    ["alerts_history", { websiteId: SITE }, "GET", `${W}/alerts/history`, undefined],
    ["integrations_status", { websiteId: SITE }, "GET", `${W}/integrations`, undefined],
    [
      "bot_traffic_settings_get",
      { websiteId: SITE },
      "GET",
      `${W}/bot-traffic/settings`,
      undefined,
    ],
    [
      "bot_traffic_settings_update",
      { websiteId: SITE, settings: { verifiedOnly: true } },
      "PATCH",
      `${W}/bot-traffic/settings`,
      { verifiedOnly: true },
    ],
    ["bot_traffic_token_get", { websiteId: SITE }, "GET", `${W}/bot-traffic/token`, undefined],
    ["bot_traffic_token_create", { websiteId: SITE }, "POST", `${W}/bot-traffic/token`, undefined],
    ["bot_traffic_token_rotate", { websiteId: SITE }, "PUT", `${W}/bot-traffic/token`, undefined],
    [
      "bot_traffic_token_delete",
      { websiteId: SITE },
      "DELETE",
      `${W}/bot-traffic/token`,
      undefined,
    ],
    ["bot_traffic_usage", {}, "GET", "/api/v1/admin/bot-traffic/usage", undefined],
    ["account_update", { name: "Me" }, "PUT", "/api/v1/admin/account", { name: "Me" }],
    ["access_tokens_list", {}, "GET", "/api/v1/admin/access-tokens", undefined],
    [
      "access_tokens_create",
      { name: "T", permissions: ["analytics:read"] },
      "POST",
      "/api/v1/admin/access-tokens",
      { name: "T", permissions: ["analytics:read"] },
    ],
    [
      "access_tokens_delete",
      { tokenId: "t1" },
      "DELETE",
      "/api/v1/admin/access-tokens/t1",
      undefined,
    ],
  ] as const)("%s", async (name, args, method, path, body) => {
    const r = await req(name, args as Record<string, unknown>);
    expect(r.method).toBe(method);
    expect(r.path).toBe(path);
    expect(r.body).toEqual(body);
  });

  it("query-parameter writes", async () => {
    expect(
      (await req("goals_delete_events", { websiteId: SITE, visitorId: "v1", name: "signup" }))
        .query,
    ).toEqual({ websiteId: SITE, datafast_visitor_id: "v1", name: "signup" });
    expect(
      (await req("goals_customizations_reset", { websiteId: SITE, goalName: "signup" })).query,
    ).toEqual({ goalName: "signup" });
    expect(
      (await req("notes_list", { websiteId: SITE, period: "last30d", q: "launch" })).query,
    ).toEqual({ startAt: "2026-10-06", endAt: "2026-11-04", q: "launch" });
    expect(
      (await req("alerts_history", { websiteId: SITE, alertId: "a1", limit: 5 })).query,
    ).toEqual({
      alertId: "a1",
      limit: 5,
    });
  });

  it("every tool except whoami is one REST request", () => {
    for (const tool of TOOLS) {
      if (tool.name === "whoami") expect(tool.run).toBeDefined();
      else expect(tool.request, tool.name).toBeDefined();
    }
  });
});
