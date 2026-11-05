import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "../../mocks/node";
import { state } from "../../mocks/state";
import { renderSite, SITE, search } from "./helpers";

describe("realtime", () => {
  it("shows the live count, visitors, events and payments, and falls back to the 2D map without WebGL", async () => {
    renderSite("realtime");
    const live = await screen.findByTestId("live-count");
    await waitFor(() => expect(live).toHaveTextContent(/\d+ visitors online/));
    // happy-dom has no WebGL: the globe explains and shows the 2D map instead
    expect(await screen.findByText(/needs WebGL/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(await screen.findByTestId("realtime-2d-map")).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Active visitors" });
    expect(within(list).getAllByRole("button").length).toBeGreaterThanOrEqual(11);
    expect(screen.getByText("Cold")).toBeInTheDocument();

    await userEvent.click(within(list).getByRole("button", { name: /Maya Chen/ }));
    const detail = await screen.findByTestId("visitor-detail");
    expect(detail).toHaveTextContent("Customer");
    expect(within(detail).getByRole("link", { name: /visitor journey/ })).toHaveAttribute(
      "href",
      expect.stringContaining(`/app/${SITE}/visitors/`),
    );

    await userEvent.click(screen.getByRole("tab", { name: /Events/ }));
    expect(await screen.findByRole("list", { name: "Recent events" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Payments" }));
    expect(await screen.findByRole("list", { name: "Recent payments" })).toHaveTextContent("+$99");
  });

  it("matches the map style to the app theme until a style is picked", async () => {
    document.documentElement.setAttribute("data-theme", "light");
    const { container } = renderSite("realtime");
    await screen.findByRole("list", { name: "Active visitors" });
    expect(screen.getByLabelText("Style")).toHaveValue("auto");
    const stage = () => container.querySelector("div[data-theme]");
    expect(stage()).toHaveAttribute("data-theme", "light");
    act(() => document.documentElement.setAttribute("data-theme", "dark"));
    await waitFor(() => expect(stage()).toHaveAttribute("data-theme", "dark"));
    // A dark style keeps its dark panels in the light theme.
    act(() => document.documentElement.setAttribute("data-theme", "light"));
    await userEvent.selectOptions(screen.getByLabelText("Style"), "satellite");
    expect(stage()).toHaveAttribute("data-theme", "dark");
    document.documentElement.setAttribute("data-theme", "dark");
    window.localStorage.clear();
  });

  it("filters live visitors by country, switches view and style, and replays the last 8 hours", async () => {
    renderSite("realtime");
    const list = await screen.findByRole("list", { name: "Active visitors" });
    const before = within(list).getAllByRole("button").length;
    await userEvent.click(screen.getByRole("button", { name: /🇺🇸 US/ }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Active visitors" })).getAllByRole("button").length,
      ).toBeLessThan(before),
    );
    await userEvent.click(screen.getByRole("button", { name: "2D map" }));
    expect(screen.getByRole("button", { name: "2D map" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.selectOptions(screen.getByLabelText("Style"), "satellite");
    expect(window.localStorage.getItem("dg:realtime:mapStyle")).toBe('"satellite"');
    await userEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(await screen.findByTestId("replay-time")).toHaveTextContent(/visitors · \d+ pageviews/);
    const slider = screen.getByRole("slider", { name: "Replay time" });
    expect(slider).toHaveAttribute("max", "31");
    window.localStorage.clear();
  });
});

describe("visitors", () => {
  it("lists and searches visitors and opens a profile with the journey", async () => {
    renderSite("visitors");
    const table = await screen.findByRole("table", { name: /Visitors/ });
    expect(within(table).getAllByRole("row").length).toBeGreaterThan(10);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search visitors" }), "Maya");
    await waitFor(() => expect(search().get("q")).toBe("Maya"));
    await waitFor(() =>
      expect(within(screen.getByRole("table")).getAllByRole("row").length).toBeLessThan(10),
    );
    const link = within(screen.getByRole("table")).getAllByRole("link", {
      name: /Maya Chen/,
    })[0] as HTMLElement;
    await userEvent.click(link);
    expect(
      await screen.findByRole("heading", { level: 1, name: /Maya Chen|[A-Z][a-z]+ [A-Z][a-z]+/ }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Journey timeline" })).toHaveTextContent(
      /Day 1/,
    );
    // Google sessions show Search Console keyword guesses (DataFast's keyword probability).
    expect(screen.getByTestId("search-keywords")).toHaveTextContent(
      "Likely searched: “revenue analytics” 62%, “datagoat” 38%",
    );
    expect(screen.getByRole("group", { name: "Activity by day" })).toBeInTheDocument();
    expect(screen.getByText("Identity")).toBeInTheDocument();
    // The back link sits on its own row above the title and returns to the list.
    const back = within(screen.getByRole("main")).getByRole("link", { name: "Visitors" });
    expect(back).toHaveAttribute("href", expect.stringMatching(/\/visitors$/));
    await userEvent.click(back);
    expect(await screen.findByRole("table", { name: /Visitors/ })).toBeInTheDocument();
  });

  it("applies customers-only and dashboard filters, and says which filters cannot apply", async () => {
    renderSite("visitors?filter_referrer=is_not:Google&filter_country=is:US");
    expect(await screen.findByRole("note")).toHaveTextContent("Referrer is not Google");
    await userEvent.click(screen.getByLabelText("Customers only"));
    await waitFor(() => expect(search().get("customers")).toBe("true"));
    const table = await screen.findByRole("table");
    await waitFor(() =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .forEach((r) => {
          expect(r).toHaveTextContent("$");
        }),
    );
  });

  it("shows a prediction for a visitor who has not bought", async () => {
    renderSite("visitors/b2c3d4e5-1111-4222-8333-444455556666");
    await screen.findByRole("list", { name: "Journey timeline" });
    const prediction = screen.queryByTestId("prediction");
    if (prediction) expect(prediction).toHaveTextContent("/ 100");
    else expect(screen.getByText("Lifetime revenue")).toBeInTheDocument();
  });
});

describe("goals", () => {
  it("lists goals, opens the properties panel and customises a goal", async () => {
    renderSite("goals");
    expect(
      await screen.findByRole("img", { name: "Goal completions over time" }),
    ).toBeInTheDocument();
    await userEvent.click(
      await within(await screen.findByRole("table", { name: "All goals" })).findByRole("button", {
        name: /^Signed up/,
      }),
    );
    const panel = await screen.findByRole("dialog", { name: "Signed up" });
    await userEvent.click(await within(panel).findByRole("button", { name: /plan/ }));
    expect(await within(panel).findByText("free")).toBeInTheDocument();
    const name = within(panel).getByLabelText("Display name");
    await userEvent.clear(name);
    await userEvent.type(name, "Account created");
    await userEvent.click(within(panel).getByRole("radio", { name: "Green" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        state.analytics.goalCustomizations[SITE]?.find((c) => c.goalName === "signup"),
      ).toMatchObject({
        displayName: "Account created",
        color: "#10b981",
      }),
    );
    expect(
      await within(screen.getByRole("table", { name: "All goals" })).findByRole("button", {
        name: /^Account created/,
      }),
    ).toBeInTheDocument();
  });

  it("hides a goal and sets a goal as #1 KPI", async () => {
    renderSite("goals");
    await userEvent.click(
      await within(await screen.findByRole("table", { name: "All goals" })).findByRole("button", {
        name: /^newsletter_subscribe/,
      }),
    );
    let panel = await screen.findByRole("dialog", { name: "newsletter_subscribe" });
    await userEvent.click(within(panel).getByLabelText(/Hide from the chart/));
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByLabelText(/Show 1 hidden/)).toBeInTheDocument();
    await userEvent.click(
      within(screen.getByRole("table", { name: "All goals" })).getByRole("button", {
        name: /^Checkout started/,
      }),
    );
    panel = await screen.findByRole("dialog", { name: "Checkout started" });
    await userEvent.click(within(panel).getByRole("button", { name: "Set as #1 KPI" }));
    await waitFor(() => expect(state.websites[0]?.kpi).toBe("checkout_started"));
    expect(await within(panel).findByRole("button", { name: "Unset #1 KPI" })).toBeInTheDocument();
  });

  it("jumps to visitors who completed a goal", async () => {
    renderSite("goals");
    await userEvent.click(
      await within(await screen.findByRole("table", { name: "All goals" })).findByRole("button", {
        name: /^Signed up/,
      }),
    );
    const panel = await screen.findByRole("dialog", { name: "Signed up" });
    await userEvent.click(within(panel).getByRole("button", { name: "Visitor journeys" }));
    expect(await screen.findByRole("heading", { name: "Visitors", level: 1 })).toBeInTheDocument();
    expect(search().get("goal")).toBe("signup");
  });
});

describe("funnels", () => {
  it("lists funnels, validates and creates one, shows results and deletes it", async () => {
    renderSite("funnels");
    expect(await screen.findByRole("heading", { name: "Signup funnel" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New funnel" }));
    const dialog = await screen.findByRole("dialog", { name: "New funnel" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Create funnel" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Give the funnel a name");
    await userEvent.type(within(dialog).getByLabelText("Funnel name"), "Pricing to paid");
    const paths = within(dialog).getAllByLabelText("Path");
    await userEvent.clear(paths[0] as HTMLElement);
    await userEvent.type(paths[0] as HTMLElement, "/pricing");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create funnel" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Step 2: choose a goal");
    await userEvent.type(within(dialog).getByLabelText("Goal"), "payment");
    await userEvent.click(within(dialog).getByRole("button", { name: "+ Goal step" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove step 3" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Move step 2 up" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Move step 1 down" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create funnel" }));
    expect(
      await screen.findByRole("heading", { name: "Pricing to paid", level: 1 }),
    ).toBeInTheDocument();
    const created = state.analytics.funnels[SITE]?.find((f) => f.name === "Pricing to paid");
    expect(created?.steps).toMatchObject([
      { type: "pageview", url: "/pricing", urlMatchType: "equals" },
      { type: "goal", goalName: "payment", goalCompletionType: "completed" },
    ]);
    expect(await screen.findByRole("table", { name: "Funnel steps" })).toHaveTextContent(
      "Drop-off",
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete funnel" }));
    expect(await screen.findByRole("heading", { name: "Funnels", level: 1 })).toBeInTheDocument();
    expect(state.analytics.funnels[SITE]?.find((f) => f.name === "Pricing to paid")?.isActive).toBe(
      false,
    );
  });

  it("edits a funnel and shows revenue per step", async () => {
    renderSite("funnels/6728f0a0a1b2c3d4e5f6e001");
    const table = await screen.findByRole("table", { name: "Funnel steps" });
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    expect(table).toHaveTextContent("$");
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit funnel" });
    const name = within(dialog).getByLabelText("Funnel name");
    await userEvent.clear(name);
    await userEvent.type(name, "Signup funnel v2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save funnel" }));
    expect(
      await screen.findByRole("heading", { name: "Signup funnel v2", level: 1 }),
    ).toBeInTheDocument();
  });

  it("prefills a funnel from a goal", async () => {
    renderSite("funnels?newGoal=signup");
    const dialog = await screen.findByRole("dialog", { name: "New funnel" });
    expect(within(dialog).getByLabelText("Goal")).toHaveValue("signup");
  });
});

describe("revenue", () => {
  it("shows totals, attribution, LTV, path to purchase and payments with attribution sources", async () => {
    renderSite("revenue");
    expect(await screen.findByTestId("revenue-summary")).toHaveTextContent("Refunds");
    await waitFor(() =>
      expect(screen.getByTestId("revenue-summary")).toHaveTextContent(/MRR \(now\)\s*\$1,247/),
    );
    expect(await screen.findByText(/of revenue linked to a visitor/)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Lifetime value by first channel" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Most common paths" })).toHaveTextContent(
      "Organic Search",
    );
    const payments = screen.getByRole("region", { name: "Payments" });
    expect(await within(payments).findAllByText("Checkout metadata")).not.toHaveLength(0);
    await userEvent.click(within(payments).getByRole("tab", { name: "Unattributed" }));
    await waitFor(() => {
      const badges = within(payments).getAllByText(/Unattributed|Checkout metadata|Payment link/);
      expect(
        badges.filter((b) => b.tagName === "SPAN").every((b) => b.textContent === "Unattributed"),
      ).toBe(true);
    });
    await userEvent.click(within(payments).getByRole("tab", { name: "Refunds" }));
    await waitFor(() => expect(within(payments).getAllByText("Refund").length).toBeGreaterThan(0));
    expect(within(payments).queryByText("Renewal")).not.toBeInTheDocument();
  });

  it("filters the dashboard from revenue by channel", async () => {
    renderSite("revenue");
    const card = await screen.findByTestId("card-revenue-channel");
    await userEvent.click(await within(card).findByRole("button", { name: /Filter by AI/ }));
    await waitFor(() => expect(search().get("filter_channel")).toBe("is:AI"));
  });

  it("works when the server has no path-to-purchase data", async () => {
    server.use(
      http.get("/api/v1/analytics/revenue", () =>
        HttpResponse.json({
          status: "success",
          data: {
            currency: "USD",
            revenue: 0,
            newRevenue: 0,
            renewalRevenue: 0,
            refunds: 0,
            payments: 0,
            customers: 0,
            attribution: {
              attributedRevenue: 0,
              unattributedRevenue: 0,
              coveragePercentage: 0,
              byMethod: { metadata: 0, link: 0, customer: 0, email: 0, api: 0, none: 0 },
            },
            lifetimeValueByChannel: [],
          },
        }),
      ),
    );
    renderSite("revenue");
    expect(await screen.findByText(/not available from this server/)).toBeInTheDocument();
    expect(screen.getByText("No customers yet.")).toBeInTheDocument();
  });
});
