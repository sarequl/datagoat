/**
 * End to end: each tracker build loaded in real Chromium against `wrangler dev`, then the rows the
 * Worker stored are read back from the local D1 with `wrangler d1 execute`.
 *
 * Test pages are served by Playwright on the Worker's own origin (`/__e2e/...`, never reaching
 * the Worker) and load the real built scripts from `/js/*.js`, like a site that proxies the
 * script and `/api/events` (DataFast's recommended first-party setup). The pages are on
 * localhost, so they set `data-allow-localhost="true"`. Headless Chromium reports
 * `navigator.webdriver` and a `HeadlessChrome` Client Hints brand, which both trackers and the
 * collector treat as a bot, so the browser context overrides both.
 *
 * Runs after the `worker` project (first-run setup creates owner@example.com).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const run = promisify(execFile);

type Row = Record<string, unknown>;

async function sql(query: string): Promise<Row[]> {
  const { stdout } = await run(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      ".wrangler/e2e",
      "--json",
      "--command",
      query,
    ],
    { maxBuffer: 10_000_000 },
  );
  const parsed = JSON.parse(stdout) as Array<{ results: Row[] }>;
  return parsed[0]?.results ?? [];
}

const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;

interface TestSite {
  id: string;
  trackingId: string;
}

const sites: Record<"cookie" | "cookieless" | "hash", TestSite> = {} as never;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request, baseURL }) => {
  const origin = { origin: baseURL ?? "" };
  const login = await request.post("/api/auth/login", {
    data: { email: "owner@example.com", password: "an-e2e-password" },
    headers: origin,
  });
  expect(login.status()).toBe(200);
  for (const kind of ["cookie", "cookieless", "hash"] as const) {
    const res = await request.post("/api/v1/admin/websites", {
      data: { domain: `${kind}-tracker.example.com` },
      headers: origin,
    });
    expect(res.status()).toBe(200);
    const [created] = (await res.json()).data;
    sites[kind] = { id: created.websiteId, trackingId: created.trackingId };
  }
  const put = await request.put(`/api/v1/admin/websites/${sites.cookieless.id}`, {
    data: { privacyMode: "cookieless" },
    headers: origin,
  });
  expect(put.status()).toBe(200);
});

/** A context that looks like a real browser to the bot checks. */
async function humanContext(browser: import("@playwright/test").Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    extraHTTPHeaders: {
      "sec-ch-ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
  });
  return context;
}

