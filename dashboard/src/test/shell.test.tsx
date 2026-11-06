import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { isActive, topLinkFor } from "../components/AppShell";
import { type Command, filterCommands } from "../components/CommandMenu";
import { server } from "../mocks/node";
import { resetMockState } from "../mocks/state";
import { inSettings, type NavItem, SETTINGS_MENU, SITE_PAGES } from "../nav";
import { renderApp } from "./render";

const SITE = "6728f0a0a1b2c3d4e5f6a001";
const open = (path: string) => {
  resetMockState({ signedIn: true });
  return renderApp(`/app/${SITE}/${path}`);
};
const nav = () => screen.getByRole("navigation", { name: "Main" });

describe("top bar and settings menu", () => {
  it("marks the section of the current page and lists Settings in its own menu", async () => {
    open("settings/tracking");
    expect(
      await screen.findByRole("heading", { name: "Tracking & privacy", level: 1 }),
    ).toBeInTheDocument();
    const settings = within(nav()).getByRole("link", { name: "Settings" });
    expect(settings).toHaveAttribute("data-active");
    expect(settings).not.toHaveAttribute("aria-current");
    const menu = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(menu).getByRole("link", { name: "Tracking & privacy" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Integrations, developer pages and the rest of the old sidebar live in the Settings menu.
    for (const label of ["Integrations", "API keys", "AI assistants (MCP)", "Team", "Usage & data"])
      expect(within(menu).getByRole("link", { name: label })).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("link", { name: "Team" }));
    expect(await screen.findByRole("heading", { name: "Team", level: 1 })).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("link", {
        name: "Team",
      }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("files analytics pages under Overview with a way back", async () => {
    open("goals");
    expect(await screen.findByRole("heading", { name: "Goals", level: 1 })).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Overview" })).toHaveAttribute("data-active");
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("main")).getByRole("link", { name: "Overview" }));
    expect(await screen.findByRole("heading", { name: "Overview", level: 1 })).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Overview" })).toHaveAttribute(
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
    // Arriving through search marks the page in the Settings menu too.
    expect(
      within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("link", {
        name: "API playground",
      }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("opens from the top bar, says when nothing matches and closes on Escape", async () => {
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

it("treats sub-pages as part of their entry and files pages under a top-bar link", () => {
  const page = (path: string) => SITE_PAGES.find((p) => p.path === path) as NavItem;
  const base = `/app/${SITE}`;
  expect(isActive(`${base}/visitors/v123`, SITE, page("visitors"))).toBe(true);
  expect(isActive(`${base}/goals`, SITE, page("funnels"))).toBe(false);
  expect(topLinkFor(`${base}/visitors/v123`, SITE)).toBe("visitors");
  expect(topLinkFor(`${base}/funnels/f1`, SITE)).toBe("overview");
  expect(topLinkFor(`${base}/mentions`, SITE)).toBe("overview");
  expect(topLinkFor(`${base}/keys`, SITE)).toBe("settings/general");
  expect(topLinkFor(`${base}/settings/danger`, SITE)).toBe("settings/general");
});

it("puts every Integrations, Developers and Settings page in the Settings menu once", () => {
  const menu = SETTINGS_MENU.flatMap((g) => g.paths);
  expect(new Set(menu).size).toBe(menu.length);
  const settingsPages = SITE_PAGES.filter(inSettings).map((p) => p.path);
  expect([...menu].sort()).toEqual([...settingsPages].sort());
});
