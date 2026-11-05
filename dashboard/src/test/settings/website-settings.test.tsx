import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { server } from "../../mocks/node";
import { resetMockState, state } from "../../mocks/state";
import { renderApp } from "../render";
import { openPage, recordRequests, SITE, SITE2, site, writes } from "./helpers";

afterEach(() => server.events.removeAllListeners());

const card = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest("section") as HTMLElement;

describe("tracking & privacy", () => {
  it("switches to cookieless mode and shows the script to install", async () => {
    openPage(`/app/${SITE}/settings/tracking`);
    const privacy = await card("Privacy mode");
    expect(within(privacy).getByRole("radio", { name: /Cookies \(default\)/ })).toBeChecked();
    await userEvent.click(within(privacy).getByRole("radio", { name: /^Cookieless/ }));
    expect(within(privacy).getByRole("figure", { name: "updated snippet" })).toHaveTextContent(
      "script.cookieless.js",
    );
    expect(
      within(privacy).getByText(/revenue attribution and multi-day journeys less/),
    ).toBeVisible();
    await userEvent.click(within(privacy).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(site().privacyMode).toBe("cookieless"));
    expect(await within(privacy).findByText("Saved")).toBeInTheDocument();
  });

  it("toggles Global Privacy Control and sets the bot filter level", async () => {
    openPage(`/app/${SITE}/settings/tracking`);
    const gpc = await screen.findByRole("switch", { name: "Honor Global Privacy Control" });
    await userEvent.click(gpc);
    await waitFor(() => expect(site().honorGpc).toBe(false));
    const bots = await card("Bot filtering");
    await userEvent.click(within(bots).getByRole("radio", { name: /Strict \(attack mode\)/ }));
    await userEvent.click(within(bots).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(site().botLevel).toBe("strict"));
  });

  it("turns DataFast compatibility on and off", async () => {
    openPage(`/app/${SITE}/settings/tracking`);
    const compat = await screen.findByRole("switch", { name: "DataFast compatibility" });
    expect(compat).not.toBeChecked();
    expect(
      screen.getByText(/Turns on by itself when visitors arrive with DataFast's cookie/),
    ).toBeInTheDocument();
    await userEvent.click(compat);
    await waitFor(() => expect(site().datafastCompat).toBe(true));
  });

  it("edits allowed hostnames with validation", async () => {
    const log = recordRequests();
    openPage(`/app/${SITE}/settings/tracking`);
    const hosts = await card("Allowed hostnames");
    const input = within(hosts).getByRole("textbox", { name: "Allowed hostnames" });
    await userEvent.type(input, "not_a_host{Enter}");
    expect(within(hosts).getByRole("alert")).toHaveTextContent("is not a valid hostname");
    await userEvent.clear(input);
    await userEvent.type(input, "https://Shop.Example.org/cart{Enter}");
    expect(within(hosts).getByRole("list", { name: "Allowed hostnames" })).toHaveTextContent(
      "shop.example.org",
    );
    await userEvent.click(within(hosts).getByRole("button", { name: "Remove app.example.com" }));
    await userEvent.click(within(hosts).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(site().allowedHostnames).toEqual(["shop.example.org"]));
    expect(writes(log, "PUT", "/websites/")[0]?.body).toEqual({
      allowedHostnames: ["shop.example.org"],
      isAllHostnamesAllowed: false,
    });
  });

  it("shows the server's validation error", async () => {
    server.use(
      http.put("/api/v1/admin/websites/:id", () =>
        HttpResponse.json(
          { status: "error", error: { code: 400, message: "botLevel: invalid option" } },
          { status: 400 },
        ),
      ),
    );
    openPage(`/app/${SITE}/settings/tracking`);
    const bots = await card("Bot filtering");
    await userEvent.click(within(bots).getByRole("radio", { name: /^Off/ }));
    await userEvent.click(within(bots).getByRole("button", { name: "Save" }));
    expect(await within(bots).findByText("botLevel: invalid option")).toBeInTheDocument();
  });

  it("is read-only for viewers", async () => {
    openPage(`/app/${SITE}/settings/tracking`, { role: "viewer" });
    const privacy = await card("Privacy mode");
    expect(within(privacy).getByRole("radio", { name: /^Cookieless/ })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Honor Global Privacy Control" })).toBeDisabled();
    expect(screen.queryByRole("textbox", { name: "Allowed hostnames" })).not.toBeInTheDocument();
  });
});

describe("exclusions", () => {
  it("adds IPs (including the current one), validates and saves", async () => {
    openPage(`/app/${SITE}/settings/exclusions`);
    const ips = await card("IP addresses");
    const input = within(ips).getByRole("textbox", { name: "Excluded ip addresses" });
    await userEvent.type(input, "999.1.1.1{Enter}");
    expect(within(ips).getByRole("alert")).toHaveTextContent("not an IP address or CIDR range");
    await userEvent.clear(input);
    await userEvent.type(input, "10.0.0.0/8, 2001:db8::/32{Enter}");
    await userEvent.click(within(ips).getByRole("button", { name: "Add my current IP" }));
    expect(await within(ips).findByText("Added 203.0.113.9. Save to apply.")).toBeInTheDocument();
    await userEvent.click(within(ips).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(site().excludedIps).toEqual(["10.0.0.0/8", "2001:db8::/32", "203.0.113.9"]),
    );
  });

  it("explains when the current IP cannot be detected", async () => {
    server.use(http.get("/cdn-cgi/trace", () => new HttpResponse(null, { status: 404 })));
    openPage(`/app/${SITE}/settings/exclusions`);
    const ips = await card("IP addresses");
    await userEvent.click(within(ips).getByRole("button", { name: "Add my current IP" }));
    expect(await within(ips).findByText(/Could not detect your IP/)).toBeInTheDocument();
  });

  it("edits paths with wildcards and requires a leading slash", async () => {
    openPage(`/app/${SITE}/settings/exclusions`);
    const pages = await card("Pages");
    expect(within(pages).getByRole("list", { name: "Excluded pages" })).toHaveTextContent(
      "/admin/*",
    );
    const input = within(pages).getByRole("textbox", { name: "Excluded pages" });
    await userEvent.type(input, "app/*{Enter}");
    expect(within(pages).getByRole("alert")).toHaveTextContent("Paths start with /.");
    await userEvent.clear(input);
    await userEvent.type(input, "/app/*{Enter}");
    await userEvent.click(within(pages).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(site().excludedPaths).toEqual(["/admin/*", "/app/*"]));
  });

  it("excludes countries by name and stores ISO codes", async () => {
    openPage(`/app/${SITE}/settings/exclusions`);
    const countries = await card("Countries");
    await userEvent.selectOptions(
      within(countries).getByRole("combobox", { name: "Country to exclude" }),
      "FR",
    );
    await userEvent.click(within(countries).getByRole("button", { name: "Add" }));
    expect(within(countries).getByRole("list", { name: "Excluded countries" })).toHaveTextContent(
      "France",
    );
    await userEvent.click(within(countries).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(site().excludedCountries).toEqual(["FR"]));
  });

  it("excludes hostnames and shows how to exclude your own browser", async () => {
    openPage(`/app/${SITE}/settings/exclusions`);
    const hosts = await card("Hostnames");
    await userEvent.type(
      within(hosts).getByRole("textbox", { name: "Excluded hostnames" }),
      "staging.example.com{Enter}",
    );
    await userEvent.click(within(hosts).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(site().excludedHostnames).toEqual(["staging.example.com"]));
    expect(screen.getByRole("figure", { name: "ignore command" })).toHaveTextContent(
      "localStorage.datagoat_ignore = 'true'",
    );
    expect(screen.queryByRole("heading", { name: "User agents" })).not.toBeInTheDocument();
  });

  it("shows user-agent exclusions when the server supports them", async () => {
    resetMockState({ signedIn: true });
    const w = state.websites[0];
    if (w) w.excludedUserAgents = [];
    renderApp(`/app/${SITE}/settings/exclusions`);
    const agents = await card("User agents");
    await userEvent.type(
      within(agents).getByRole("textbox", { name: "Excluded user agents" }),
      "Uptime Robot{Enter}",
    );
    await userEvent.click(within(agents).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(site().excludedUserAgents).toEqual(["Uptime Robot"]));
  });
});

describe("attribution & revenue", () => {
  it("changes the attribution model and revenue options", async () => {
    const log = recordRequests();
    openPage(`/app/${SITE}/settings/attribution`);
    const model = await card("Attribution model");
    await userEvent.click(within(model).getByRole("radio", { name: /Last non-direct touch/ }));
    await userEvent.click(within(model).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(site().attributionModel).toBe("last_non_direct"));

    const revenue = await card("Revenue");
    await userEvent.click(within(revenue).getByRole("switch", { name: "Include renewal revenue" }));
    await userEvent.selectOptions(within(revenue).getByLabelText("Headline revenue metric"), "mrr");
    await userEvent.click(within(revenue).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(site().includeRenewalRevenue).toBe(false));
    expect(writes(log, "PUT", "/websites/").at(-1)?.body).toEqual({
      includeRenewalRevenue: false,
      revenueMetric: "mrr",
    });
    expect(await within(revenue).findByText("Saved")).toBeInTheDocument();
  });
});

describe("danger zone", () => {
  it("deletes the website only after typing its domain", async () => {
    openPage(`/app/${SITE}/settings/danger`);
    await userEvent.click(await screen.findByRole("button", { name: "Delete example.com" }));
    const dialog = screen.getByRole("dialog", { name: "Delete example.com?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete website" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox"), "example.co");
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox"), "m");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(state.websites.map((w) => w._id)).not.toContain(SITE));
    await waitFor(() => expect(window.location.pathname).toBe(`/app/${SITE2}/overview`));
  });

  it("closes with Escape and keeps focus inside while open", async () => {
    openPage(`/app/${SITE}/settings/danger`);
    const open = await screen.findByRole("button", { name: "Delete example.com" });
    await userEvent.click(open);
    const dialog = screen.getByRole("dialog");
    for (let i = 0; i < 6; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it("is owner-only", async () => {
    openPage(`/app/${SITE2}/settings/danger`);
    expect(
      await screen.findByText("Only an owner of this website can delete it."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
  });
});
