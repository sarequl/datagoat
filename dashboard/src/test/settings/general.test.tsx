import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { server } from "../../mocks/node";
import { openPage, recordRequests, SITE, SITE2, site, writes } from "./helpers";

afterEach(() => server.events.removeAllListeners());

describe("general settings", () => {
  it("shows the section tabs and saves only the changed website fields", async () => {
    const log = recordRequests();
    openPage(`/app/${SITE}/settings/general`);
    const tabs = await screen.findByRole("navigation", { name: "Settings sections" });
    for (const label of [
      "General",
      "Installation",
      "Tracking & privacy",
      "Exclusions",
      "Attribution & revenue",
      "Delete website",
    ]) {
      expect(within(tabs).getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(within(tabs).getByRole("link", { name: "General" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const name = await screen.findByLabelText(/^Name/);
    expect(name).toHaveValue("Example SaaS");
    await userEvent.clear(name);
    await userEvent.type(name, "Example Inc");
    await userEvent.selectOptions(screen.getByLabelText(/^Currency/), "EUR");
    const card = name.closest("section") as HTMLElement;
    await userEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(site().name).toBe("Example Inc"));
    expect(site().currency).toBe("EUR");
    expect(writes(log, "PUT", `/websites/${SITE}`)[0]?.body).toEqual({
      name: "Example Inc",
      currency: "EUR",
    });
    expect(await within(card).findByText("Saved")).toBeInTheDocument();
    // The sidebar switcher picks up the new name.
    await waitFor(() =>
      expect(screen.getAllByRole("combobox", { name: "Website" })[0]).toHaveDisplayValue(
        "Example Inc",
      ),
    );
  });

  it("rejects an invalid domain without calling the API", async () => {
    const log = recordRequests();
    openPage(`/app/${SITE}/settings/general`);
    const domain = await screen.findByLabelText(/^Domain/);
    await userEvent.clear(domain);
    await userEvent.type(domain, "not a domain");
    await userEvent.click(
      within(domain.closest("section") as HTMLElement).getByRole("button", { name: "Save" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a domain like example.com");
    expect(writes(log, "PUT", "/websites/")).toHaveLength(0);
  });

  it("changes the #1 KPI after confirmation", async () => {
    openPage(`/app/${SITE}/settings/general`);
    const kpi = (await screen.findByRole("heading", { name: "#1 KPI" })).closest(
      "section",
    ) as HTMLElement;
    expect(within(kpi).getByRole("combobox", { name: "Goal" })).toHaveValue("signup");
    await userEvent.click(within(kpi).getByRole("radio", { name: /Revenue/ }));
    await userEvent.click(within(kpi).getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog", { name: "Change your #1 KPI?" });
    expect(dialog).toHaveTextContent("revenue");
    await userEvent.click(within(dialog).getByRole("button", { name: "Change KPI" }));
    await waitFor(() => expect(site().kpi).toBe("revenue"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("validates a goal KPI name", async () => {
    openPage(`/app/${SITE}/settings/general`);
    const kpi = (await screen.findByRole("heading", { name: "#1 KPI" })).closest(
      "section",
    ) as HTMLElement;
    const goal = within(kpi).getByRole("combobox", { name: "Goal" });
    await userEvent.clear(goal);
    await userEvent.type(goal, "Bad Name!");
    await userEvent.click(within(kpi).getByRole("button", { name: "Save" }));
    expect(within(kpi).getByRole("alert")).toHaveTextContent("Pick a goal");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("toggles email reports immediately", async () => {
    openPage(`/app/${SITE}/settings/general`);
    const weekly = await screen.findByRole("switch", { name: "Weekly report" });
    expect(weekly).toHaveAttribute("aria-checked", "true");
    await userEvent.click(weekly);
    await waitFor(() => expect(site().sendWeeklyReports).toBe(false));
    await waitFor(() => expect(weekly).toHaveAttribute("aria-checked", "false"));
  });

  it("shows the tracking snippet and IDs", async () => {
    openPage(`/app/${SITE}/settings/general`);
    const snippet = await screen.findByRole("figure", { name: "tracking snippet" });
    expect(snippet).toHaveTextContent('data-website-id="dfid_ExampleSaaS0001"');
    expect(screen.getByLabelText(/^Website ID/)).toHaveValue("dfid_ExampleSaaS0001");
    expect(screen.getByLabelText(/^API website ID/)).toHaveValue(SITE);
  });

  it("is read-only for viewers", async () => {
    openPage(`/app/${SITE}/settings/general`, { role: "viewer" });
    expect(await screen.findByText(/You are a viewer on this website/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Weekly report" })).toBeDisabled();
    for (const save of screen.getAllByRole("button", { name: "Save" })) expect(save).toBeDisabled();
  });

  it("lets members edit settings", async () => {
    openPage(`/app/${SITE2}/settings/general`);
    expect(await screen.findByLabelText(/^Name/)).not.toBeDisabled();
    expect(screen.queryByText(/You are a member/)).not.toBeInTheDocument();
  });
});
