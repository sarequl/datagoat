import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { resetMockState } from "../../mocks/state";
import { clientGuide } from "../../pages/settings/McpPage";
import { renderApp } from "../render";

const SITE = "6728f0a0a1b2c3d4e5f6a001";

describe("AI assistants (MCP) page", () => {
  it("shows the server URL, per-client steps and the connected apps", async () => {
    resetMockState({ signedIn: true });
    renderApp(`/app/${SITE}/mcp`);
    expect(
      await screen.findByRole("heading", { name: "AI assistants (MCP)", level: 1 }),
    ).toBeInTheDocument();
    const url = `${window.location.origin}/mcp`;
    expect(screen.getByRole("textbox", { name: "MCP server URL" })).toHaveValue(url);
    // Claude Code first, with its one-line command.
    expect(screen.getByRole("tab", { name: "Claude Code" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("figure", { name: "claude-code setup" })).toHaveTextContent(
      `claude mcp add --transport http datagoat ${url}`,
    );
    await userEvent.click(screen.getByRole("tab", { name: "Cursor" }));
    expect(screen.getByRole("figure", { name: "cursor setup" })).toHaveTextContent('"mcpServers"');
    await userEvent.click(screen.getByRole("tab", { name: "ChatGPT" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("choose OAuth");
    expect(screen.queryByRole("figure", { name: /setup/ })).not.toBeInTheDocument();
    for (const link of within(screen.getByRole("main")).getAllByRole("link", {
      name: "API keys",
    })) {
      expect(link).toHaveAttribute("href", `/app/${SITE}/keys`);
    }
    expect(screen.getByRole("heading", { name: "Connected AI apps" })).toBeInTheDocument();
    // Listed under Developers in the Settings menu.
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getByRole("link", { name: "AI assistants (MCP)" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("gives every client steps that mention the URL or a command", () => {
    const url = "https://a.example.com/mcp";
    for (const c of ["claude-code", "claude", "chatgpt", "cursor", "codex"] as const) {
      const g = clientGuide(c, url);
      expect(g.steps.length).toBeGreaterThan(0);
      expect(`${g.steps.join(" ")} ${g.code ?? ""}`).toContain(url);
    }
  });
});
