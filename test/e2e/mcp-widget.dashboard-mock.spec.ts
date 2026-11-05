/**
 * The MCP chart view (src/mcp/widgets.ts) in a real browser: it draws tool results delivered the
 * MCP Apps way (postMessage `ui/notifications/tool-result`) and the ChatGPT way
 * (`window.openai.toolOutput` + `openai:set_globals`). No server is involved.
 */
import { expect, test } from "@playwright/test";
import { WIDGET_HTML } from "../../src/mcp/widgets";

const timeseries = {
  data: [
    { timestamp: "2026-11-01T00:00:00.000Z", name: "Nov 1", visitors: 120, revenue: 49 },
    { timestamp: "2026-11-02T00:00:00.000Z", name: "Nov 2", visitors: 180, revenue: 0 },
    { timestamp: "2026-11-03T00:00:00.000Z", name: "Nov 3", visitors: 150, revenue: 98 },
  ],
  fields: ["visitors", "revenue", "payments"],
  interval: "day",
  currency: "USD",
  totals: { visitors: 410, revenue: 147 },
};

test("draws a traffic and revenue chart from an MCP Apps tool result", async ({ page }) => {
  await page.setContent(WIDGET_HTML);
  await page.evaluate((structuredContent) => {
    window.postMessage(
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent } },
      "*",
    );
  }, timeseries);
  const root = page.locator("#root[data-rendered=true]");
  await expect(root).toContainText("410");
  await expect(root).toContainText("$147");
  await expect(page.getByRole("img", { name: "Visitors and revenue over time" })).toBeVisible();
  await expect(page.locator("rect.rev")).toHaveCount(2);
});

test("draws breakdowns, funnels and the live map from ChatGPT's toolOutput", async ({ page }) => {
  // ChatGPT sets window.openai before the view's script runs.
  const openai = {
    toolOutput: {
      data: [
        { referrer: "Google", visitors: 300, revenue: 120 },
        { referrer: "Direct / None", visitors: 150, revenue: 0 },
      ],
    },
  };
  await page.setContent(
    WIDGET_HTML.replace(
      "<script>",
      `<script>window.openai = ${JSON.stringify(openai)};</script><script>`,
    ),
  );
  const root = page.locator("#root[data-rendered=true]");
  await expect(root.locator("li").first()).toContainText("Google");
  await expect(root.locator("li").first()).toContainText("300");

  await page.evaluate(() => {
    const w = window as unknown as { openai: { toolOutput: unknown } };
    w.openai.toolOutput = {
      data: [
        {
          funnel: { id: "f1", name: "Signup", slug: "signup", steps: [] },
          data: [
            { label: "Pricing", value: 200, conversionRate: 100 },
            { label: "Signed up", value: 50, conversionRate: 25 },
          ],
        },
      ],
    };
    window.dispatchEvent(new Event("openai:set_globals"));
  });
  await expect(root.getByRole("heading", { name: "Signup" })).toBeVisible();
  await expect(root.locator("li").nth(1)).toContainText("25.0%");

  await page.evaluate(() => {
    const w = window as unknown as { openai: { toolOutput: unknown } };
    w.openai.toolOutput = {
      data: {
        count: 2,
        visitors: [
          { latitude: 48.85, longitude: 2.35, isCustomer: false, location: { city: "Paris" } },
          { latitude: 40.71, longitude: -74, isCustomer: true, location: { city: "New York" } },
        ],
      },
    };
    window.dispatchEvent(new Event("openai:set_globals"));
  });
  await expect(page.getByRole("img", { name: "Live visitors by location" })).toBeVisible();
  await expect(page.locator("circle.dot")).toHaveCount(1);
  await expect(page.locator("circle.cust")).toHaveCount(1);
});
