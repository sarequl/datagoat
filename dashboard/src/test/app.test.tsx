import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { PagePlaceholder } from "../components/PagePlaceholder";
import { MOCK_PASSWORD } from "../mocks/fixtures/core";
import { server } from "../mocks/node";
import { resetMockState } from "../mocks/state";
import { SITE_PAGES } from "../nav";
import { renderApp } from "./render";

describe("dashboard shell", () => {
  it("redirects signed-out users to login, signs in, and shows the overview with the full sidebar", async () => {
    renderApp("/app");
    const email = await screen.findByLabelText("Email");
    await userEvent.type(email, "demo@datagoat.dev");
    await userEvent.type(screen.getByLabelText("Password"), MOCK_PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Main" });
    // Developers and Settings start collapsed; opening them shows the rest.
    for (const group of ["Developers", "Settings"]) {
      const toggle = within(nav).getByRole("button", { name: group });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      await userEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
    }
    for (const item of SITE_PAGES.filter((p) => !p.hidden)) {
      expect(nav).toHaveTextContent(item.navLabel ?? item.label);
    }
    expect(within(nav).getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(document.body).not.toHaveTextContent(/Owner: W\d|CONTRACTS\.md/);
    expect(screen.getByRole("combobox", { name: "Website" })).toHaveDisplayValue("Example SaaS");
  });

  it("shows the server's error for wrong credentials", async () => {
    renderApp("/login");
    await userEvent.type(await screen.findByLabelText("Email"), "demo@datagoat.dev");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
  });

  it("completes first-run setup from the setup link", async () => {
    resetMockState({ needsSetup: true });
    renderApp("/setup?token=mock-setup-token");
    await userEvent.type(await screen.findByLabelText("Email"), "owner@example.com");
    await userEvent.type(screen.getByLabelText(/^Password/), "a-long-password");
    await userEvent.type(screen.getByLabelText(/First website/), "example.com");
    await userEvent.click(screen.getByRole("button", { name: "Create owner account" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });

  it("shows the server's reason when the database is not initialised", async () => {
    server.use(
      http.get("/api/setup", () =>
        HttpResponse.json(
          {
            status: "error",
            error: {
              code: 503,
              message: "Database is not initialised: migration 0001_init.sql failed",
            },
          },
          { status: 503 },
        ),
      ),
    );
    renderApp("/setup?token=x");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Database is not initialised: migration 0001_init.sql failed",
    );
  });

  it("shows the real error when setup fails", async () => {
    resetMockState({ needsSetup: true });
    server.use(
      http.post("/api/setup", () =>
        HttpResponse.json(
          { status: "error", error: { code: 500, message: "Setup failed: disk full" } },
          { status: 500 },
        ),
      ),
    );
    renderApp("/setup?token=mock-setup-token");
    await userEvent.type(await screen.findByLabelText("Email"), "owner@example.com");
    await userEvent.type(screen.getByLabelText(/^Password/), "a-long-password");
    await userEvent.click(screen.getByRole("button", { name: "Create owner account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Setup failed: disk full");
  });

  it("requests a password reset link from the login page", async () => {
    const bodies: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === "/api/auth/password-resets"
      )
        bodies.push(await request.clone().json());
    });
    renderApp("/login");
    await userEvent.click(await screen.findByRole("link", { name: "Forgot password?" }));
    expect(await screen.findByRole("heading", { name: "Reset your password" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Email"), "nobody@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "If an account exists for that email, a password reset link is on its way.",
    );
    expect(bodies).toEqual([{ email: "nobody@example.com" }]);
    server.events.removeAllListeners();
    await userEvent.click(screen.getByRole("link", { name: "Back to sign in" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows the server's fallback when email is not configured", async () => {
    server.use(
      http.post("/api/auth/password-resets", () =>
        HttpResponse.json(
          {
            status: "error",
            error: {
              code: 503,
              message:
                "Email is not configured on this server. Ask the operator to run `npm run reset-password -- <email> <url>`.",
            },
          },
          { status: 503 },
        ),
      ),
    );
    renderApp("/forgot-password");
    await userEvent.type(await screen.findByLabelText("Email"), "demo@datagoat.dev");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("npm run reset-password");
  });

  it("renders the placeholder for pages that are not built yet", async () => {
    // Pages are replaced by their teams; the placeholder component itself stays covered here.
    render(
      <PagePlaceholder
        title="Unbuilt page"
        description="AI assistant, indexing and training crawler requests."
      />,
    );
    expect(screen.getByRole("heading", { name: "Unbuilt page" })).toBeInTheDocument();
    expect(screen.getByTestId("coming-soon")).toHaveTextContent("Coming soon");
    expect(
      screen.getByText(/AI assistant, indexing and training crawler requests/),
    ).toBeInTheDocument();
  });
});

describe("phone navigation drawer", () => {
  it("opens from the menu button, traps focus, closes on Escape, backdrop and navigation", async () => {
    resetMockState({ signedIn: true });
    renderApp("/app/6728f0a0a1b2c3d4e5f6a001/overview");
    const menu = await screen.findByRole("button", { name: "Open menu" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(menu);
    const dialog = screen.getByRole("dialog", { name: "Navigation" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(menu).toHaveAttribute("aria-expanded", "true");
    // Focus moves into the drawer and Tab cycles inside it.
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 40; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(menu).toHaveFocus();

    await userEvent.click(menu);
    await userEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(menu);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("link", { name: "Goals" }));
    expect(await screen.findByRole("heading", { name: "Goals", level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
