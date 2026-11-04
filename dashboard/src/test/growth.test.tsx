import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { resetGrowthMock } from "../mocks/handlers/growth-w6";
import { server } from "../mocks/node";
import { resetMockState } from "../mocks/state";
import { toRequest } from "../pages/growth/AlertsPage";
import { renderApp } from "./render";

const SITE = "6728f0a0a1b2c3d4e5f6a001";
const open = (page: string) => {
  resetMockState({ signedIn: true });
  return renderApp(`/app/${SITE}/${page}`);
};

beforeEach(() => resetGrowthMock());

/** A stored (uncompressed) ZIP, so the test does not depend on DecompressionStream. */
function storedZip(files: Array<{ name: string; text: string }>): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = enc.encode(f.text);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const c = new Uint8Array(46 + name.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    c.set(name, 46);
    parts.push(local);
    central.push(c);
    offset += local.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let p = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

describe("Alerts page", () => {
  it("lists rules and history, and creates a Telegram sale alert", async () => {
    open("alerts");
    expect(await screen.findByRole("heading", { name: "Alerts" })).toBeInTheDocument();
    expect(await screen.findByText("Goal “signup”")).toBeInTheDocument();
    expect(await screen.findByText("2 sent · 1 failed")).toBeInTheDocument();
    expect(screen.getByText(/chat not found/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "New alert" }));
    const form = screen.getByRole("form", { name: "New alert" });
    await userEvent.type(within(form).getByLabelText("Name"), "Sales to Telegram");
    await userEvent.selectOptions(within(form).getByLabelText("When"), "new_sale");
    await userEvent.selectOptions(within(form).getByLabelText("Send to"), "telegram");
    await userEvent.type(within(form).getByLabelText(/^Chat id/), "-1001");
    await userEvent.type(within(form).getByLabelText(/^Bot token/), "123:ABCDEFGHIJKLMNOPQRSTUVWX");
    await userEvent.click(within(form).getByRole("button", { name: "Create alert" }));
    expect(await screen.findByText("Sales to Telegram")).toBeInTheDocument();
    expect(screen.getByText("Telegram chat -1001")).toBeInTheDocument();
  });

  it("sends a test and shows server errors", async () => {
    server.use(
      http.post("/api/v1/admin/websites/:id/alerts/:alertId/test", () =>
        HttpResponse.json(
          {
            status: "error",
            error: { code: 502, message: "Test alert failed: Email is not configured" },
          },
          { status: 502 },
        ),
      ),
    );
    open("alerts");
    await userEvent.click(await screen.findByRole("button", { name: "Test New signup" }));
    expect(
      await screen.findByText("Test alert failed: Email is not configured"),
    ).toBeInTheDocument();
  });

  it("builds DataFast-compatible request bodies", () => {
    const body = toRequest(
      {
        name: " Signup ",
        type: "goal",
        goalName: "signup",
        multiplier: "4",
        includeRenewals: true,
        includeFreeTrials: false,
        channel: "email",
        email: "",
        chatId: "",
        botToken: "",
        url: "",
        subject: "",
        message: "Someone signed up!",
      },
      false,
    );
    expect(body).toEqual({
      name: "Signup",
      trigger: { type: "goal", goalName: "signup" },
      destination: { type: "email" },
      template: { message: "Someone signed up!" },
    });
  });
});

