import { expect, type Page, test } from "@playwright/test";

const SITE = "6728f0a0a1b2c3d4e5f6a001";
const cards = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-card]"), (e) => e.getAttribute("data-card")),
  );

test("customize the overview by dragging a card and saving it", async ({ page }) => {
  await page.goto(`/app/${SITE}/overview?mock-signed-in=1`);
  await expect(page.getByTestId("card-source")).toBeVisible();
  await page.getByRole("button", { name: "Customize" }).click();

  // Drag Pages onto Source with real pointer moves (HTML drag and drop).
  const handle = page.getByRole("button", { name: "Drag Pages" });
  // Centre it: the floating Customize bar sits at the bottom of the screen.
  await handle.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const from = await handle.boundingBox();
  const to = await page.locator('[data-card="source"]').boundingBox();
  if (!from || !to) throw new Error("no boxes");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x - 40, from.y + 30, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await cards(page)).slice(0, 2)).toEqual(["pages", "source"]);

  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("toolbar", { name: "Customize Overview" })).toBeHidden();
  // The new order stays after leaving Customize mode.
  expect((await cards(page)).slice(0, 2)).toEqual(["pages", "source"]);
});
