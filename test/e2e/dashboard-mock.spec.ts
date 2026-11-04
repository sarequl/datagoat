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
  await expect(page.getByRole("heading", { name: "Funnels" })).toBeVisible();
  await expect(page.getByTestId("placeholder-owner")).toContainText("W4");

  await page.getByRole("combobox", { name: "Website" }).selectOption({ label: "Indie blog" });
  await expect(page).toHaveURL(/6728f0a0a1b2c3d4e5f6a002\/overview$/);
});
