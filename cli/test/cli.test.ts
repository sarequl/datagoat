import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockServer, NOW, type Sandbox, sandbox } from "./harness";

const SITE = "6728f0a0a1b2c3d4e5f6a001";
const TOKEN = "dft_TestToken0123456789";
const KEY = "df_SiteKey0123456789";

const websites = [
  {
    _id: SITE,
    domain: "example.com",
    name: "Example",
    logo: null,
    trackingId: "dfid_example",
    timezone: "America/New_York",
    currency: "USD",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

let server: MockServer;
let sb: Sandbox;

beforeEach(async () => {
  server = new MockServer();
  await server.start();
  server
    .data("GET", "/api/auth/me", {
      user: { id: "u1", email: "me@example.com", name: "Me", image: null, createdAt: "x" },
      websites,
      authKind: "account_token",
    })
    .data("GET", "/api/v1/admin/websites", websites)
    .data("GET", "/api/v1/admin/account", [{ _id: "u1", email: "me@example.com", name: "Me" }]);
  sb = await sandbox();
});

afterEach(async () => {
  await server.stop();
  await sb.cleanup();
});

/** Run with the mock server's URL and an account token. */
const run = (argv: string[], options: Parameters<Sandbox["run"]>[1] = {}) =>
  sb.run(argv, {
    ...options,
    env: { DATAGOAT_URL: server.url, DATAGOAT_TOKEN: TOKEN, ...(options.env ?? {}) },
  });

describe("login, logout and configuration", () => {
  it("logs in with --token, verifies it and saves a 0600 config", async () => {
    const res = await sb.run(["login", "--url", server.url, "--token", TOKEN]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain("as me@example.com (account token)");
    expect(server.last("GET", "/api/auth/me").headers.authorization).toBe(`Bearer ${TOKEN}`);
    const path = join(sb.home, ".config", "datagoat", "config.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ url: server.url, token: TOKEN });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    // Saved settings are used by later commands.
    const list = await sb.run(["--json", "sites", "list"]);
    expect(list.json()).toEqual(websites);
  });

  it("reads the token from stdin (CI)", async () => {
    const res = await sb.run(["login", "--url", server.url], { stdin: `${KEY}\n` });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain("(website key)");
  });

  it("prompts in a terminal and opens the token page", async () => {
    const res = await sb.run(["login"], { answers: [server.url, TOKEN] });
    expect(res.code, res.stderr).toBe(0);
    expect(sb.opened).toEqual([`${server.url}/app/account`]);
    expect(res.stderr).toContain("Paste your token");
  });

  it("rejects malformed and invalid tokens", async () => {
    const bad = await sb.run(["login", "--url", server.url, "--token", "sk_live_x"]);
    expect(bad.code).toBe(2);
    server.on("GET", "/api/auth/me", {
      status: 401,
      body: {
        status: "error",
        error: { code: 401, message: "Invalid, expired or revoked API key" },
      },
    });
    const denied = await sb.run(["login", "--url", server.url, "--token", TOKEN]);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toBe("Error (401): Invalid, expired or revoked API key\n");
  });

  it("logout removes the token but keeps the URL", async () => {
    await sb.run(["login", "--url", server.url, "--token", TOKEN]);
    const res = await sb.run(["logout"]);
    expect(res.code).toBe(0);
    const path = join(sb.home, ".config", "datagoat", "config.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ url: server.url });
    const after = await sb.run(["sites", "list"]);
    expect(after.code).toBe(2);
    expect(after.stderr).toContain("Not logged in");
  });

  it("flags beat environment variables, which beat the config file", async () => {
    await sb.run(["login", "--url", server.url, "--token", TOKEN]);
    await sb.run(["--token", "dft_FromFlag000", "sites", "list"]);
    expect(server.last().headers.authorization).toBe("Bearer dft_FromFlag000");
    await sb.run(["sites", "list"], { env: { DATAGOAT_TOKEN: "dft_FromEnv0000" } });
    expect(server.last().headers.authorization).toBe("Bearer dft_FromEnv0000");
    await sb.run(["sites", "list"], { env: { DATAGOAT_SITE_KEY: KEY } });
    expect(server.last().headers.authorization).toBe(`Bearer ${KEY}`);
    const show = await sb.run(["--json", "config", "show"], { env: { DATAGOAT_SITE: "abc" } });
    expect(show.json()).toMatchObject({
      url: server.url,
      urlFrom: "config",
      token: "dft_Tes...6789",
      tokenFrom: "config",
      site: "abc",
      siteFrom: "DATAGOAT_SITE",
    });
  });

  it("set-site / clear-site / path", async () => {
    await run(["config", "set-site", SITE]);
    server.data("GET", `/api/v1/admin/websites/${SITE}/funnels`, []);
    expect((await run(["funnels", "list"])).code).toBe(0);
    await run(["config", "clear-site"]);
    const missing = await run(["funnels", "list"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Which website?");
    const path = await run(["config", "path"]);
    expect(path.stdout.trim()).toBe(join(sb.home, ".config", "datagoat", "config.json"));
  });

  it("whoami shows the account and credential", async () => {
    const res = await run(["whoami", "--json"]);
    expect(res.json()).toMatchObject({ email: "me@example.com", credential: "account_token" });
  });
});

describe("analytics", () => {
  it("resolves --period in the website timezone and passes filters", async () => {
    server.data("GET", "/api/v1/analytics/overview", [{ visitors: 3, revenue: 49 }]);
    const res = await run([
      "analytics",
      "overview",
      "--site",
      SITE,
      "--period",
      "last7d",
      "-F",
      "country=United States,Canada",
      "--device",
      "mobile",
      "--filter",
      "page:contains=/docs",
      "-F",
      "utm_source=is_not:google",
      "--json",
    ]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.json()).toEqual([{ visitors: 3, revenue: 49 }]);
    // 2026-11-04 15:00 UTC is 10:00 in New York.
    expect(server.last("GET", "/api/v1/analytics/overview").query).toEqual({
      websiteId: SITE,
      startAt: "2026-10-29",
      endAt: "2026-11-04",
      filter_country: "United States,Canada",
      filter_device: "mobile",
      filter_page: "contains:/docs",
      filter_utm_source: "is_not:google",
    });
    void NOW;
  });

  it("merges repeated filters and rejects mixed operators", async () => {
    server.data("GET", "/api/v1/analytics/pages", []);
    await run(["analytics", "pages", "--site", SITE, "--country", "US", "--country", "FR"]);
    expect(server.last("GET", "/api/v1/analytics/pages").query).toMatchObject({
      filter_country: "US,FR",
      limit: "50",
    });
    const mixed = await run([
      "analytics",
      "pages",
      "--site",
      SITE,
      "-F",
      "page=/a",
      "-F",
      "page:contains=/b",
    ]);
    expect(mixed.code).toBe(2);
    expect(mixed.stderr).toContain("Do not mix operators");
    const unknown = await run(["analytics", "pages", "--site", SITE, "-F", "planet=mars"]);
    expect(unknown.stderr).toContain('Unknown filter key "planet"');
  });

  it("validates date flags", async () => {
    const ambiguous = await run([
      "analytics",
      "overview",
      "--site",
      SITE,
      "--from",
      "2026-01-01T00:00:00",
      "--to",
      "2026-01-02",
    ]);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.stderr).toContain("ambiguous");
    const both = await run([
      "analytics",
      "overview",
      "--site",
      SITE,
      "--period",
      "today",
      "--from",
      "2026-01-01",
      "--to",
      "2026-01-02",
    ]);
    expect(both.stderr).toContain("not both");
    server.data("GET", "/api/v1/analytics/overview", [{}]);
    await run([
      "analytics",
      "overview",
      "--site",
      SITE,
      "--from",
      "2026-01-01",
      "--to",
      "2026-01-31",
      "--timezone",
      "UTC",
    ]);
    expect(server.last("GET", "/api/v1/analytics/overview").query).toMatchObject({
      startAt: "2026-01-01",
      endAt: "2026-01-31",
      timezone: "UTC",
    });
  });

  it("timeseries defaults and table output with totals", async () => {
    server.data(
      "GET",
      "/api/v1/analytics/timeseries",
      [
        {
          name: "2026-11-03",
          visitors: 10,
          sessions: 12,
          pageviews: 30,
          revenue: 9.5,
          payments: 1,
          conversion_rate: 10,
        },
      ],
      { totals: { visitors: 10 } },
    );
    const res = await run(["analytics", "timeseries", "--site", SITE]);
    expect(server.last().query).toMatchObject({
      interval: "day",
      fields: "name,visitors,sessions,pageviews,revenue,payments,conversion_rate",
    });
    expect(res.stdout).toMatch(/period\s+visitors/);
    expect(res.stdout).toContain("2026-11-03");
    expect(res.stdout).toContain("9.50");
    expect(res.stdout).toContain('Totals: {"visitors":10}');
  });

  it("with a df_ key the API infers the website", async () => {
    server.data("GET", "/api/v1/analytics/realtime", [{ visitors: 2 }]);
    const res = await sb.run(["analytics", "realtime", "--json"], {
      env: { DATAGOAT_URL: server.url, DATAGOAT_TOKEN: KEY },
    });
    expect(res.json()).toEqual([{ visitors: 2 }]);
    expect(server.last().query).toEqual({});
  });

  it("aliases: stats, breakdown, live", async () => {
    server.data("GET", "/api/v1/analytics/overview", [{ visitors: 1 }]);
    server.data("GET", "/api/v1/analytics/operating-systems", []);
    server.data("GET", "/api/v1/analytics/realtime", [{ visitors: 0 }]);
    expect((await run(["stats", "--site", SITE])).code).toBe(0);
    expect((await run(["breakdown", "os", "--site", SITE])).code).toBe(0);
    expect(server.last().path).toBe("/api/v1/analytics/operating-systems");
    expect((await run(["live", "--site", SITE])).code).toBe(0);
    expect((await run(["breakdown", "planets", "--site", SITE])).code).toBe(2);
  });

  it("goal-properties requires --event", async () => {
    server.data("GET", "/api/v1/analytics/goals/properties", []);
    expect((await run(["analytics", "goal-properties", "--site", SITE])).code).toBe(2);
    await run([
      "analytics",
      "goal-properties",
      "--site",
      SITE,
      "--event",
      "signup",
      "--property",
      "plan",
    ]);
    expect(server.last().query).toMatchObject({ eventName: "signup", propertyName: "plan" });
  });

  it("prompts for the website when interactive", async () => {
    server.data("GET", "/api/v1/admin/websites", [
      ...websites,
      { ...websites[0], _id: "other", name: "Other" },
    ]);
    server.data("GET", "/api/v1/analytics/overview", [{ visitors: 1 }]);
    const res = await run(["analytics", "overview"], { answers: ["2"] });
    expect(res.code, res.stderr).toBe(0);
    expect(server.last("GET", "/api/v1/analytics/overview").query.websiteId).toBe("other");
  });
});

describe("visitors", () => {
  it("maps search flags to the visitors API", async () => {
    server.data("GET", "/api/v1/visitors", [{ visitorId: "v1", identity: { country: "France" } }], {
      pagination: { limit: 25, offset: 0, total: 1 },
    });
    const res = await run([
      "visitors",
      "list",
      "--site",
      SITE,
      "--visited-page-contains",
      "/docs",
      "--completed-goal",
      "signup",
      "--country",
      "France",
      "--utm-campaign",
      "launch",
      "--is-customer",
      "--period",
      "today",
      "--limit",
      "25",
    ]);
    expect(res.code, res.stderr).toBe(0);
    expect(server.last("GET", "/api/v1/visitors").query).toEqual({
      websiteId: SITE,
      startAt: "2026-11-04",
      endAt: "2026-11-04",
      visitedPageContains: "/docs",
      completedGoal: "signup",
      country: "France",
      utm_campaign: "launch",
      isCustomer: "true",
      limit: "25",
    });
    expect(res.stdout).toContain("France");
    expect(res.stderr).toContain("1 visitors match.");
    server.data("GET", "/api/v1/visitors/v1", { visitorId: "v1" });
    const one = await run(["visitor", "v1", "--site", SITE, "--json"]);
    expect(one.json()).toEqual({ visitorId: "v1" });
  });
});

describe("websites, keys, tokens, team", () => {
  it("lists websites as a table", async () => {
    const res = await run(["websites", "list"]);
    expect(res.stdout).toMatch(/id\s+domain\s+name/);
    expect(res.stdout).toContain("example.com");
  });

  it("creates and updates websites", async () => {
    server.data("POST", "/api/v1/admin/websites", [
      { websiteId: "new", domain: "new.com", trackingId: "dfid_new" },
    ]);
    const created = await run(["sites", "create", "--domain", "new.com", "--timezone", "UTC"]);
    expect(server.last().body).toEqual({ domain: "new.com", timezone: "UTC" });
    expect(created.stdout).toContain('data-website-id="dfid_new"');
    server.on("PUT", `/api/v1/admin/websites/${SITE}`, (req) => ({
      body: { status: "success", data: [req.body] },
    }));
    await run([
      "sites",
      "update",
      SITE,
      "--name",
      "Renamed",
      "--cookieless",
      "true",
      "--excluded-ips",
      "1.2.3.4, 5.6.7.8",
      "--set",
      "retentionDays=90",
    ]);
    expect(server.last().body).toEqual({
      name: "Renamed",
      isCookieless: true,
      excludedIps: ["1.2.3.4", "5.6.7.8"],
      retentionDays: 90,
    });
    expect((await run(["sites", "update", SITE])).code).toBe(2);
    await run([
      "sites",
      "kpi",
      SITE,
      "--type",
      "goal",
      "--goal",
      "signup",
      "--color-scheme",
      "blue",
    ]);
    expect(server.last().body).toEqual({ kpi: "signup", kpiColorScheme: "blue" });
  });

  it("shows the server's error for website deletion", async () => {
    server.on("DELETE", `/api/v1/admin/websites/${SITE}`, {
      status: 403,
      body: {
        status: "error",
        error: { code: 403, message: "Website deletion cannot be done programmatically." },
      },
    });
    const res = await run(["sites", "delete", SITE, "--yes"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("cannot be done programmatically");
  });

  it("creates, rolls and deletes website keys", async () => {
    server.data("POST", `/api/v1/admin/websites/${SITE}/apikeys`, [{ id: "k1", key: "df_NEW" }]);
    const created = await run(["keys", "create", "--site", SITE, "--name", "CI", "--pii"]);
    expect(created.stdout).toBe("df_NEW\n");
    expect(server.last().body).toEqual({ name: "CI", includePii: true });
    server.data("PUT", `/api/v1/admin/websites/${SITE}/apikeys/k1`, [
      { id: "k1", key: "df_ROLLED" },
    ]);
    const noConfirm = await run(["keys", "roll", "k1", "--site", SITE]);
    expect(noConfirm.code).toBe(2);
    expect(noConfirm.stderr).toContain("--yes");
    const rolled = await run(["keys", "roll", "k1", "--site", SITE], { answers: ["y"] });
    expect(rolled.stdout).toBe("df_ROLLED\n");
    const cancelled = await run(["keys", "delete", "k1", "--site", SITE], { answers: ["n"] });
    expect(cancelled.code).toBe(130);
    server.data("DELETE", `/api/v1/admin/websites/${SITE}/apikeys/k1`, [{ deleted: true }]);
    expect((await run(["sites", "apikeys", "delete", "k1", "--site", SITE, "-y"])).code).toBe(0);
    expect(server.last().method).toBe("DELETE");
  });

  it("creates and deletes account tokens", async () => {
    server.data("POST", "/api/v1/admin/access-tokens", [{ id: "t1", key: "dft_NEW" }]);
    const res = await run([
      "tokens",
      "create",
      "--name",
      "Read only",
      "--permissions",
      "analytics:read,websites:read",
      "--websites",
      `${SITE},other`,
      "--expires-days",
      "30",
      "--json",
    ]);
    expect(res.json()).toEqual({ id: "t1", key: "dft_NEW" });
    expect(server.last().body).toEqual({
      name: "Read only",
      permissions: ["analytics:read", "websites:read"],
      websiteIds: [SITE, "other"],
      expiresInDays: 30,
    });
    server.data("DELETE", "/api/v1/admin/access-tokens/t1", [{ message: "ok" }]);
    expect((await run(["tokens", "delete", "t1", "--yes"])).stdout).toBe("Revoked token t1.\n");
  });

  it("manages the team", async () => {
    server.data("POST", `/api/v1/admin/websites/${SITE}/team`, [
      { inviteUrl: "https://x/invite/abc" },
    ]);
    const res = await run([
      "team",
      "invite",
      "--site",
      SITE,
      "--email",
      "a@b.co",
      "--role",
      "member",
    ]);
    expect(server.last().body).toEqual({ email: "a@b.co", role: "member" });
    expect(res.stdout).toContain("https://x/invite/abc");
    server.data("DELETE", `/api/v1/admin/websites/${SITE}/team`, [{ message: "ok" }]);
    await run(["team", "remove", "u2", "--site", SITE, "--yes"]);
    expect(server.last().body).toEqual({ userId: "u2" });
    server.data("PUT", `/api/v1/admin/websites/${SITE}/team`, [{ message: "ok" }]);
    await run(["team", "role", "u2", "--role", "viewer", "--site", SITE]);
    expect(server.last().body).toEqual({ userId: "u2", role: "viewer" });
  });
});

describe("goals, funnels, alerts, notes, payments, identify", () => {
  const W = `/api/v1/admin/websites/${SITE}`;

  it("goals", async () => {
    server.data("PATCH", `${W}/goals/customizations`, [{ goalName: "signup" }]);
    await run([
      "goals",
      "customize",
      "signup",
      "--site",
      SITE,
      "--display-name",
      "Sign up",
      "--clear-color",
      "--hidden",
    ]);
    expect(server.last().body).toEqual({
      goalName: "signup",
      displayName: "Sign up",
      color: null,
      hidden: true,
    });
    server.data("GET", `${W}/goals/customizations`, [], {
      colors: [{ name: "blue", hex: "#8dcdff" }],
    });
    const colors = await run(["goals", "colors", "--site", SITE, "--json"]);
    expect(colors.json()).toEqual([{ name: "blue", hex: "#8dcdff" }]);
    server.data("POST", "/api/v1/goals", [{ message: "ok", eventId: "e1" }]);
    await run([
      "goals",
      "track",
      "--site",
      SITE,
      "--visitor",
      "v1",
      "--name",
      "upgrade",
      "--meta",
      "plan=pro",
    ]);
    expect(server.last().body).toEqual({
      datafast_visitor_id: "v1",
      name: "upgrade",
      metadata: { plan: "pro" },
    });
    expect(server.last().query).toEqual({ websiteId: SITE });
    server.data("DELETE", "/api/v1/goals", [{ message: "deleted" }]);
    await run([
      "goals",
      "delete-events",
      "--site",
      SITE,
      "--name",
      "upgrade",
      "--from",
      "2026-01-01",
      "--to",
      "2026-01-31",
      "--yes",
    ]);
    expect(server.last().query).toEqual({
      websiteId: SITE,
      name: "upgrade",
      startAt: "2026-01-01",
      endAt: "2026-01-31",
    });
  });

  it("funnels", async () => {
    server.on("POST", `${W}/funnels`, (req) => ({
      body: { status: "success", data: [{ id: "f1", ...req.body }] },
    }));
    const steps =
      '[{"name":"Pricing","type":"pageview","url":"/pricing"},{"name":"Buy","type":"goal","goalName":"purchase"}]';
    expect(
      (await run(["funnels", "create", "--site", SITE, "--name", "Checkout", "--steps", steps]))
        .code,
    ).toBe(0);
    expect(server.last().body.steps).toHaveLength(2);
    expect(
      (await run(["funnels", "create", "--site", SITE, "--name", "X", "--steps", "nope"])).stderr,
    ).toContain("valid JSON");
    const built = await run(["funnels", "create", "--site", SITE, "--name", "Built"], {
      answers: ["pageview", "/pricing", "", "goal", "signup", "Signed up", ""],
    });
    expect(built.code, built.stderr).toBe(0);
    expect(server.last().body.steps).toEqual([
      { name: "/pricing", type: "pageview", url: "/pricing" },
      { name: "Signed up", type: "goal", goalName: "signup" },
    ]);
    server.data("PUT", `${W}/funnels/f1`, [{ id: "f1" }]);
    await run(["funnels", "update", "f1", "--site", SITE, "--disable"]);
    expect(server.last().body).toEqual({ isActive: false });
    server.data("GET", "/api/v1/analytics/funnels/f1", [
      { name: "Checkout", steps: [{ name: "Pricing", visitors: 10 }] },
    ]);
    const view = await run([
      "funnels",
      "view",
      "f1",
      "--site",
      SITE,
      "--referrer",
      "Google",
      "--period",
      "last30d",
    ]);
    expect(view.stdout).toContain("Checkout");
    expect(server.last().query).toMatchObject({
      filter_referrer: "Google",
      startAt: "2026-10-06",
      endAt: "2026-11-04",
    });
  });

  it("alerts", async () => {
    server.data("POST", `${W}/alerts`, [{ id: "a1" }]);
    await run([
      "alerts",
      "create",
      "--site",
      SITE,
      "--name",
      "New sale",
      "--goal",
      "purchase",
      "--subject",
      "Sale!",
      "--email",
      "me@x.co",
      "--disabled",
    ]);
    expect(server.last().body).toEqual({
      name: "New sale",
      trigger: { goalName: "purchase" },
      template: { message: 'Goal "purchase" was just completed.', subject: "Sale!" },
      destination: { type: "email", email: "me@x.co" },
      isEnabled: false,
    });
    const missing = await run(["alerts", "create", "--site", SITE, "--name", "X"]);
    expect(missing.code).toBe(2);
    server.data("PUT", `${W}/alerts/a1`, [{ id: "a1" }]);
    await run(["alerts", "update", "a1", "--site", SITE, "--enabled"]);
    expect(server.last().body).toEqual({ isEnabled: true });
    server.data("GET", `${W}/alerts/history`, [], { counts: { sent: 2, failed: 1, total: 3 } });
    const history = await run(["alerts", "history", "--site", SITE]);
    expect(history.stdout).toContain("sent 2, failed 1, total 3");
  });

  it("notes", async () => {
    server.data("POST", `${W}/notes`, [{ id: "n1" }]);
    await run(["notes", "add", "--site", SITE, "--text", "Launched v2", "--key", "launch-v2-01"]);
    expect(server.last().body).toEqual({
      text: "Launched v2",
      timestamp: new Date(NOW).toISOString(),
      idempotencyKey: "launch-v2-01",
    });
    server.data("GET", `${W}/notes`, [{ id: "n1", text: "Launched v2", timestamp: "t" }]);
    const list = await run(["notes", "list", "--site", SITE, "--search", "launch"]);
    expect(server.last().query).toMatchObject({ q: "launch" });
    expect(list.stdout).toContain("Launched v2");
  });

  it("payments and identify", async () => {
    server.on("POST", "/api/v1/payments", {
      body: { message: "Payment recorded", transaction_id: "tx1" },
    });
    const res = await run([
      "payments",
      "create",
      "--site",
      SITE,
      "--amount",
      "49.99",
      "--currency",
      "USD",
      "--transaction-id",
      "tx1",
      "--visitor",
      "v1",
      "--renewal",
    ]);
    expect(res.code, res.stderr).toBe(0);
    expect(server.last().body).toEqual({
      amount: 49.99,
      currency: "USD",
      transaction_id: "tx1",
      datafast_visitor_id: "v1",
      renewal: true,
    });
    expect(res.stdout).toContain("Payment recorded");
    expect((await run(["payments", "delete", "--site", SITE, "--yes"])).code).toBe(2);
    server.data("GET", "/api/v1/payments", []);
    await run(["sales", "list", "--site", SITE, "--attributed", "false"]);
    expect(server.last().query).toMatchObject({ attributed: "false" });
    server.on("POST", "/api/v1/identify", { body: { message: "ok", action: "created" } });
    await run([
      "identify",
      "--site",
      SITE,
      "--visitor",
      "v1",
      "--user-id",
      "u42",
      "--name",
      "Ada",
      "--prop",
      "plan=pro",
    ]);
    expect(server.last().body).toEqual({
      plan: "pro",
      datafast_visitor_id: "v1",
      user_id: "u42",
      name: "Ada",
    });
  });
});

describe("errors, help and version", () => {
  it("reports unknown commands and flags as usage errors", async () => {
    expect((await run(["frobnicate"])).code).toBe(2);
    const flag = await run(["sites", "list", "--nope"]);
    expect(flag.code).toBe(2);
    expect(flag.stderr).toContain("Unknown flag --nope");
    const stray = await run(["sites", "list", "--period", "today"]);
    expect(stray.stderr).toContain("does not take --period");
  });

  it("prints help and the version", async () => {
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: datagoat <command>");
    const sub = await run(["help", "analytics"]);
    expect(sub.stdout).toContain("timeseries");
    const bare = await run(["funnels"]);
    expect(bare.stdout).toContain("Subcommands:");
    expect((await run(["--version"])).stdout).toBe("0.0.0-test\n");
  });

  it("explains rate limits and unreachable servers", async () => {
    server.on("GET", "/api/v1/admin/websites", {
      status: 429,
      headers: { "retry-after": "12" },
      body: { error: "Too many requests", message: "Rate limit exceeded." },
    });
    const limited = await run(["sites", "list"]);
    expect(limited.stderr).toBe("Error (429): Rate limit exceeded. (retry after 12s)\n");
    const down = await sb.run(["sites", "list"], {
      env: { DATAGOAT_URL: "http://127.0.0.1:9", DATAGOAT_TOKEN: TOKEN },
    });
    expect(down.code).toBe(1);
    expect(down.stderr).toContain("Could not reach");
  });

  it("--verbose traces requests on stderr", async () => {
    const res = await run(["sites", "list", "--verbose"]);
    expect(res.stderr).toMatch(/GET http:\/\/127\.0\.0\.1:\d+\/api\/v1\/admin\/websites → 200/);
  });
});
