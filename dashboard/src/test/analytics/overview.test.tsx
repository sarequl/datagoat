import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "../../mocks/node";
import { resetMockState, state } from "../../mocks/state";
import { renderApp } from "../render";
import { renderSite, SITE, search } from "./helpers";

describe("overview", () => {
  it("shows KPIs with deltas, the #1 KPI, the main chart, breakdown cards and the heatmap", async () => {
    renderSite("overview");
    expect(await screen.findByRole("heading", { name: "Overview", level: 1 })).toBeInTheDocument();
    const visitors = await screen.findByTestId("kpi-visitors");
    await waitFor(() => expect(visitors).toHaveTextContent(/\d/));
    expect(visitors).toHaveTextContent(/new · .* returning/);
    // No manual refresh button: data refetches on its own.
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
    for (const k of [
      "revenue",
      "payments",
      "revenue_per_visitor",
      "conversion_rate",
      "sessions",
      "pageviews",
      "bounce_rate",
      "avg_session_duration",
    ]) {
      expect(screen.getByTestId(`kpi-${k}`)).toBeInTheDocument();
    }
    await waitFor(() => expect(visitors).toHaveTextContent(/[↑↓→]/));
    expect(await screen.findByTestId("kpi-goal")).toHaveTextContent("Signed up");
    expect(await screen.findByTestId("kpi-live")).toHaveTextContent(/\d+\s*online now/);
    expect(
      await screen.findByRole("slider", { name: /Visitors and revenue over time/ }),
    ).toBeInTheDocument();
    // Refunded revenue is drawn greyed out on top of the revenue bars.
    expect(screen.getAllByTestId("refund-bar").length).toBeGreaterThan(0);
    const source = screen.getByTestId("card-source");
    expect(
      await within(source).findByRole("button", { name: /Filter by Organic Search/ }),
    ).toBeInTheDocument();
    expect(within(source).getByRole("tab", { name: "Channel" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // DataFast's channel pie: share of visitors per channel above the list.
    expect(
      within(source).getByRole("figure", { name: "Channel share of visitors" }),
    ).toHaveTextContent(/Organic Search\s*\d+%/);
    expect(
      await within(screen.getByTestId("card-pages")).findByRole("button", {
        name: /Filter by \/pricing/,
      }),
    ).toBeInTheDocument();
    expect(
      await within(screen.getByTestId("card-system")).findByRole("button", {
        name: /Filter by Chrome/,
      }),
    ).toBeInTheDocument();
    expect(
      await within(screen.getByTestId("card-goals")).findByRole("button", {
        name: /Filter by goal Signed up/,
      }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: /by weekday and hour/ })).toBeInTheDocument();
    // markers for notes, commits and mentions under the chart
    expect((await screen.findAllByRole("button", { name: /note.* on /i })).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByRole("button", { name: /commit/ }).length).toBeGreaterThan(0);
  });

  it("shows MRR, ROAS, ad campaigns and Search Console keywords on the overview", async () => {
    server.use(
      http.get("/api/v1/search-console/status", () =>
        HttpResponse.json({ status: "success", data: { connected: true } }),
      ),
    );
    resetMockState({ signedIn: true });
    const site = state.websites.find((w) => w._id === SITE);
    if (site) site.revenueMetric = "mrr";
    renderApp(`/app/${SITE}/overview`);
    // Headline metric MRR: right after Visitors.
    const mrr = await screen.findByTestId("kpi-mrr");
    expect(mrr).toHaveTextContent(/MRR\s*\$1,247/);
    expect(mrr).toHaveTextContent("43 active subscriptions");
    const tiles = within(screen.getByRole("list", { name: "Key metrics" })).getAllByRole(
      "listitem",
    );
    expect(tiles[1]).toBe(mrr.closest("li"));
    expect(await screen.findByTestId("kpi-roas")).toHaveTextContent(/ROAS\s*2\.80x/);
    expect(screen.getByTestId("kpi-roas")).toHaveTextContent("$500 ad spend");

    const source = screen.getByTestId("card-source");
    await userEvent.click(await within(source).findByRole("tab", { name: "Ads" }));
    const campaign = await within(source).findByRole("button", { name: /^Filter by .*spend/ });
    await userEvent.click(campaign);
    await waitFor(() => expect(search().get("filter_utm_campaign")).toMatch(/^is:\d+$/));

    await userEvent.click(within(source).getByRole("tab", { name: "Keyword" }));
    expect(await within(source).findByText("Est. revenue")).toBeInTheDocument();
    expect(within(source).getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  it("filters commit markers by type (feat:, fix:)", async () => {
    renderSite("overview");
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /commit/ }).length).toBeGreaterThan(0),
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Commit type" }), "fix:");
    await waitFor(() =>
      expect(screen.queryAllByRole("button", { name: /commit/ })).toHaveLength(0),
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Commit type" }), "feat:");
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /commit/ }).length).toBeGreaterThan(0),
    );
    window.localStorage.clear();
  });

  it("filters on row click and shows the filter as a removable chip", async () => {
    renderSite("overview");
    const source = await screen.findByTestId("card-source");
    await userEvent.click(
      await within(source).findByRole("button", { name: /Filter by Organic Search/ }),
    );
    await waitFor(() => expect(search().get("filter_channel")).toBe("is:Organic Search"));
    // Drill-down: the card now lists the sources inside that channel.
    expect(within(source).getByRole("tab", { name: "Referrer" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const chip = screen.getByRole("button", { name: "Remove filter: Channel is Organic Search" });
    await userEvent.click(chip);
    await waitFor(() => expect(search().get("filter_channel")).toBeNull());
  });

  it("sorts the Details list by name or revenue", async () => {
    renderSite("overview");
    const pages = await screen.findByTestId("card-pages");
    await within(pages).findByRole("button", { name: /Filter by \/pricing/ });
    await userEvent.click(within(pages).getByRole("button", { name: /Details/ }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findAllByRole("button", { name: /^Filter by/ });
    const labels = () =>
      within(dialog)
        .getAllByRole("button", { name: /^Filter by/ })
        .map((b) => (b.getAttribute("aria-label") ?? "").replace(/^Filter by /, "").split(":")[0]);
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "Sort by" }),
      "name",
    );
    const byName = labels();
    expect(byName).toEqual([...byName].sort((a, b) => (a ?? "").localeCompare(b ?? "")));
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: "Sort by" }),
      "revenue",
    );
    const revenues = within(dialog)
      .getAllByRole("button", { name: /^Filter by/ })
      .map((b) =>
        Number(
          /\$([\d,.]+) revenue/.exec(b.getAttribute("aria-label") ?? "")?.[1]?.replace(/,/g, "") ??
            0,
        ),
      );
    expect(revenues).toEqual([...revenues].sort((a, b) => b - a));
  });

  it("switches tabs with the keyboard and campaign dimensions with the select", async () => {
    renderSite("overview");
    const source = await screen.findByTestId("card-source");
    const tab = within(source).getByRole("tab", { name: "Channel" });
    tab.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(within(source).getByRole("tab", { name: "Campaign" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      await within(source).findByRole("button", { name: /Filter by google/ }),
    ).toBeInTheDocument();
    await userEvent.selectOptions(
      within(source).getByRole("combobox", { name: "Campaign dimension" }),
      "ref",
    );
    await userEvent.click(
      await within(source).findByRole("button", { name: /Filter by indiehackers/ }),
    );
    await waitFor(() => expect(search().get("filter_ref")).toBe("is:indiehackers"));
  });

  it("opens a metric trend chart with the previous period and toggles comparison", async () => {
    renderSite("overview");
    await userEvent.click(await screen.findByTestId("kpi-bounce_rate"));
    await waitFor(() => expect(search().get("metric")).toBe("bounce_rate"));
    expect(
      await screen.findByRole("slider", { name: /Bounce rate over time/ }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("previous-line")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("kpi-bounce_rate"));
    await waitFor(() => expect(search().get("metric")).toBeNull());
    await userEvent.click(screen.getByTestId("kpi-visitors"));
    expect(
      await screen.findByRole("slider", { name: /New and returning visitors/ }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Compare" }));
    await waitFor(() => expect(search().get("compare")).toBe("true"));
    await waitFor(() => expect(screen.getByTestId("previous-line")).toBeInTheDocument());
    expect(screen.getByTestId("kpi-sessions")).toHaveTextContent(/was /);
  });

  it("switches granularity", async () => {
    renderSite("overview?period=7d");
    await userEvent.click(await screen.findByRole("button", { name: "Hourly" }));
    await waitFor(() => expect(search().get("interval")).toBe("hour"));
    expect(screen.getByRole("button", { name: "Hourly" })).toHaveAttribute("aria-pressed", "true");
  });

  it("adds a note from the chart with the keyboard", async () => {
    renderSite("overview");
    const chart = await screen.findByRole("slider", { name: /Visitors and revenue over time/ });
    chart.focus();
    await userEvent.keyboard("{End}{Enter}");
    const pinned = await screen.findByTestId("chart-pinned-tooltip");
    expect(pinned).toHaveTextContent(/Visitors\s*[\d,]+/);
    expect(pinned).toHaveTextContent("Revenue");
    await userEvent.click(await screen.findByRole("button", { name: "Add note here" }));
    await userEvent.type(screen.getByLabelText("Note"), "Launched the referral program");
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() =>
      expect(
        state.analytics.notes[SITE]?.some((n) => n.text === "Launched the referral program"),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("button", { name: /note/ })
          .some((b) => b.title.includes("referral program")),
      ).toBe(true),
    );
    const marker = screen
      .getAllByRole("button", { name: /note/ })
      .find((b) => b.title.includes("referral program")) as HTMLElement;
    await userEvent.click(marker);
    const dialog = await screen.findByRole("dialog", { name: "Chart notes" });
    expect(dialog).toHaveTextContent("Launched the referral program");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        state.analytics.notes[SITE]?.some((n) => n.text === "Launched the referral program"),
      ).toBe(false),
    );
  });

  it("drills down into a day from the chart", async () => {
    renderSite("overview?period=30d");
    const chart = await screen.findByRole("slider", { name: /Visitors and revenue/ });
    chart.focus();
    await userEvent.keyboard("{Home}{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "View this day" }));
    await waitFor(() => expect(search().get("period")).toBe("custom"));
    expect(search().get("from")).toBe(search().get("to"));
  });

  it("shows an error from the API instead of numbers", async () => {
    server.use(
      http.get("/api/v1/analytics/overview", () =>
        HttpResponse.json(
          { status: "error", error: { code: 400, message: "Invalid timezone" } },
          { status: 400 },
        ),
      ),
    );
    renderSite("overview");
    expect(await screen.findByText("Invalid timezone")).toBeInTheDocument();
  });

  it("opens the live map with M", async () => {
    renderSite("overview");
    await screen.findByTestId("kpi-visitors");
    await userEvent.keyboard("m");
    expect(await screen.findByRole("heading", { name: /Realtime/, level: 1 })).toBeInTheDocument();
  });
});

describe("period selector", () => {
  it("selects presets, keeps the period in the URL and hops back and forward", async () => {
    renderSite("overview");
    const trigger = await screen.findByRole("button", { name: "Period: Last 30 days" });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: /^Last 7 days/ }));
    await waitFor(() => expect(search().get("period")).toBe("7d"));
    expect(screen.getByTestId("period-label")).toHaveTextContent("Last 7 days");
    expect(screen.getByRole("button", { name: "Next period" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Previous period" }));
    await waitFor(() => expect(search().get("period")).toBe("custom"));
    expect(search().get("from")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByRole("button", { name: "Next period" })).toBeEnabled();
  });

  it("supports keyboard shortcuts, Now and a custom range", async () => {
    renderSite("overview");
    await screen.findByTestId("kpi-visitors");
    await userEvent.keyboard("t");
    await waitFor(() => expect(search().get("period")).toBe("today"));
    // DataFast's mapping: D is the last 24 hours, 3 the last 30 days.
    await userEvent.keyboard("d");
    await waitFor(() => expect(search().get("period")).toBe("24h"));
    await userEvent.keyboard("3");
    await waitFor(() => expect(search().get("period")).toBe("30d"));
    await userEvent.keyboard("w");
    await waitFor(() => expect(search().get("period")).toBe("7d"));
    await userEvent.keyboard("n");
    await waitFor(() => expect(search().get("period")).toBe("now"));
    expect(await screen.findByRole("button", { name: "Minutely" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Period:/ }));
    await userEvent.click(screen.getByRole("button", { name: "Custom range…" }));
    const from = screen.getByLabelText("From");
    await userEvent.clear(from);
    await userEvent.type(from, "2026-10-01");
    const to = screen.getByLabelText("To");
    await userEvent.clear(to);
    await userEvent.type(to, "2026-10-15");
    await userEvent.click(screen.getByRole("button", { name: "Apply range" }));
    await waitFor(() => expect(search().get("from")).toBe("2026-10-01"));
    expect(search().get("to")).toBe("2026-10-15");
    expect(screen.getByTestId("period-label")).toHaveTextContent("Oct 1 – Oct 15, 2026");
  });

  it("pins favourite periods per website", async () => {
    renderSite("overview");
    await userEvent.click(await screen.findByRole("button", { name: /^Period:/ }));
    expect(screen.queryByRole("list", { name: "More periods" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More periods" }));
    const more = screen.getByRole("list", { name: "More periods" });
    await userEvent.click(within(more).getByRole("button", { name: "Pin Last 3 months" }));
    expect(
      within(screen.getByRole("list", { name: "Pinned periods" })).getByRole("button", {
        name: /^Last 3 months/,
      }),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem(`dg:pinned-periods:site:${SITE}`)).toContain("90d");
    window.localStorage.clear();
  });
});

describe("filters and segments", () => {
  it("builds combined filters with operators, saves a segment and applies one", async () => {
    renderSite("overview");
    await userEvent.click(await screen.findByRole("button", { name: "Filter" }));
    let dialog = await screen.findByRole("dialog", { name: "Filters" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Dimension"), "country");
    await userEvent.selectOptions(within(dialog).getByLabelText("Operator"), "is_not");
    await userEvent.type(within(dialog).getByLabelText(/^Value/), "FR, DE");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add filter" }));
    await waitFor(() => expect(search().get("filter_country")).toBe("is_not:FR,DE"));

    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    dialog = await screen.findByRole("dialog", { name: "Filters" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Dimension"), "visit_count");
    expect(within(dialog).getByLabelText("Operator")).toHaveDisplayValue("at least");
    await userEvent.type(within(dialog).getByLabelText(/^Value/), "two");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add filter" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("whole number");
    await userEvent.clear(within(dialog).getByLabelText(/^Value/));
    await userEvent.type(within(dialog).getByLabelText(/^Value/), "2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add filter" }));
    await waitFor(() => expect(search().get("filter_visit_count")).toBe("gte:2"));
    expect(
      screen.getByRole("button", { name: "Edit filter: Visit count at least 2" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Filter" }));
    dialog = await screen.findByRole("dialog", { name: "Filters" });
    await userEvent.type(within(dialog).getByLabelText("Segment name"), "Returning non-EU");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save as segment" }));
    await waitFor(() =>
      expect(
        state.analytics.segments[SITE]?.find((s) => s.name === "Returning non-EU")?.filters,
      ).toEqual({
        filter_country: "is_not:FR,DE",
        filter_visit_count: "gte:2",
      }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: /^Customers from USA/ }));
    await waitFor(() => expect(search().get("filter_goal")).toBe("is:payment"));
    expect(search().get("filter_country")).toBe("is:US");
    expect(search().get("filter_visit_count")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(search().get("filter_goal")).toBeNull());
  });

  it("edits an existing filter from its chip", async () => {
    renderSite("overview?filter_referrer=is:Google");
    await userEvent.click(
      await screen.findByRole("button", { name: "Edit filter: Referrer is Google" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Edit filter" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Operator"), "contains");
    await userEvent.click(within(dialog).getByRole("button", { name: "Update filter" }));
    await waitFor(() => expect(search().get("filter_referrer")).toBe("contains:Google"));
  });
});

describe("public shared dashboard", () => {
  it("renders the overview read-only without sign-in and hides revenue unless shared", async () => {
    resetMockState({ signedIn: false });
    renderApp("/share/share_demo_token_000000");
    expect(
      await screen.findByRole("heading", { name: "Example SaaS", level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("kpi-visitors")).toHaveTextContent(/\d/);
    expect(screen.queryByTestId("kpi-revenue")).not.toBeInTheDocument();
    expect(screen.queryByTestId("kpi-live")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Chart markers" })).not.toBeInTheDocument();
    const source = await screen.findByTestId("card-source");
    await userEvent.click(
      await within(source).findByRole("button", { name: /Filter by Direct/ }, { timeout: 4000 }),
    );
    await waitFor(() => expect(search().get("filter_channel")).toBe("is:Direct"));
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("shows revenue when the owner shares it", async () => {
    resetMockState({ signedIn: false });
    const w = state.websites[0];
    if (w) w.isPublicDataEnabled = true;
    renderApp("/share/share_demo_token_000000");
    expect(await screen.findByTestId("kpi-revenue")).toHaveTextContent("$");
  });

  it("shows the live visitor map without names, journeys or (unshared) payments", async () => {
    resetMockState({ signedIn: false });
    renderApp("/share/share_demo_token_000000");
    await screen.findByTestId("kpi-visitors");
    await userEvent.click(screen.getByRole("button", { name: "Live map" }));
    const live = await screen.findByTestId("live-count");
    await waitFor(() => expect(live).toHaveTextContent(/\d+ visitors? online/));
    expect(screen.queryByRole("tab", { name: "Payments" })).not.toBeInTheDocument();
    const list = await screen.findByRole("tab", { name: /^Visitors \(\d+\)/ });
    expect(list).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open visitor journey/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(await screen.findByTestId("kpi-visitors")).toBeInTheDocument();
  });

  it("explains an invalid link", async () => {
    resetMockState({ signedIn: false });
    renderApp("/share/nope");
    expect(
      await screen.findByRole("heading", { name: "Dashboard not available" }),
    ).toBeInTheDocument();
  });
});