describe("Bot traffic page", () => {
  it("shows totals, crawlers, pages search and settings with a one-time token", async () => {
    open("bot-traffic");
    expect(await screen.findByRole("heading", { name: "Bot traffic" })).toBeInTheDocument();
    expect(await screen.findByText("12,840")).toBeInTheDocument();
    expect(screen.getByText("ChatGPT-User")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "AI answers" }));
    await waitFor(() => expect(screen.queryByText("ClaudeBot")).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole("tab", { name: "Pages" }));
    expect(await screen.findByText("/free-trial")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Search pages"), "llms");
    await waitFor(() => expect(screen.queryByText("/free-trial")).not.toBeInTheDocument());
    expect(screen.getByText("/llms.txt")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(await screen.findByRole("button", { name: "Create token" }));
    expect(await screen.findByText("dfbot_mockShownOnce")).toBeInTheDocument();
    const meta = await screen.findByLabelText(/^Meta \(/);
    expect(meta).not.toBeChecked();
    await userEvent.click(meta);
    await waitFor(() => expect(screen.getByLabelText(/^Meta \(/)).toBeChecked());
    expect(screen.getByText(/withAICrawlerTracking/)).toBeInTheDocument();
  });

  it("toggles attack mode", async () => {
    open("bot-traffic");
    const auto = await screen.findByLabelText(/^Auto-enable on abnormal bot traffic/);
    await userEvent.click(auto);
    await waitFor(() =>
      expect(screen.getByLabelText(/^Auto-enable on abnormal bot traffic/)).toBeChecked(),
    );
    await userEvent.click(screen.getByLabelText(/^Attack mode is off/));
    expect(await screen.findByLabelText(/^Attack mode is on/)).toBeChecked();
  });
});

describe("Mentions page", () => {
  it("lists and filters mentions, shows X link attribution and saves keywords", async () => {
    open("mentions");
    expect(await screen.findByText("We launched our new website: example.com")).toBeInTheDocument();
    expect(screen.getByText("r/SaaS")).toBeInTheDocument();
    await userEvent.click(
      within(screen.getByRole("tablist", { name: "Platform" })).getByRole("tab", {
        name: "Reddit",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText("We launched our new website: example.com"),
      ).not.toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole("tab", { name: "X link attribution" }));
    expect(await screen.findByText("@example: We launched…")).toBeInTheDocument();
    expect(screen.getByText("310")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    const keywords = await screen.findByLabelText(/^Keywords/);
    await waitFor(() => expect(keywords).toHaveValue("DataGoat"));
    await userEvent.type(keywords, ", #launch");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Saved\. New mentions appear/)).toBeInTheDocument();
  });
});

describe("Search Console page", () => {
  it("offers to connect, then shows keywords with estimated revenue", async () => {
    open("search-console");
    expect(await screen.findByRole("link", { name: "Connect with Google" })).toHaveAttribute(
      "href",
      `/api/connect/google-search-console/start?websiteId=${SITE}&returnTo=search-console`,
    );
    server.use(
      http.get("/api/v1/search-console/status", () =>
        HttpResponse.json({
          status: "success",
          data: {
            connected: true,
            oauthConfigured: true,
            connectUrl: null,
            status: "active",
            property: "sc-domain:example.com",
            properties: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }],
            propertiesError: null,
            lastSyncedAt: null,
            lastError: null,
            oldestDay: "2025-07-01",
            newestDay: "2026-11-01",
            backfillComplete: true,
          },
        }),
      ),
    );
    open("search-console");
    expect(await screen.findByText("datafast alternative")).toBeInTheDocument();
    expect(screen.getByText("$540.00")).toBeInTheDocument();
    expect(screen.getByText("$850.00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Pages" }));
    expect(
      await screen.findByText("https://example.com/blog/privacy-analytics"),
    ).toBeInTheDocument();
  });
});

describe("Ads page", () => {
  it("connects Meta, chooses campaigns and shows ROAS", async () => {
    open("ads");
    expect(await screen.findByRole("link", { name: "Connect Meta Ads" })).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText(/^Or paste a Meta access token/),
      "EAAB-system-user-token",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save token" }));
    expect((await screen.findAllByText("2.8x")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("$1,400.00").length).toBeGreaterThan(0);
    await userEvent.click(await screen.findByLabelText(/^Launch - US/));
    await userEvent.click(screen.getByRole("button", { name: "Save campaigns" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save campaigns" })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Launch - US")).toBeInTheDocument();
  });
});

describe("Import page", () => {
  it("parses a Plausible export in the browser and uploads it in chunks", async () => {
    let uploaded = 0;
    server.use(
      http.post("/api/v1/admin/websites/:id/imports/:importId/rows", async ({ request }) => {
        const { rows } = (await request.json()) as { rows: unknown[] };
        uploaded += rows.length;
        return HttpResponse.json({ status: "success", data: [{ accepted: rows.length }] });
      }),
    );
    open("import");
    expect(await screen.findByText("plausible-export.zip")).toBeInTheDocument();
    const zip = storedZip([
      {
        name: "imported_visitors_20240101_20240102.csv",
        text: "date,visitors,pageviews,bounces,visits,visit_duration\n2024-01-01,10,25,4,12,600\n2024-01-02,8,16,2,9,300\n",
      },
      {
        name: "imported_pages_20240101_20240102.csv",
        text: "date,hostname,page,visits,visitors,pageviews\n2024-01-01,example.com,/,10,9,20\n",
      },
    ]);
    const file = new File([zip as Uint8Array<ArrayBuffer>], "export.zip", {
      type: "application/zip",
    });
    await userEvent.upload(screen.getByLabelText("Plausible export (.zip)"), file);
    await userEvent.click(screen.getByRole("button", { name: "Start import" }));
    expect(
      await screen.findByText(/Imported 3 rows \(2024-01-01 to 2024-01-02\)/),
    ).toBeInTheDocument();
    expect(uploaded).toBe(3);
    expect(await screen.findByText("export.zip")).toBeInTheDocument();
  });

  it("explains files that are not Plausible exports", async () => {
    open("import");
    const file = new File(["nope"], "x.zip", { type: "application/zip" });
    await userEvent.upload(await screen.findByLabelText("Plausible export (.zip)"), file);
    await userEvent.click(screen.getByRole("button", { name: "Start import" }));
    expect(await screen.findByText(/Not a ZIP file/)).toBeInTheDocument();
  });
});
