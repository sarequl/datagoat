/**
 * Settings, admin and onboarding pages (W5) against the MSW mock API. The mock state lives in the
 * page, so each test navigates inside the app instead of reloading.
 */
import { expect, type Page, test } from "@playwright/test";

const SITE = "6728f0a0a1b2c3d4e5f6a001";

async function open(page: Page, path: string) {
  await page.goto(`${path}${path.includes("?") ? "&" : "?"}mock-signed-in=1`);
}

/** Client-side navigation that keeps the mock state. */
async function go(page: Page, path: string) {
  await page.evaluate((p) => {
    window.history.pushState(null, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

test("onboarding: add a website, copy the snippet and see the first event arrive", async ({
  page,
}) => {
  await open(page, "/app/new-site");
  await page.getByLabel("Domain").fill("newshop.io");
  await page.getByLabel("Timezone").selectOption("Europe/Berlin");
  await page.getByLabel("Currency").selectOption("EUR");
  await page.getByRole("button", { name: "Add website" }).click();

  await expect(page.getByText(/newshop\.io is added/)).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/install\?welcome=1$/);
  const html = page.getByRole("figure", { name: "HTML snippet" });
  await expect(html).toContainText('data-domain="newshop.io"');
  await expect(html).toContainText("/js/script.js");

  await page.getByRole("tab", { name: "WordPress" }).click();
  await expect(page.getByRole("figure", { name: "WordPress snippet" })).toContainText(
    "add_action('wp_head'",
  );

  // The page polls every 5 s; the mock reports the first visitor on the third check.
  await expect(page.getByText(/Waiting for the first event/)).toBeVisible();
  await expect(
    page.getByText("DataGoat is receiving events from newshop.io.", { exact: false }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole("link", { name: "Stripe" }).click();
  await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
});

test("website settings persist across sections", async ({ page }) => {
  await open(page, `/app/${SITE}/settings/general`);
  const tabs = page.getByRole("navigation", { name: "Settings sections" });
  await tabs.getByRole("link", { name: "Tracking & privacy" }).click();
  await page.getByRole("radio", { name: /^Cookieless/ }).check();
  await expect(page.getByRole("figure", { name: "updated snippet" })).toContainText(
    "script.cookieless.js",
  );
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Saved").first()).toBeVisible();

  await tabs.getByRole("link", { name: "Exclusions" }).click();
  const ips = page.locator("section", { has: page.getByRole("heading", { name: "IP addresses" }) });
  await ips.getByRole("textbox", { name: "Excluded ip addresses" }).fill("10.0.0.0/8");
  await ips.getByRole("textbox", { name: "Excluded ip addresses" }).press("Enter");
  await ips.getByRole("button", { name: "Add my current IP" }).click();
  await expect(ips.getByRole("list", { name: "Excluded ip addresses" })).toContainText(
    "203.0.113.9",
  );
  await ips.getByRole("button", { name: "Save" }).click();
  await expect(ips.getByText("Saved")).toBeVisible();

  await tabs.getByRole("link", { name: "Installation" }).click();
  await expect(page.getByRole("figure", { name: "HTML snippet" })).toContainText(
    "script.cookieless.js",
  );
  await tabs.getByRole("link", { name: "Exclusions" }).click();
  await expect(page.getByRole("list", { name: "Excluded ip addresses" })).toContainText(
    "10.0.0.0/8",
  );
});

test("team invite, API key shown once, and integrations", async ({ page }) => {
  await open(page, `/app/${SITE}/team`);
  await page.getByLabel("Email", { exact: true }).fill("cofounder@example.com");
  await page.getByLabel("Role", { exact: true }).selectOption("member");
  await page.getByRole("button", { name: "Create invite" }).click();
  await expect(page.getByRole("textbox", { name: "Invite link" })).toHaveValue(/\/invite\//);
  await expect(page.getByText("cofounder@example.com", { exact: true })).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "API keys" }).click();
  await page.getByLabel("Key name").fill("Backend");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("textbox", { name: "New secret" })).toHaveValue(/^df_mock/);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("textbox", { name: "New secret" })).toBeHidden();

  await nav.getByRole("link", { name: "Integrations" }).click();
  const polar = page.locator("#integration-polar");
  await polar.getByRole("button", { name: "Connect Polar" }).click();
  await polar.getByLabel("Organization access token").fill("polar_oat_123");
  await polar.getByLabel("Organization ID").fill("org_1");
  await polar.getByRole("button", { name: "Connect Polar" }).click();
  await expect(polar.getByText("Connected", { exact: true })).toBeVisible();
});

/** The copy button must sit outside the code text: no overlap, no clipped or scrolled-away text. */
async function expectCodeBlockReadable(page: Page, name: string) {
  const figure = page.getByRole("figure", { name });
  await figure.scrollIntoViewIfNeeded();
  const button = figure.getByRole("button", { name: `Copy ${name}` });
  const pre = figure.locator("pre");
  const [b, p] = [await button.boundingBox(), await pre.boundingBox()];
  if (!b || !p) throw new Error(`${name}: not rendered`);
  const overlaps =
    b.x < p.x + p.width && b.x + b.width > p.x && b.y < p.y + p.height && b.y + b.height > p.y;
  expect(overlaps, `${name}: copy button overlaps the code`).toBe(false);
  const fits = await pre.evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(fits, `${name}: code is cut off horizontally`).toBe(true);
  const box = await figure.boundingBox();
  const viewport = page.viewportSize();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport?.width ?? 0);
}

test("Meta Ads UTM template is fully readable next to its copy button", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, `/app/${SITE}/integrations`);
  await expectCodeBlockReadable(page, "Meta URL parameters");
  await page.getByRole("button", { name: "Copy Meta URL parameters" }).click();
  await expect(page.getByRole("figure", { name: "Meta URL parameters" })).toContainText("Copied");
});

test("account: sign out everywhere returns to sign-in", async ({ page }) => {
  await open(page, "/app/account");
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test.describe("phone width (390 px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("every settings page fits without horizontal scrolling", async ({ page }) => {
    await open(page, `/app/${SITE}/settings/general`);
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    const paths = [
      "settings/general",
      "settings/install",
      "settings/tracking",
      "settings/exclusions",
      "settings/attribution",
      "settings/danger",
      "team",
      "keys",
      "api-playground",
      "integrations",
      "share",
      "usage",
    ].map((p) => `/app/${SITE}/${p}`);
    for (const path of [...paths, "/app/account", "/app/websites", "/app/new-site"]) {
      await go(page, path);
      await expect(page.locator("main h1").first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, path).toBeLessThanOrEqual(390);
    }
  });

  test("the Meta Ads UTM template wraps beside its copy button", async ({ page }) => {
    await open(page, `/app/${SITE}/integrations`);
    await expectCodeBlockReadable(page, "Meta URL parameters");
  });

  test("dialogs work on a phone", async ({ page }) => {
    await open(page, `/app/${SITE}/settings/danger`);
    await page.getByRole("button", { name: "Delete example.com" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete example.com?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Delete website" })).toBeDisabled();
    await dialog.getByRole("textbox").fill("example.com");
    await dialog.getByRole("button", { name: "Delete website" }).click();
    await expect(page).toHaveURL(/6728f0a0a1b2c3d4e5f6a002\/overview$/);
  });
});
