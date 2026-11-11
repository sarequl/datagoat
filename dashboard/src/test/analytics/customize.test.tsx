import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { applyLayout, fullWidth, orderBy } from "../../analytics/layout";
import { resetMockState, state } from "../../mocks/state";
import { renderApp } from "../render";
import { renderSite, SITE } from "./helpers";

const cardOrder = () =>
  [...document.querySelectorAll("[data-card]")].map((e) => e.getAttribute("data-card"));
const sectionOrder = () =>
  [...document.querySelectorAll("[data-testid^=section-]")].map((e) =>
    e.getAttribute("data-testid")?.replace("section-", ""),
  );

describe("customize the overview", () => {
  it("reorders cards and sections, hides a card, and saves only on Done", async () => {
    renderSite("overview");
    await screen.findByTestId("card-source");
    expect(cardOrder().slice(0, 4)).toEqual(["source", "pages", "location", "system"]);
    await userEvent.click(screen.getByRole("button", { name: "Customize" }));
    const toolbar = screen.getByRole("toolbar", { name: "Customize Overview" });

    await userEvent.click(screen.getByRole("button", { name: "Move Pages up" }));
    await userEvent.click(screen.getByRole("button", { name: "Move the Growth section up" }));
    await userEvent.click(screen.getByRole("button", { name: "Hide System" }));
    expect(cardOrder().slice(0, 4)).toEqual(["pages", "source", "location", "system"]);
    // Nothing is saved while editing.
    expect(state.overviewLayouts[SITE]).toBeUndefined();
    // The first item cannot move further up.
    expect(screen.getByRole("button", { name: "Move Pages up" })).toBeDisabled();

    await userEvent.click(within(toolbar).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(state.overviewLayouts[SITE]).toBeTruthy());
    const saved = state.overviewLayouts[SITE];
    expect(saved?.cards.breakdowns).toEqual(["pages", "source", "location", "system"]);
    expect(saved?.sections).toEqual(["breakdowns", "conversions", "growth", "live"]);
    expect(saved?.hidden).toEqual(["system"]);
    expect(sectionOrder()).toEqual(["breakdowns", "conversions", "growth", "live"]);
    expect(screen.queryByTestId("card-system")).not.toBeInTheDocument();
    expect(screen.getByText(/1 hidden card/)).toBeInTheDocument();
  });

  it("drops changes on Cancel and goes back to the default with Reset", async () => {
    resetMockState({
      signedIn: true,
      overviewLayouts: {
        [SITE]: {
          sections: ["growth", "breakdowns", "conversions", "live"],
          cards: {},
          hidden: ["funnel"],
        },
      },
    });
    renderApp(`/app/${SITE}/overview`);
    await screen.findByTestId("card-source");
    await waitFor(() => expect(sectionOrder()[0]).toBe("growth"));

    await userEvent.click(screen.getByRole("button", { name: "Customize" }));
    await userEvent.click(screen.getByRole("button", { name: "Move the Breakdowns section up" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(sectionOrder()[0]).toBe("growth");

    await userEvent.click(screen.getByRole("button", { name: "Customize" }));
    await userEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(state.overviewLayouts[SITE]).toBeNull());
    expect(sectionOrder()).toEqual(["breakdowns", "conversions", "live", "growth"]);
    expect(await screen.findByTestId("hub-funnel")).toBeInTheDocument();
  });

  it("orders by the saved layout, keeps new cards at their default place and sizes rows", () => {
    const items = ["a", "b", "c", "d"].map((id) => ({ id }));
    // Known ids in the saved order; a card the layout does not know returns to its default index.
    expect(orderBy(items, ["c", "a", "gone"]).map((i) => i.id)).toEqual(["c", "b", "a", "d"]);
    expect(orderBy(items, undefined)).toBe(items);
    const sections = applyLayout(
      [
        {
          id: "x",
          cards: [
            { id: "1", label: "1", node: null },
            { id: "2", label: "2", node: null },
          ],
        },
        { id: "y", cards: [] },
      ],
      { sections: ["y", "x"], cards: { x: ["2", "1"] }, hidden: [] },
    );
    expect(sections.map((s) => s.id)).toEqual(["y", "x"]);
    expect(sections[1]?.cards.map((c) => c.id)).toEqual(["2", "1"]);
    // Two per row; a card left alone, or before a full-width card, stretches.
    expect([...fullWidth([{ id: "a" }, { id: "b" }, { id: "c" }])]).toEqual(["c"]);
    expect([
      ...fullWidth([{ id: "a" }, { id: "h", full: true }, { id: "b" }, { id: "c" }]),
    ]).toEqual(["a", "h"]);
  });
});
