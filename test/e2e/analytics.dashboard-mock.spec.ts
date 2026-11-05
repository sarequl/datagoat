import { expect, type Page, test } from "@playwright/test";

// Analytics pages (W4) against the MSW mock API in a real browser.
const SITE = "/app/6728f0a0a1b2c3d4e5f6a001";
const signedIn = (path: string) => `${path}${path.includes("?") ? "&" : "?"}mock-signed-in=1`;

async function noHorizontalScroll(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
}

test.describe("overview", () => {
  test("KPIs, chart tooltip, click-to-filter, period and comparison live in the URL", async ({
    page,
  }) => {
    await page.goto(signedIn(`${SITE}/overview`));
    await expect(page.getByTestId("kpi-visitors")).toContainText(/\d/);
    await expect(page.getByTestId("kpi-goal")).toContainText("#1 KPI");
    const chart = page.getByRole("slider", { name: /Visitors and revenue over time/ });
    await expect(chart).toBeVisible();
    // With the MRR and ROAS tiles the chart can start below the fold.
    await chart.scrollIntoViewIfNeeded();
    const box = await chart.boundingBox();
    if (!box) throw new Error("chart has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByTestId("chart-tooltip")).toContainText("Visitors");

    await page.getByTestId("card-location").getByRole("tab", { name: "Country" }).click();
    await page.getByRole("button", { name: /^Filter by United States/ }).click();
    await expect(page).toHaveURL(
      /filter_country=is%3AUnited(\+|%20)States|filter_country=is:United/,
    );
    await expect(
      page.getByRole("button", { name: /Remove filter: Country is United States/ }),
    ).toBeVisible();

    await page.getByRole("button", { name: /^Period:/ }).click();
    await page.getByRole("button", { name: /^Last 7 days/ }).click();
    await expect(page).toHaveURL(/period=7d/);
    await page.getByRole("button", { name: "Compare" }).click();
    await expect(page).toHaveURL(/compare=true/);
    await expect(page.getByTestId("previous-line")).toBeAttached();

    // The URL restores the same view.
    await page.reload();
    await expect(page.getByTestId("period-label")).toHaveText("Last 7 days");
    await expect(page.getByRole("button", { name: "Compare" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("keyboard: chart points, actions and notes", async ({ page }) => {
    await page.goto(signedIn(`${SITE}/overview`));
    const chart = page.getByRole("slider", { name: /Visitors and revenue over time/ });
    await chart.focus();
    await page.keyboard.press("End");
    await expect(chart).toHaveAttribute("aria-valuetext", /Visitors/);
    await page.keyboard.press("Enter");
    // The point's numbers stay pinned next to the actions (sticky tooltip).
    const actions = page.getByRole("dialog", { name: "Chart point actions" });
    await expect(actions.getByTestId("chart-pinned-tooltip")).toContainText("Visitors");
    await page.getByRole("button", { name: "Add note here" }).click();
    await page.getByLabel("Note", { exact: true }).fill("Shipped annual plans");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.locator("[title*='Shipped annual plans']")).toBeVisible();
  });

  test("advanced filters and segments", async ({ page }) => {
    await page.goto(signedIn(`${SITE}/overview`));
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Filters" });
    await dialog.getByLabel("Dimension").selectOption("entry_page");
    await dialog.getByLabel("Operator").selectOption("contains");
    await dialog.getByLabel(/^Value/).fill("/blog");
    await dialog.getByRole("button", { name: "Add filter" }).click();
    await expect(page).toHaveURL(
      /filter_entry_page=contains%3A%2Fblog|filter_entry_page=contains:/,
    );
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Filters" })
      .getByRole("button", { name: /^Returning visitors/ })
      .click();
    await expect(page).toHaveURL(/filter_visit_count=gte/);
  });
});

test("realtime: globe or map, visitor details, replay", async ({ page }) => {
  await page.goto(signedIn(`${SITE}/realtime`));
  await expect(page.getByTestId("live-count")).toContainText(/\d+ visitors online/);
  // WebGL globe when available, otherwise the 2D fallback.
  await expect(
    page.getByTestId("realtime-globe").or(page.getByTestId("realtime-2d-map")),
  ).toBeVisible();
  await page.getByRole("list", { name: "Active visitors" }).getByRole("button").first().click();
  await expect(page.getByTestId("visitor-detail")).toBeVisible();
  await page.getByRole("button", { name: "2D map" }).click();
  await expect(page.getByTestId("realtime-2d-map")).toBeVisible();
  await page.getByRole("button", { name: "Replay" }).click();
  await expect(page.getByTestId("replay-time")).toContainText("visitors");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
});

test("visitors list and profile", async ({ page }) => {
  await page.goto(signedIn(`${SITE}/visitors`));
  await page.getByRole("searchbox", { name: "Search visitors" }).fill("Jonas");
  await expect(page).toHaveURL(/q=Jonas/);
  await page
    .getByRole("link", { name: /Jonas Weber/ })
    .first()
    .click();
  await expect(page.getByRole("list", { name: "Journey timeline" })).toContainText("Day 1");
  await page.getByRole("group", { name: "Activity by day" }).getByRole("button").first().click();
  await expect(page.getByRole("heading", { name: /^Day 1 ·/ })).toBeVisible();
});

test("goals: properties and display settings", async ({ page }) => {
  await page.goto(signedIn(`${SITE}/goals`));
  await expect(page.getByRole("img", { name: "Goal completions over time" })).toBeVisible();
  await page
    .getByRole("table", { name: "All goals" })
    .getByRole("button", { name: /^Checkout started/ })
    .click();
  const panel = page.getByRole("dialog", { name: "Checkout started" });
  await panel.getByRole("button", { name: /billing/ }).click();
  await expect(panel.getByText("yearly")).toBeVisible();
  await panel.getByLabel("Display name").fill("Started checkout");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog", { name: "Started checkout" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("table", { name: "All goals" })).toContainText("Started checkout");
});

test("funnels: build one and read the results", async ({ page }) => {
  await page.goto(signedIn(`${SITE}/funnels`));
  await page.getByRole("button", { name: "New funnel" }).click();
  const dialog = page.getByRole("dialog", { name: "New funnel" });
  await dialog.getByLabel("Funnel name").fill("Docs to signup");
  await dialog.getByLabel("Path").fill("/docs");
  await dialog.getByLabel("URL").selectOption("starts_with");
  await dialog.getByLabel("Goal", { exact: true }).fill("signup");
  await dialog.getByRole("button", { name: "Create funnel" }).click();
  await expect(page.getByRole("heading", { name: "Docs to signup", level: 1 })).toBeVisible();
  await expect(page.getByRole("table", { name: "Funnel steps" })).toContainText("Drop-off");
});

test("revenue: attribution and unattributed payments", async ({ page }) => {
  await page.goto(signedIn(`${SITE}/revenue`));
  await expect(page.getByTestId("revenue-summary")).toContainText("Renewals");
  const payments = page.getByRole("region", { name: "Payments" });
  await payments.getByRole("tab", { name: "Unattributed" }).click();
  await expect(payments.getByText("Unattributed").first()).toBeVisible();
  await expect(payments.getByText("Checkout metadata")).toHaveCount(0);
});

test("public shared dashboard without signing in", async ({ page }) => {
  await page.goto("/share/share_demo_token_000000");
  await expect(page.getByRole("heading", { name: "Example SaaS", level: 1 })).toBeVisible();
  await expect(page.getByTestId("kpi-visitors")).toContainText(/\d/);
  await expect(page.getByTestId("kpi-revenue")).toHaveCount(0);
  await expect(page.getByText("Powered by DataGoat")).toBeVisible();
});

test.describe("phone width (390 px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const path of [
    "overview",
    "realtime",
    "visitors",
    "visitors/a3ab2331-989f-4cfa-91c6-2461c9e3c6bd",
    "goals",
    "funnels",
    "funnels/6728f0a0a1b2c3d4e5f6e001",
    "revenue",
  ]) {
    test(`${path} fits without horizontal scroll`, async ({ page }) => {
      await page.goto(signedIn(`${SITE}/${path}`));
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      await noHorizontalScroll(page, 390);
    });
  }

  test("shared dashboard fits", async ({ page }) => {
    await page.goto("/share/share_demo_token_000000");
    await expect(page.getByTestId("kpi-visitors")).toContainText(/\d/);
    await page.waitForLoadState("networkidle");
    await noHorizontalScroll(page, 390);
  });
});
