import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { usage } from "../../mocks/fixtures/analytics";
import { server } from "../../mocks/node";
import { state } from "../../mocks/state";
import { openPage, recordRequests, SITE, SITE2, site, writes } from "./helpers";

afterEach(() => server.events.removeAllListeners());

const card = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest("section") as HTMLElement;

describe("share link", () => {
  it("copies, rotates and turns off the public link, and toggles revenue", async () => {
    openPage(`/app/${SITE}/share`);
    const link = await screen.findByRole("textbox", { name: "Share link" });
    expect(link).toHaveValue(`${window.location.origin}/share/share_demo_token_000000`);
    expect(screen.getByRole("button", { name: "Copy Share link" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open public dashboard" })).toHaveAttribute(
      "href",
      `${window.location.origin}/share/share_demo_token_000000`,
    );

    await userEvent.click(screen.getByRole("switch", { name: "Show revenue" }));
    await waitFor(() => expect(site().isPublicDataEnabled).toBe(true));

    await userEvent.click(screen.getByRole("button", { name: "Create a new link" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Create new link" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Share link" })).not.toHaveValue(
        `${window.location.origin}/share/share_demo_token_000000`,
      ),
    );
    expect(site().shareToken).toMatch(/^share_/);

    await userEvent.click(screen.getByRole("button", { name: "Turn off sharing" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Turn off" }),
    );
    expect(await screen.findByText(/Sharing is off/)).toBeInTheDocument();
    expect(site().shareToken).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Create share link" }));
    expect(await screen.findByRole("textbox", { name: "Share link" })).toBeInTheDocument();
  });

  it("shows the link read-only to viewers", async () => {
    openPage(`/app/${SITE}/share`, { role: "viewer" });
    expect(await screen.findByRole("textbox", { name: "Share link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Turn off sharing" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Show revenue" })).toBeDisabled();
  });
});

describe("usage & data", () => {
  it("shows events and database usage against the Cloudflare limits", async () => {
    openPage(`/app/${SITE}/usage`);
    const db = await screen.findByRole("progressbar", { name: "D1 database size" });
    expect(db).toHaveAttribute("aria-valuenow", "17");
    expect(screen.getByText("86.0 MB of 500 MB")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Database rows written" })).toHaveAttribute(
      "aria-valuenow",
      "22",
    );
    expect(
      screen.getByRole("progressbar", { name: "Tracked events (Worker requests)" }),
    ).toHaveAttribute("aria-valuenow", "5");
    expect(screen.getByText("412,000")).toBeInTheDocument();
    expect(screen.queryByText(/The database is \d+% full/)).not.toBeInTheDocument();
  });

  it("warns when the database is filling up", async () => {
    server.use(
      http.get("/api/v1/admin/websites/:id/usage", () =>
        HttpResponse.json({
          status: "success",
          data: { ...usage, databaseSizeBytes: 400_000_000, databasePercentUsed: 80 },
        }),
      ),
    );
    openPage(`/app/${SITE}/usage`);
    expect(await screen.findByText(/The database is 80% full/)).toBeInTheDocument();
  });

  it("sets data retention with a confirmation when it deletes data", async () => {
    const log = recordRequests();
    openPage(`/app/${SITE}/usage`);
    const retention = await card("Data retention");
    await userEvent.selectOptions(
      within(retention).getByLabelText("Keep raw events for"),
      "custom",
    );
    const days = within(retention).getByLabelText("Days");
    await userEvent.type(days, "10");
    await userEvent.click(within(retention).getByRole("button", { name: "Save" }));
    expect(within(retention).getByRole("alert")).toHaveTextContent("between 30 and 36500");
    await userEvent.clear(days);
    await userEvent.type(days, "45");
    await userEvent.click(within(retention).getByRole("button", { name: "Save" }));
    const dialog = screen.getByRole("dialog", { name: "Keep only 45 days of events?" });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save and delete older events" }),
    );
    await waitFor(() => expect(site().retentionDays).toBe(45));
    expect(writes(log, "PUT", "/websites/")[0]?.body).toEqual({ retentionDays: 45 });
  });

  it("keeps everything again without a confirmation", async () => {
    openPage(`/app/${SITE2}/usage`);
    const retention = await card("Data retention");
    const select = within(retention).getByLabelText("Keep raw events for");
    expect(select).toHaveValue("365");
    await userEvent.selectOptions(select, "");
    await userEvent.click(within(retention).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(site(SITE2).retentionDays).toBeNull());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("account", () => {
  it("updates the profile name", async () => {
    openPage("/app/account");
    const profile = await card("Profile");
    const name = within(profile).getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Goat Herder");
    await userEvent.click(within(profile).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(state.user.name).toBe("Goat Herder"));
    expect(within(profile).getByLabelText("Email")).toHaveValue("demo@datagoat.dev");
  });

  it("checks and changes the password", async () => {
    openPage("/app/account");
    const pw = await card("Password");
    await userEvent.type(within(pw).getByLabelText("Current password"), "demo-password");
    await userEvent.type(within(pw).getByLabelText("New password"), "a-new-password");
    await userEvent.type(within(pw).getByLabelText("Repeat new password"), "a-new-passwort");
    await userEvent.click(within(pw).getByRole("button", { name: "Change password" }));
    expect(within(pw).getByRole("alert")).toHaveTextContent("do not match");
    await userEvent.clear(within(pw).getByLabelText("Repeat new password"));
    await userEvent.type(within(pw).getByLabelText("Repeat new password"), "a-new-password");
    await userEvent.click(within(pw).getByRole("button", { name: "Change password" }));
    expect(
      await within(pw).findByText("Password changed. Other sessions were signed out."),
    ).toBeInTheDocument();
    expect(within(pw).getByLabelText("Current password")).toHaveValue("");
  });

  it("shows a wrong current password", async () => {
    server.use(
      http.put("/api/auth/password", () =>
        HttpResponse.json(
          { status: "error", error: { code: 400, message: "Current password is incorrect" } },
          { status: 400 },
        ),
      ),
    );
    openPage("/app/account");
    const pw = await card("Password");
    await userEvent.type(within(pw).getByLabelText("Current password"), "wrong");
    await userEvent.type(within(pw).getByLabelText("New password"), "a-new-password");
    await userEvent.type(within(pw).getByLabelText("Repeat new password"), "a-new-password");
    await userEvent.click(within(pw).getByRole("button", { name: "Change password" }));
    expect(await within(pw).findByRole("alert")).toHaveTextContent("Current password is incorrect");
  });

  it("signs out everywhere", async () => {
    const log = recordRequests();
    openPage("/app/account");
    await userEvent.click(await screen.findByRole("button", { name: "Sign out everywhere" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Sign out everywhere" }),
    );
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(writes(log, "POST", "/api/auth/logout-all")).toHaveLength(1);
    expect(state.signedIn).toBe(false);
  });

  it("lists websites and revokes a connected AI app", async () => {
    openPage("/app/account");
    const sites = await card("Your websites");
    expect(within(sites).getByText("Example SaaS")).toBeInTheDocument();
    expect(within(sites).getAllByRole("link", { name: "Tokens" })[0]).toHaveAttribute(
      "href",
      `/app/${SITE}/keys#tokens`,
    );
    const apps = await card("Connected AI apps");
    expect(await within(apps).findByText("Claude Code")).toBeInTheDocument();
    await userEvent.click(within(apps).getByRole("button", { name: "Revoke Claude Code" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }),
    );
    expect(await within(apps).findByText("No connected apps.")).toBeInTheDocument();
  });
});

describe("all websites", () => {
  const nameOf = (card: HTMLElement) => within(card).getAllByRole("link")[0]?.textContent ?? "";

  it("shows every website with its numbers and reorders them", async () => {
    const log = recordRequests();
    openPage("/app/websites");
    const list = await screen.findByRole("list", { name: "Websites" });
    const cards = () => within(list).getAllByRole("listitem");
    const [first, second] = cards().map(nameOf);
    await waitFor(() =>
      expect(
        within(cards()[0] as HTMLElement).getByText("Visitors").nextSibling,
      ).not.toHaveTextContent("…"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(screen.getByRole("button", { name: "Last 7 days" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() =>
      expect(
        log.some(
          (r) =>
            r.path.startsWith("/api/v1/analytics/timeseries") && r.path.includes("interval=day"),
        ),
      ).toBe(true),
    );

    await userEvent.click(screen.getByRole("button", { name: `Move ${second} up` }));
    await waitFor(() =>
      expect(writes(log, "PUT", "/api/v1/admin/account/website-order")).toHaveLength(1),
    );
    const body = writes(log, "PUT", "/api/v1/admin/account/website-order")[0]?.body as {
      websiteIds: string[];
    };
    expect(body.websiteIds[0]).toBe(state.websites[0]?._id);
    expect(cards().map(nameOf).slice(0, 2)).toEqual([second, first]);
    // The website switcher follows the new order.
    const switcher = screen.getAllByRole("combobox", { name: "Website" })[0] as HTMLElement;
    expect(within(switcher).getAllByRole("option")[0]).toHaveTextContent(String(second));
  });
});
