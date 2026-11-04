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
    expect(await screen.findByTestId("kpi-live")).toHaveTextContent(/Visitors now\s*\d+/);
    expect(
      await screen.findByRole("slider", { name: /Visitors and revenue over time/ }),
    ).toBeInTheDocument();
    const source = screen.getByTestId("card-source");
    expect(
      await within(source).findByRole("button", { name: /Filter by Organic Search/ }),
    ).toBeInTheDocument();
    expect(within(source).getByRole("tab", { name: "Channel" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
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

  it("filters on row click and shows the filter as a removable chip", async () => {
    renderSite("overview");
    const source = await screen.findByTestId("card-source");
    await userEvent.click(
      await within(source).findByRole("button", { name: /Filter by Organic Search/ }),
    );
    await waitFor(() => expect(search().get("filter_channel")).toBe("is:Organic Search"));
    const chip = screen.getByRole("button", { name: "Remove filter: Channel is Organic Search" });
    await userEvent.click(chip);
    await waitFor(() => expect(search().get("filter_channel")).toBeNull());
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

  it("explains an invalid link", async () => {
    resetMockState({ signedIn: false });
    renderApp("/share/nope");
    expect(
      await screen.findByRole("heading", { name: "Dashboard not available" }),
    ).toBeInTheDocument();
  });
});
