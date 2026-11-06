import { render, screen, within } from "@testing-library/react";
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
  it("redirects signed-out users to login, signs in, and shows the overview with the top bar", async () => {
    renderApp("/app");
    const email = await screen.findByLabelText("Email");
    await userEvent.type(email, "demo@datagoat.dev");
    await userEvent.type(screen.getByLabelText("Password"), MOCK_PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Main" });
    for (const label of ["Overview", "Realtime", "Visitors", "Settings"])
      expect(within(nav).getByRole("link", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Every page stays reachable: ⌘K lists all of them.
    await userEvent.click(within(nav).getByRole("button", { name: "Search or jump to" }));
    const dialog = screen.getByRole("dialog", { name: "Search or jump to" });
    for (const item of SITE_PAGES.filter((p) => !p.path.includes("$"))) {
      expect(dialog).toHaveTextContent(item.label);
    }
    await userEvent.keyboard("{Escape}");
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
    expect(
      await screen.findByRole("heading", { name: "Installation", level: 1 }),
    ).toBeInTheDocument();
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
