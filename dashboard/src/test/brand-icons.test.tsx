import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppIcon, appOf } from "../components/AppIcons";
import { BRAND_MARKS, BrandTile } from "../components/BrandMarks";
import { scopeSummary } from "../pages/account/AccountPage";
import { PROVIDERS } from "../pages/settings/lib/providers";
import { openPage, SITE } from "./settings/helpers";

describe("brand icons", () => {
  it("has a mark for every payment provider and growth integration", () => {
    for (const p of PROVIDERS) expect(BRAND_MARKS[p.id], p.id).toBeDefined();
    for (const k of ["google-search-console", "github", "x", "meta-ads"]) {
      expect(BRAND_MARKS[k], k).toBeDefined();
    }
  });

  it("draws vector marks and bundled images, with a monogram fallback", () => {
    const { container, rerender } = render(<BrandTile id="stripe" name="Stripe" />);
    expect(container.querySelector("svg path")).not.toBeNull();
    rerender(<BrandTile id="polar" name="Polar" />);
    expect(container.querySelector("img")?.getAttribute("src")).toMatch(/polar/);
    rerender(<BrandTile id="unknown" name="Acme" />);
    expect(container).toHaveTextContent("A");
  });

  it("matches connected AI apps to their logos", () => {
    expect(appOf("Claude")).toBe("claude");
    expect(appOf("Claude Code")).toBe("claude");
    expect(appOf("Cursor")).toBe("cursor");
    expect(appOf("ChatGPT")).toBe("chatgpt");
    expect(appOf(null)).toBe("other");
    const { container } = render(<AppIcon app="claude" />);
    expect(container.querySelector("svg")?.getAttribute("fill")).toBe("#D97757");
  });

  it("summarises permissions instead of listing them inline", () => {
    expect(scopeSummary(["analytics:read", "websites:read"])).toBe("2 permissions · read only");
    expect(scopeSummary(["analytics:read", "notes:write"])).toBe("2 permissions · read and write");
    expect(scopeSummary(["analytics:read"])).toBe("1 permission · read only");
  });

  it("shows app logos on the MCP page tabs and connected apps", async () => {
    openPage(`/app/${SITE}/mcp`);
    const tab = await screen.findByRole("tab", { name: "Claude Code" });
    expect(tab.querySelector("svg")).not.toBeNull();
    const summary = await screen.findByText(/permissions? · read/);
    expect(summary.closest("li")?.querySelector("svg")).not.toBeNull();
  });
});
