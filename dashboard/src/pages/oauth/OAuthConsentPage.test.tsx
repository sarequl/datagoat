import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_PASSWORD } from "../../mocks/fixtures/core";
import { MOCK_CONSENT_REQUEST } from "../../mocks/fixtures/oauth";
import { server } from "../../mocks/node";
import { resetMockState } from "../../mocks/state";
import { renderApp } from "../../test/render";

const PATH = `/oauth/consent?request=${MOCK_CONSENT_REQUEST}`;

afterEach(() => vi.restoreAllMocks());

function spyRedirect() {
  return vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
}

describe("OAuth consent page", () => {
  it("asks a signed-out user to sign in, then shows the request", async () => {
    renderApp(PATH);
    expect(
      await screen.findByRole("heading", { name: "Connect Claude to DataGoat" }),
    ).toBeVisible();
    await userEvent.type(screen.getByLabelText("Email"), "demo@datagoat.dev");
    await userEvent.type(screen.getByLabelText("Password"), MOCK_PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByRole("heading", { name: "Allow Claude to access DataGoat?" }),
    ).toBeVisible();
    expect(screen.getByText(/not verified/)).toBeVisible();
    expect(screen.getByText("client.example")).toBeVisible();
  });

  it("pre-selects read permissions only and sends the chosen selection", async () => {
    resetMockState({ signedIn: true });
    const assign = spyRedirect();
    let sent: unknown;
    server.use(
      http.post("/oauth/authorize", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({
          status: "success",
          data: { redirectTo: "https://client.example/callback?code=dgac_x&state=s" },
        });
      }),
    );
    renderApp(PATH);
    const analytics = await screen.findByRole("checkbox", { name: /Read analytics/ });
    expect(analytics).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /List websites/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Read visitor identities/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Manage notes/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Manage website API keys/ })).not.toBeChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: /Manage notes/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /List websites/ }));
    const site = screen.getByRole("checkbox", { name: /Example SaaS/ });
    expect(site).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Allow access" }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://client.example/callback?code=dgac_x&state=s"),
    );
    expect(sent).toMatchObject({
      request: MOCK_CONSENT_REQUEST,
      approve: true,
      scopes: expect.arrayContaining(["analytics:read", "notes:write"]),
    });
    expect((sent as { scopes: string[] }).scopes).not.toContain("websites:read");
    expect((sent as { websiteIds: string[] }).websiteIds).toContain("6728f0a0a1b2c3d4e5f6a001");
  });

  it("declines with Cancel", async () => {
    resetMockState({ signedIn: true });
    const assign = spyRedirect();
    renderApp(PATH);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(String(assign.mock.calls[0]?.[0])).toContain("error=access_denied");
  });

  it("disables Allow when no permission is selected", async () => {
    resetMockState({ signedIn: true });
    renderApp(PATH);
    for (const name of [/Read analytics/, /List websites/]) {
      await userEvent.click(await screen.findByRole("checkbox", { name }));
    }
    expect(screen.getByRole("button", { name: "Allow access" })).toBeDisabled();
  });

  it("shows authorization errors and expired requests", async () => {
    renderApp("/oauth/consent?error=invalid_client&error_description=Unknown%20client");
    expect(await screen.findByRole("heading", { name: "This app cannot connect" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Unknown client");
  });

  it("explains an expired request", async () => {
    renderApp("/oauth/consent?request=stale");
    expect(await screen.findByRole("heading", { name: "This request expired" })).toBeVisible();
  });
});
