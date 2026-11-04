import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
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
    for (const item of SITE_PAGES.filter((p) => !p.hidden)) {
      expect(nav).toHaveTextContent(item.label);
    }
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

  it("renders every website page's placeholder when signed in", async () => {
    resetMockState({ signedIn: true });
    const page = SITE_PAGES.find((p) => p.path === "bot-traffic");
    renderApp(`/app/6728f0a0a1b2c3d4e5f6a001/${page?.path}`);
    expect(await screen.findByRole("heading", { name: "Bot traffic" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("coming-soon")).toBeInTheDocument());
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
