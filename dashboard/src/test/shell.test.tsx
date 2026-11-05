import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { isActive } from "../components/AppShell";
import { type Command, filterCommands } from "../components/CommandMenu";
import { server } from "../mocks/node";
import { resetMockState } from "../mocks/state";
import { type NavItem, SITE_PAGES } from "../nav";
import { renderApp } from "./render";

const SITE = "6728f0a0a1b2c3d4e5f6a001";
const open = (path: string) => {
  resetMockState({ signedIn: true });
  return renderApp(`/app/${SITE}/${path}`);
};
const nav = () => screen.getByRole("navigation", { name: "Main" });

describe("sidebar", () => {
  it("opens the group of the current page and marks the page", async () => {
    open("settings/tracking");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    const settings = within(nav()).getByRole("button", { name: "Settings" });
    expect(settings).toHaveAttribute("aria-expanded", "true");
    // Every settings tab highlights General.
    expect(within(nav()).getByRole("link", { name: "General" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav()).getByRole("button", { name: "Developers" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await userEvent.click(within(nav()).getByRole("link", { name: "Team" }));
    expect(await screen.findByRole("heading", { name: "Team", level: 1 })).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Team" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("shows how many visitors are online next to Realtime", async () => {
    server.use(
      http.get("/api/v1/analytics/realtime", () =>
        HttpResponse.json({ status: "success", data: [{ visitors: 7 }] }),
      ),
    );
    open("goals");
    const realtime = within(await screen.findByRole("navigation", { name: "Main" })).getByRole(
      "link",
      {
        name: /Realtime/,
      },
    );
    await waitFor(() => expect(realtime).toHaveTextContent("Visitors online: 7"));
  });

  it("switches websites and reaches All websites from the switcher", async () => {
    open("overview");
    const switcher = await screen.findByRole("combobox", { name: "Website" });
    expect(within(switcher).getByRole("option", { name: "All websites" })).toBeInTheDocument();
    expect(within(switcher).getByRole("option", { name: "+ Add website" })).toBeInTheDocument();
    await userEvent.selectOptions(switcher, "__all");
    expect(await screen.findByRole("heading", { name: "Websites", level: 1 })).toBeInTheDocument();
  });

  it("keeps Account, theme and Sign out in the account menu", async () => {
    open("overview");
    const button = await screen.findByRole("button", {
      name: /Account menu for demo@datagoat\.dev/,
    });
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Account" })).toHaveAttribute("href", "/app/account");
    expect(screen.getByRole("button", { name: /^Theme: / })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    await userEvent.click(button);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
  });
});

describe("search or jump to (⌘K)", () => {
  it("opens with Ctrl+K, filters, moves with the arrows and opens with Enter", async () => {
    open("overview");
    await screen.findByRole("heading", { name: "Overview" });
    await userEvent.keyboard("{Control>}k{/Control}");
    const dialog = screen.getByRole("dialog", { name: "Search or jump to" });
    const input = within(dialog).getByRole("combobox", { name: "Search pages and websites" });
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.type(input, "api");
    const options = within(dialog).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["API keys", "API playground"]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}");
    expect(within(dialog).getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[1]?.id);
    await userEvent.keyboard("{Enter}");
    expect(
      await screen.findByRole("heading", { name: "API playground", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Search or jump to" })).not.toBeInTheDocument();
    // Arriving through search opens the page's sidebar group too.
    expect(within(nav()).getByRole("button", { name: "Developers" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("opens from the sidebar, says when nothing matches and closes on Escape", async () => {
    open("overview");
    await screen.findByRole("heading", { name: "Overview" });
    await userEvent.click(within(nav()).getByRole("button", { name: /^Search/ }));
    const dialog = screen.getByRole("dialog", { name: "Search or jump to" });
    await userEvent.type(within(dialog).getByRole("combobox"), "zzz");
    expect(within(dialog).getByText("No matches for “zzz”.")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Search or jump to" })).not.toBeInTheDocument();
  });

  it("matches every word against the label and the section", () => {
    const cmd = (label: string, section: string): Command => ({
      id: label,
      label,
      section,
      icon: "page",
      run: () => undefined,
    });
    const all = [cmd("API keys", "Developers"), cmd("Team", "Settings"), cmd("Goals", "Pages")];
    expect(filterCommands(all, "").map((c) => c.label)).toEqual(["API keys", "Team", "Goals"]);
    expect(filterCommands(all, "settings").map((c) => c.label)).toEqual(["Team"]);
    expect(filterCommands(all, "dev KEY").map((c) => c.label)).toEqual(["API keys"]);
  });
});

it("treats sub-pages as part of their sidebar entry", () => {
  const page = (path: string) => SITE_PAGES.find((p) => p.path === path) as NavItem;
  const base = `/app/${SITE}`;
  expect(isActive(`${base}/visitors/v123`, SITE, page("visitors"))).toBe(true);
  expect(isActive(`${base}/settings/danger`, SITE, page("settings/general"))).toBe(true);
  expect(isActive(`${base}/goals`, SITE, page("funnels"))).toBe(false);
});
