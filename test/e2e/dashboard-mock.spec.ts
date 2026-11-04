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
  await nav.getByRole("link", { name: "Funnels" }).click();
  await expect(page.getByRole("heading", { name: "Funnels", level: 1 })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Owner: W");

  await page.getByRole("combobox", { name: "Website" }).selectOption({ label: "Indie blog" });
  await expect(page).toHaveURL(/6728f0a0a1b2c3d4e5f6a002\/overview$/);
});

test.describe("phone width (390 px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("collapses the sidebar into a top bar with a drawer", async ({ page }) => {
    await page.goto("/app/6728f0a0a1b2c3d4e5f6a001/overview?mock-signed-in=1");
    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    // The desktop sidebar is hidden; the page content is the first thing under the top bar.
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
    const menu = page.getByRole("button", { name: "Open menu" });
    await expect(menu).toBeVisible();
    const heading = await page.getByRole("heading", { name: "Overview", level: 1 }).boundingBox();
    expect(heading?.y ?? 999).toBeLessThan(200);
    // No horizontal scroll.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );

    await menu.click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    await menu.click();
    await drawer.getByRole("link", { name: "Revenue" }).click();
    await expect(page.getByRole("heading", { name: "Revenue", level: 1 })).toBeVisible();
    await expect(drawer).toBeHidden();
  });
});
