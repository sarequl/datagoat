import { expect, test } from "@playwright/test";

// Headless Chromium hides scrollbars by default; show them so their width is real.
test.use({
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
  viewport: { width: 1440, height: 1000 },
});

test("the layout does not shift between short and scrolling pages", async ({ page }) => {
  const logoX = async (path: string) => {
    await page.goto(`/app/6728f0a0a1b2c3d4e5f6a001/${path}?mock-signed-in=1`);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    return (await page.getByRole("link", { name: "DataGoat" }).boundingBox())?.x;
  };
  const long = await logoX("overview");
  expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
  const short = await logoX("settings/danger");
  expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(
    false,
  );
  expect(short).toBe(long);
});
