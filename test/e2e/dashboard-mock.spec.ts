import { expect, test } from "@playwright/test";

test("signs in against the mock API and navigates the shell", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email").fill("demo@datagoat.dev");
  await page.getByLabel("Password").fill("demo-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/6728f0a0a1b2c3d4e5f6a001\/overview$/);

  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Visitors", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Visitors", level: 1 })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Owner: W");

  await page.getByRole("combobox", { name: "Website" }).selectOption({ label: "Indie blog" });
  await expect(page).toHaveURL(/6728f0a0a1b2c3d4e5f6a002\/overview$/);

  // Search or jump to: Ctrl+K, type, Enter.
  await page.keyboard.press("Control+k");
  const search = page.getByRole("combobox", { name: "Search pages and websites" });
  await expect(search).toBeFocused();
  await search.fill("usage");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Usage & data", level: 1 })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute("data-active", "");
  const menu = page.getByRole("navigation", { name: "Settings sections" });
  await expect(menu.getByRole("link", { name: "Usage & data" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test.describe("phone width (390 px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("keeps the top bar compact and every section one tap away", async ({ page }) => {
    await page.goto("/app/6728f0a0a1b2c3d4e5f6a001/overview?mock-signed-in=1");
    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toBeVisible();
    const heading = await page.getByRole("heading", { name: "Overview", level: 1 }).boundingBox();
    expect(heading?.y ?? 999).toBeLessThan(200);
    // No horizontal scroll.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await nav.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "General", level: 1 })).toBeVisible();
    const menu = page.getByRole("navigation", { name: "Settings sections" });
    await menu.getByRole("link", { name: "Team" }).click();
    await expect(page.getByRole("heading", { name: "Team", level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  });
});