function page(script: string, site: TestSite, body: string, head = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>e2e</title>${head}
<script defer data-website-id="${site.trackingId}" data-domain="localhost" data-allow-localhost="true" src="/js/${script}"></script>
</head><body>${body}</body></html>`;
}

async function serve(p: Page, path: string, html: string) {
  await p.route(`**${path}*`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
  );
}

async function waitForRows(query: string, count: number): Promise<Row[]> {
  let rows: Row[] = [];
  await expect
    .poll(
      async () => {
        rows = await sql(query);
        return rows.length;
      },
      { timeout: 20_000, intervals: [250, 500, 1000] },
    )
    .toBeGreaterThanOrEqual(count);
  return rows;
}

test("script.js: pageview, goals, identify, SPA, outbound click and payment link land in D1", async ({
  browser,
}) => {
  const site = sites.cookie;
  const context = await humanContext(browser);
  const p = await context.newPage();
  const html = page(
    "script.js",
    site,
    `<button id="cta" data-fast-goal="signup_clicked" data-fast-goal-plan-type="pro">Sign up</button>
     <a id="out" href="https://external.example.org/docs">External docs</a>
     <section data-fast-scroll="viewed_footer" style="margin-top:3000px;height:200px">Footer</section>`,
    `<script>window.datafast = window.datafast || function () { (window.datafast.q = window.datafast.q || []).push(arguments); };
      window.datafast("queued_goal", { source: "queue" });</script>`,
  );
  await serve(p, "/__e2e/shop", html);
  await p.route("https://external.example.org/**", (route) =>
    route.fulfill({ status: 200, body: "external" }),
  );

  await p.goto("/__e2e/shop?utm_source=e2e&utm_medium=email");
  await p.waitForFunction(
    () => typeof (window as { datafast?: { dg?: number } }).datafast?.dg === "number",
  );
  const visitorId = (await context.cookies()).find((c) => c.name === "datafast_visitor_id")?.value;
  expect(visitorId).toMatch(/^[0-9a-f-]{36}$/);
  const cookie = (await context.cookies()).find((c) => c.name === "datafast_session_id");
  expect(cookie?.sameSite).toBe("Lax");

  await p.click("#cta");
  await p.evaluate(() => {
    const df = (window as unknown as { datafast: (...a: unknown[]) => void }).datafast;
    df("identify", { user_id: "e2e-user", name: "E2E User", plan: "pro" });
    history.pushState({}, "", "/__e2e/shop/pricing");
  });
  await p.waitForTimeout(300);
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await p.waitForTimeout(300);
  await p.click("#out");
  await p.waitForURL("https://external.example.org/docs");

  // A Stripe Payment Link success page in a new page of the same tab session.
  await serve(p, "/__e2e/thanks", page("script.js", site, "<p>Thanks</p>"));
  await p.goto("/__e2e/thanks?session_id=cs_test_e2e123456");
  await p.waitForTimeout(500);

  const events = await waitForRows(
    `SELECT type, name, path, props FROM events WHERE site_id = ${quote(site.id)} ORDER BY id`,
    9,
  );
  const summary = events.map((e) => `${e.type}:${e.name ?? ""}:${e.path}`);
  expect(summary).toEqual(
    expect.arrayContaining([
      "pageview::/__e2e/shop",
      "custom:queued_goal:/__e2e/shop",
      "custom:signup_clicked:/__e2e/shop",
      "identify::/__e2e/shop",
      "pageview::/__e2e/shop/pricing",
      "custom:viewed_footer:/__e2e/shop/pricing",
      "external_link::/__e2e/shop/pricing",
      "pageview::/__e2e/thanks",
      "payment:stripe:/__e2e/thanks",
    ]),
  );
  const goal = events.find((e) => e.name === "signup_clicked");
  expect(JSON.parse(String(goal?.props))).toEqual({ plan_type: "pro" });
  const outbound = events.find((e) => e.type === "external_link");
  expect(JSON.parse(String(outbound?.props))).toEqual({
    url: "https://external.example.org/docs",
    text: "External docs",
  });

  const [session] = await sql(
    `SELECT visitor_id, entry_path, pageviews, interactions, channel, utm_source, browser, device, cookieless FROM sessions WHERE site_id = ${quote(site.id)}`,
  );
  expect(session).toMatchObject({
    visitor_id: visitorId,
    entry_path: "/__e2e/shop",
    channel: "Email",
    utm_source: "e2e",
    browser: "Chrome",
    device: "desktop",
    cookieless: 0,
  });
  expect(Number(session?.pageviews)).toBeGreaterThanOrEqual(3);
  const [visitor] = await sql(
    `SELECT id, user_id, name, profile FROM visitors WHERE site_id = ${quote(site.id)}`,
  );
  expect(visitor).toMatchObject({ id: visitorId, user_id: "e2e-user", name: "E2E User" });
  expect(JSON.parse(String(visitor?.profile))).toEqual({ plan: "pro" });
  expect(
    await sql(`SELECT provider, ref FROM payment_hints WHERE site_id = ${quote(site.id)}`),
  ).toEqual([{ provider: "stripe", ref: "cs_test_e2e123456" }]);
  await context.close();
});

test("script.cookieless.js: no cookies, server visitor id exposed and stored", async ({
  browser,
}) => {
  const site = sites.cookieless;
  const context = await humanContext(browser);
  const p = await context.newPage();
  await serve(
    p,
    "/__e2e/private",
    page("script.cookieless.js", site, `<button data-fast-goal="cta">Go</button>`),
  );
  await p.goto("/__e2e/private");
  const visitorId = await p.waitForFunction(
    () => (window as { datafast?: { visitorId?: string } }).datafast?.visitorId,
  );
  const id = (await visitorId.jsonValue()) as string;
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await p.click("button");
  expect(await context.cookies()).toEqual([]);

  const events = await waitForRows(
    `SELECT type, visitor_id FROM events WHERE site_id = ${quote(site.id)} ORDER BY id`,
    2,
  );
  expect(events.map((e) => e.type)).toEqual(["pageview", "custom"]);
  expect(new Set(events.map((e) => e.visitor_id))).toEqual(new Set([id]));
  const [session] = await sql(
    `SELECT cookieless, session_number FROM sessions WHERE site_id = ${quote(site.id)}`,
  );
  expect(session).toEqual({ cookieless: 1, session_number: null });
  await context.close();
});

test("script.hash.js: hash routes are pages", async ({ browser }) => {
  const site = sites.hash;
  const context = await humanContext(browser);
  const p = await context.newPage();
  await serve(p, "/__e2e/app", page("script.hash.js", site, `<a href="#/settings">Settings</a>`));
  await p.goto("/__e2e/app#/home");
  await p.waitForFunction(() => typeof (window as { datafast?: unknown }).datafast === "function");
  await p.click("a");
  const events = await waitForRows(
    `SELECT path FROM events WHERE site_id = ${quote(site.id)} AND type = 'pageview' ORDER BY id`,
    2,
  );
  expect(events.map((e) => e.path)).toEqual(["/__e2e/app#/home", "/__e2e/app#/settings"]);
  await context.close();
});

test("DataFast's own request shape: JSON over XHR with a CORS preflight", async ({
  browser,
  baseURL,
}) => {
  const site = sites.cookie;
  const context = await humanContext(browser);
  // Chromium's Local Network Access check otherwise blocks a non-loopback-served page (this one
  // is fulfilled by Playwright) from calling localhost; real sites call a public collector.
  await context.grantPermissions(["local-network-access"]);
  const p = await context.newPage();
  // The page is on 127.0.0.1 (served by Playwright), the collector on localhost: a different
  // origin, so the browser must pass the CORS preflight for DataFast's application/json XHR.
  const pageOrigin = (baseURL ?? "").replace("localhost", "127.0.0.1");
  await p.route(`${pageOrigin}/__e2e/blank`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>blank</title>",
    }),
  );
  await p.goto(`${pageOrigin}/__e2e/blank`);
  const collector = baseURL ?? "";
  const status = await p.evaluate(
    async ({ url, websiteId }) =>
      new Promise<number>((resolve) => {
        const x = new XMLHttpRequest();
        x.open("POST", url, true);
        x.setRequestHeader("Content-Type", "application/json");
        x.onload = () => resolve(x.status);
        x.onerror = () => resolve(-1);
        x.send(
          JSON.stringify({
            websiteId,
            domain: "localhost",
            href: "http://localhost:8787/?utm_source=capture_test",
            referrer: null,
            viewport: { width: 1280, height: 720 },
            visitorId: "72de85b4-8d8a-48d6-a920-c50470a86a1a",
            sessionId: "s3457d400-1b6c-4565-b487-f1cf45306cc1",
            visitorFirstSeenAt: "2026-11-04T17:26:33.885Z",
            visitorSessionNumber: 1,
            language: "en-US",
            timezone: "Asia/Dhaka",
            screenWidth: 1280,
            screenHeight: 720,
            type: "pageview",
          }),
        );
      }),
    { url: `${collector}/api/events`, websiteId: site.trackingId },
  );
  expect(status).toBe(200);
  await waitForRows(
    `SELECT id FROM sessions WHERE site_id = ${quote(site.id)} AND id = 's3457d400-1b6c-4565-b487-f1cf45306cc1'`,
    1,
  );
  await context.close();
});
