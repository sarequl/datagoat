import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageLoader } from "../components/ui";
import { server } from "../mocks/node";
import { resetMockState } from "../mocks/state";
import { failingSecrets, randomHex } from "../pages/auth/FixSecretsPanel";
import { renderApp } from "./render";

const PLACEHOLDER_ERRORS = [
  "SETUP_TOKEN still has the example placeholder value",
  "SESSION_SECRET still has the example placeholder value",
  "ENCRYPTION_KEY still has the example placeholder value",
];

describe("setup with unconfigured Worker secrets", () => {
  it("explains the fix with fresh values instead of showing the sign-up form", async () => {
    resetMockState({ needsSetup: true });
    let configErrors = PLACEHOLDER_ERRORS;
    const posts: unknown[] = [];
    server.use(
      http.get("/api/setup", () =>
        HttpResponse.json({ status: "success", data: { needsSetup: true, configErrors } }),
      ),
      http.post("/api/setup", async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json({ status: "success", data: {} });
      }),
    );
    renderApp("/setup?token=replace-with-output-of-openssl-rand-hex-24");

    expect(
      await screen.findByRole("heading", { name: "Finish configuring DataGoat" }),
    ).toBeInTheDocument();
    for (const message of PLACEHOLDER_ERRORS) expect(screen.getByText(message)).toBeInTheDocument();
    // No account form until the secrets are fixed.
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();

    const token = screen.getByRole("textbox", { name: "SETUP_TOKEN" }) as HTMLInputElement;
    const session = screen.getByRole("textbox", { name: "SESSION_SECRET" }) as HTMLInputElement;
    const key = screen.getByRole("textbox", { name: "ENCRYPTION_KEY" }) as HTMLInputElement;
    expect(token.value).toMatch(/^[0-9a-f]{48}$/);
    expect(session.value).toMatch(/^[0-9a-f]{64}$/);
    expect(key.value).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([token.value, session.value, key.value]).size).toBe(3);
    expect(
      (screen.getByRole("textbox", { name: "Setup link" }) as HTMLInputElement).value,
    ).toContain(`/setup?token=${token.value}`);
    expect(screen.getByRole("figure", { name: "Wrangler commands" })).toHaveTextContent(
      "npx wrangler secret put ENCRYPTION_KEY",
    );

    // Once the secrets are saved, "check again" shows the normal setup form.
    configErrors = [];
    await userEvent.click(screen.getByRole("button", { name: "I saved them, check again" }));
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    // The generated values never left the browser.
    expect(posts).toEqual([]);
  });

  it("lists only the secrets that are wrong", () => {
    expect(failingSecrets(["SESSION_SECRET is not set"])).toEqual(["SESSION_SECRET"]);
    expect(failingSecrets(PLACEHOLDER_ERRORS)).toEqual([
      "SETUP_TOKEN",
      "SESSION_SECRET",
      "ENCRYPTION_KEY",
    ]);
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});

describe("page loader", () => {
  afterEach(() => vi.useRealTimers());

  it("stays invisible for fast loads, then shows the centered logo", () => {
    vi.useFakeTimers();
    const { container } = render(<PageLoader />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading");
    expect(status.className).toContain("fixed");
    expect(status.className).toContain("place-items-center");
    expect(container.querySelector("svg")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(container.querySelector("svg")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
