import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "../../mocks/node";
import { renderSite, SITE } from "./helpers";

describe("overview hub", () => {
  it("shows the conversions, live and revenue and growth cards with links to their pages", async () => {
    renderSite("overview");
    expect(await screen.findByRole("heading", { name: "Conversions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Live and revenue" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Growth" })).toBeInTheDocument();
    // Goals and the activity heatmap live under Conversions.
    expect(screen.getByTestId("card-goals")).toBeInTheDocument();
    expect(screen.getByTestId("card-heatmap")).toBeInTheDocument();

    const funnel = await screen.findByTestId("hub-funnel");
    expect(await within(funnel).findByRole("link", { name: /Open/ })).toHaveAttribute(
      "href",
      expect.stringMatching(new RegExp(`^/app/${SITE}/funnels/`)),
    );
    const revenue = screen.getByTestId("hub-revenue");
    expect(await within(revenue).findByText("MRR")).toBeInTheDocument();
    expect(within(revenue).getByRole("link", { name: /Open/ })).toHaveAttribute(
      "href",
      `/app/${SITE}/revenue`,
    );
    const live = screen.getByTestId("hub-realtime");
    expect(
      await within(live).findByRole("heading", { name: /Realtime · \d+ online/ }),
    ).toBeInTheDocument();
    expect(within(live).getByRole("link", { name: /Open live map/ })).toHaveAttribute(
      "href",
      `/app/${SITE}/realtime`,
    );
    for (const id of ["mentions", "keywords", "crawlers", "ads"]) {
      expect(screen.getByTestId(`hub-${id}`)).toBeInTheDocument();
    }
  });

  it("offers setup in place, hides a setup card and brings it back from Add card", async () => {
    server.use(
      http.get("/api/v1/search-console/status", () =>
        HttpResponse.json({
          status: "success",
          data: {
            connected: false,
            oauthConfigured: true,
            connectUrl: `/api/connect/gsc/start?websiteId=${SITE}`,
            status: null,
            property: null,
            properties: null,
            propertiesError: null,
            lastSyncedAt: null,
            lastError: null,
            oldestDay: null,
            newestDay: null,
            backfillComplete: false,
          },
        }),
      ),
    );
    renderSite("overview");
    const card = await screen.findByTestId("hub-keywords");
    const connect = await within(card).findByRole("link", { name: /Connect Search Console/ });
    expect(connect).toHaveAttribute("href", `/api/connect/gsc/start?websiteId=${SITE}`);
    expect(screen.queryByTestId("hub-add")).not.toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Hide this card" }));
    expect(screen.queryByTestId("hub-keywords")).not.toBeInTheDocument();
    const add = screen.getByRole("region", { name: "Add card" });
    await userEvent.click(within(add).getByRole("button", { name: "+ Search keywords" }));
    expect(await screen.findByTestId("hub-keywords")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("hub-add")).not.toBeInTheDocument());
  });

  it("points a website without visitors at the install guide", async () => {
    server.use(
      http.get("/api/v1/analytics/overview", () =>
        HttpResponse.json({
          status: "success",
          data: [
            {
              visitors: 0,
              new_visitors: 0,
              returning_visitors: 0,
              sessions: 0,
              pageviews: 0,
              bounce_rate: 0,
              avg_session_duration: 0,
              revenue: 0,
              payments: 0,
              revenue_per_visitor: 0,
              conversion_rate: 0,
              currency: "USD",
            },
          ],
        }),
      ),
    );
    renderSite("overview");
    const banner = await screen.findByTestId("awaiting-visitors");
    expect(within(banner).getByRole("link", { name: "Install the script" })).toHaveAttribute(
      "href",
      `/app/${SITE}/settings/install`,
    );
  });
});
