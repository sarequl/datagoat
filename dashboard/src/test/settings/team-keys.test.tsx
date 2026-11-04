import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { server } from "../../mocks/node";
import { state } from "../../mocks/state";
import { openPage, recordRequests, SITE, SITE2, writes } from "./helpers";

afterEach(() => server.events.removeAllListeners());

const card = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest("section") as HTMLElement;

describe("team", () => {
  it("invites by link and lists the pending invite", async () => {
    openPage(`/app/${SITE}/team`);
    const invite = await card("Invite someone");
    await userEvent.type(within(invite).getByLabelText("Email"), "Cofounder@Example.com");
    await userEvent.selectOptions(within(invite).getByLabelText("Role"), "member");
    await userEvent.click(within(invite).getByRole("button", { name: "Create invite" }));
    expect(
      await within(invite).findByText(/Invite created for cofounder@example.com as member/),
    ).toBeInTheDocument();
    expect(within(invite).getByRole("textbox", { name: "Invite link" })).toHaveValue(
      `${window.location.origin}/invite/mock-invite-token-101`,
    );
    const pending = await card("Pending invites");
    expect(await within(pending).findByText("cofounder@example.com")).toBeInTheDocument();
  });

  it("shows conflicts from the server", async () => {
    openPage(`/app/${SITE}/team`);
    const invite = await card("Invite someone");
    await userEvent.type(within(invite).getByLabelText("Email"), "sam@example.com");
    await userEvent.click(within(invite).getByRole("button", { name: "Create invite" }));
    expect(await within(invite).findByRole("alert")).toHaveTextContent(
      "This user is already a member of the website",
    );
  });

  it("changes a role, removes a member and revokes an invite", async () => {
    openPage(`/app/${SITE}/team`);
    const role = await screen.findByRole("combobox", { name: "Role of sam@example.com" });
    await userEvent.selectOptions(role, "viewer");
    await waitFor(() =>
      expect(state.team[SITE]?.find((m) => m.email === "sam@example.com")?.role).toBe("viewer"),
    );
    // The signed-in owner cannot change or remove themselves.
    expect(screen.queryByRole("combobox", { name: "Role of demo@datagoat.dev" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Remove viewer@example.com" }));
    const dialog = screen.getByRole("dialog", { name: "Remove viewer@example.com?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove member" }));
    await waitFor(() => expect(screen.queryByText("viewer@example.com")).not.toBeInTheDocument());

    await userEvent.click(
      await screen.findByRole("button", { name: "Revoke invite for new@example.com" }),
    );
    await waitFor(() => expect(screen.getByText("No pending invites.")).toBeInTheDocument());
  });

  it("shows a role change refused by the server", async () => {
    server.use(
      http.put("/api/v1/admin/websites/:id/team", () =>
        HttpResponse.json(
          { status: "error", error: { code: 400, message: "A website needs at least one owner" } },
          { status: 400 },
        ),
      ),
    );
    openPage(`/app/${SITE}/team`);
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Role of sam@example.com" }),
      "viewer",
    );
    expect(await screen.findByText("A website needs at least one owner")).toBeInTheDocument();
  });

  it("is read-only for members and viewers", async () => {
    openPage(`/app/${SITE2}/team`);
    expect(await screen.findByText(/You are a member on this website/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Invite someone" })).not.toBeInTheDocument();
    expect(await screen.findByText(/sam@example.com/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Role of/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Revoke invite/ })).not.toBeInTheDocument();
  });
});

describe("API keys", () => {
  it("creates a website key, shows it once, rolls and revokes it", async () => {
    const log = recordRequests();
    openPage(`/app/${SITE}/keys`);
    const keys = await card("Website API keys (df_)");
    await userEvent.type(within(keys).getByLabelText("Key name"), "Backend");
    await userEvent.click(within(keys).getByLabelText(/Include customer names and emails/));
    await userEvent.click(within(keys).getByRole("button", { name: "Create key" }));
    const secret = await within(keys).findByRole("textbox", { name: "New secret" });
    expect((secret as HTMLInputElement).value).toMatch(/^df_mock/);
    expect(writes(log, "POST", "/apikeys")[0]?.body).toEqual({ name: "Backend", includePii: true });
    expect(within(keys).getByRole("figure", { name: "example request" })).toHaveTextContent(
      "Authorization: Bearer df_mock",
    );
    await userEvent.click(within(keys).getByRole("button", { name: "Done" }));
    expect(within(keys).queryByRole("textbox", { name: "New secret" })).not.toBeInTheDocument();
    expect(await within(keys).findByText("Backend")).toBeInTheDocument();
    expect(within(keys).getByText("PII")).toBeInTheDocument();

    await userEvent.click(within(keys).getByRole("button", { name: "Roll Backend" }));
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Roll Backend?" })).getByRole("button", {
        name: "Roll key",
      }),
    );
    expect(
      ((await within(keys).findByRole("textbox", { name: "New secret" })) as HTMLInputElement)
        .value,
    ).toMatch(/^df_mockRolled/);

    await userEvent.click(within(keys).getByRole("button", { name: "Revoke Backend" }));
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Revoke Backend?" })).getByRole("button", {
        name: "Revoke key",
      }),
    );
    await waitFor(() =>
      expect(state.siteKeys[SITE]?.map((k) => k.name)).toEqual(["Production backend"]),
    );
  });

  it("disables creation at the 10-key limit", async () => {
    openPage(`/app/${SITE}/keys`);
    const keys = await card("Website API keys (df_)");
    await within(keys).findByText("Production backend");
    for (let i = 0; i < 9; i++) {
      await userEvent.click(within(keys).getByRole("button", { name: "Create key" }));
      await within(keys).findByRole("button", { name: "Done" });
      await userEvent.click(within(keys).getByRole("button", { name: "Done" }));
    }
    await waitFor(() =>
      expect(within(keys).getByRole("button", { name: "Create key" })).toBeDisabled(),
    );
    expect(within(keys).getByText("At most 10 keys per website.")).toBeInTheDocument();
  });

  it("creates a scoped account token and revokes it", async () => {
    const log = recordRequests();
    openPage(`/app/${SITE}/keys`);
    const tokens = await card("Account access tokens (dft_)");
    await userEvent.type(within(tokens).getByLabelText("Token name"), "Agent");
    await userEvent.click(within(tokens).getByRole("radio", { name: "Custom" }));
    await userEvent.click(within(tokens).getByRole("checkbox", { name: "goals:write" }));
    await userEvent.click(within(tokens).getByRole("radio", { name: "Only selected websites" }));
    await userEvent.selectOptions(within(tokens).getByLabelText("Expires"), "30");
    await userEvent.click(within(tokens).getByRole("button", { name: "Create token" }));
    expect(
      ((await within(tokens).findByRole("textbox", { name: "New secret" })) as HTMLInputElement)
        .value,
    ).toMatch(/^dft_mock/);
    expect(writes(log, "POST", "/access-tokens")[0]?.body).toEqual({
      name: "Agent",
      permissions: ["analytics:read", "goals:write"],
      websiteIds: [SITE],
      includePii: false,
      expiresInDays: 30,
    });
    expect(await within(tokens).findByText("Agent")).toBeInTheDocument();
    expect(within(tokens).getByText(/Websites: Example SaaS/)).toBeInTheDocument();

    await userEvent.click(within(tokens).getByRole("button", { name: "Revoke Agent" }));
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Revoke Agent?" })).getByRole("button", {
        name: "Revoke token",
      }),
    );
    await waitFor(() => expect(within(tokens).queryByText("Agent")).not.toBeInTheDocument());
  });

  it("requires a permission and a website for custom tokens", async () => {
    openPage(`/app/${SITE}/keys`);
    const tokens = await card("Account access tokens (dft_)");
    await userEvent.click(within(tokens).getByRole("radio", { name: "Custom" }));
    await userEvent.click(within(tokens).getByRole("checkbox", { name: "analytics:read" }));
    await userEvent.click(within(tokens).getByRole("button", { name: "Create token" }));
    expect(within(tokens).getByRole("alert")).toHaveTextContent("Choose at least one permission.");
  });

  it("lets viewers see but not change website keys", async () => {
    openPage(`/app/${SITE}/keys`, { role: "viewer" });
    const keys = await card("Website API keys (df_)");
    expect(await within(keys).findByText("Production backend")).toBeInTheDocument();
    expect(within(keys).queryByRole("button", { name: "Create key" })).not.toBeInTheDocument();
    expect(within(keys).queryByRole("button", { name: /^Roll/ })).not.toBeInTheDocument();
  });
});
