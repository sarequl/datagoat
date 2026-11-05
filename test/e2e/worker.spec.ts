import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const run = promisify(execFile);

test("first-run setup on the real Worker creates the owner and website", async ({
  page,
  request,
}) => {
  const status = await request.get("/api/setup");
  expect(await status.json()).toEqual({
    status: "success",
    data: { needsSetup: true, configErrors: [] },
  });

  await page.goto("/setup?token=e2e-setup-token-0123456789");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel(/^Password/).fill("an-e2e-password");
  await page.getByLabel(/First website/).fill("example.com");
  await page.getByRole("button", { name: "Create owner account" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Website" }).locator("option:checked"),
  ).toHaveText("example.com");

  // The session cookie authenticates the dashboard API.
  const sites = await page.request.get("/api/v1/admin/websites");
  expect((await sites.json()).data[0]).toMatchObject({ domain: "example.com", role: "owner" });

  // Sign out and back in.
  await page.getByRole("button", { name: /^Account menu/ }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Password").fill("an-e2e-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});

test("serves the tracker as a static asset and validates ingest bodies", async ({ request }) => {
  const script = await request.get("/js/script.js");
  expect(script.status()).toBe(200);
  expect(await script.text()).toContain("DataGoat tracker");
  // llms.txt for AI agents (DataFast publishes one too).
  const llms = await request.get("/llms.txt");
  expect(llms.status()).toBe(200);
  expect(await llms.text()).toContain("/api/v1/analytics/overview");
  const ingest = await request.post("/api/events", { data: { type: "pageview" } });
  expect(ingest.status()).toBe(400);
  expect(ingest.headers()["access-control-allow-origin"]).toBe("*");
  expect((await ingest.json()).error.message).toBe("websiteId is required");
});

test("npm run smoke passes against the running Worker", async ({ baseURL }) => {
  // Runs after the setup test above, so it signs in with that owner.
  const { stdout } = await run("node", [
    "scripts/smoke.mjs",
    "--url",
    baseURL ?? "",
    "--email",
    "owner@example.com",
    "--password",
    "an-e2e-password",
  ]);
  expect(stdout).toContain("OK: ");
  expect(stdout).not.toContain("FAIL ");
});
