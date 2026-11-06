import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { server } from "../../mocks/node";
import { resetMockState, state } from "../../mocks/state";
import { renderApp } from "../render";
import { openPage, recordRequests, SITE, SITE2, writes } from "./helpers";

afterEach(() => {
  server.events.removeAllListeners();
  window.localStorage.clear();
});

describe("onboarding: add a website", () => {
  it("creates the website with domain, timezone and currency, then guides the install until the first event", async () => {
    const log = recordRequests();
    resetMockState({ signedIn: true });
    renderApp("/app/new-site");
    await userEvent.type(await screen.findByLabelText("Domain"), "https://www.NewShop.io/");
    await userEvent.selectOptions(screen.getByLabelText("Timezone"), "Europe/Berlin");
    await userEvent.selectOptions(screen.getByLabelText("Currency"), "EUR");
    await userEvent.click(screen.getByRole("button", { name: "Add website" }));

    expect(await screen.findByText(/is added\. Three short steps/)).toBeInTheDocument();
    expect(writes(log, "POST", "/api/v1/admin/websites")[0]?.body).toEqual({
      domain: "www.newshop.io",
      name: null,
      timezone: "Europe/Berlin",
      currency: "EUR",
    });
    const created = state.websites.at(-1);
    expect(created?.currency).toBe("EUR");

    // Step 1 shows the details; step 2 the snippet for the new website.
    expect(screen.getByLabelText("Domain")).toHaveValue("www.newshop.io");
    const html = screen.getByRole("figure", { name: "HTML snippet" });
    expect(html).toHaveTextContent(`data-website-id="${created?.trackingId}"`);
    expect(html).toHaveTextContent('data-domain="www.newshop.io"');

    // Step 3 waits for the first event, then reports it.
    expect(await screen.findByText(/Waiting for the first event/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    await userEvent.click(await screen.findByRole("button", { name: "Check now" }));
    expect(
      await screen.findByText(/DataGoat is receiving events from www.newshop.io/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to dashboard" })).toBeInTheDocument();

    // Step 4 links to each payment provider.
    expect(screen.getByRole("link", { name: "Stripe" })).toHaveAttribute(
      "href",
      `/app/${created?._id}/integrations#stripe`,
    );
  });

  it("rejects a malformed domain", async () => {
    resetMockState({ signedIn: true });
    renderApp("/app/new-site");
    await userEvent.type(await screen.findByLabelText("Domain"), "not a domain");
    await userEvent.click(screen.getByRole("button", { name: "Add website" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a domain like example.com");
    expect(screen.getByLabelText("Domain")).toHaveAttribute("aria-invalid", "true");
  });

  it("opens the new website without a 'Website not found' flash", async () => {
    resetMockState({ signedIn: true });
    // A slow account refresh: the new website must not open before it is listed.
    let meCalls = 0;
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname === "/api/auth/me") meCalls += 1;
    });
    renderApp("/app/new-site");
    await userEvent.type(await screen.findByLabelText("Domain"), "fresh-site.io");
    const before = meCalls;
    server.use(
      http.get("/api/auth/me", async () => {
        await new Promise((r) => setTimeout(r, 300));
        return undefined;
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Add website" }));
    await waitFor(() => expect(window.location.pathname).toMatch(/\/settings\/install$/));
    expect(meCalls).toBeGreaterThan(before);
    expect(screen.queryByText("Website not found")).not.toBeInTheDocument();
    expect(await screen.findByText(/is added\. Three short steps/)).toBeInTheDocument();
  });

  it("shows the server's error for a duplicate domain", async () => {
    resetMockState({ signedIn: true });
    renderApp("/app/new-site");
    await userEvent.type(await screen.findByLabelText("Domain"), "example.com");
    await userEvent.click(screen.getByRole("button", { name: "Add website" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A website with this domain already exists",
    );
  });

  it("first-run setup lands on the install guide", async () => {
    resetMockState({ needsSetup: true });
    renderApp("/setup?token=mock-setup-token");
    await userEvent.type(await screen.findByLabelText("Email"), "owner@example.com");
    await userEvent.type(screen.getByLabelText(/^Password/), "a-long-password");
    await userEvent.type(screen.getByLabelText(/First website/), "example.com");
    await userEvent.click(screen.getByRole("button", { name: "Create owner account" }));
    expect(await screen.findByText(/Three short steps/)).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/app/${SITE}/settings/install`);
  });
});

describe("installation guide", () => {
  it("has a tab with steps and code for every platform, with arrow-key navigation", async () => {
    openPage(`/app/${SITE}/settings/install`);
    const tablist = await screen.findByRole("tablist", { name: "Platform" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "HTML",
      "Next.js",
      "React",
      "Vue / Nuxt",
      "WordPress",
      "Webflow",
      "Framer",
      "Shopify",
      "Google Tag Manager",
      "Switch from DataFast",
    ]);
    await userEvent.click(within(tablist).getByRole("tab", { name: "Next.js" }));
    expect(screen.getByRole("figure", { name: "Next.js snippet" })).toHaveTextContent(
      "next/script",
    );
    await userEvent.keyboard("{ArrowRight}");
    expect(within(tablist).getByRole("tab", { name: "React" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(tablist).getByRole("tab", { name: "React" })).toHaveFocus();
    await userEvent.click(within(tablist).getByRole("tab", { name: "Google Tag Manager" }));
    expect(screen.getByRole("figure", { name: "Google Tag Manager snippet" })).toHaveTextContent(
      's.setAttribute("data-website-id", "dfid_ExampleSaaS0001")',
    );
    await userEvent.click(within(tablist).getByRole("tab", { name: "Switch from DataFast" }));
    const swap = screen.getByRole("figure", { name: "Switch from DataFast snippet" });
    expect(swap).toHaveTextContent("https://datafa.st/js/script.js");
    expect(swap).toHaveTextContent(`${window.location.origin}/js/script.js`);
  });

  it("applies script options: first-party host, hash routing, localhost and allowed hostnames", async () => {
    openPage(`/app/${SITE}/settings/install`);
    const html = await screen.findByRole("figure", { name: "HTML snippet" });
    expect(html).toHaveTextContent('data-allowed-hostnames="app.example.com"');
    const host = screen.getByLabelText("Script host");
    await userEvent.clear(host);
    await userEvent.type(host, "https://a.example.com");
    await userEvent.click(screen.getByLabelText(/Hash-based routing/));
    await userEvent.click(screen.getByLabelText(/Track localhost/));
    const updated = screen.getByRole("figure", { name: "HTML snippet" });
    expect(updated).toHaveTextContent('src="https://a.example.com/js/script.hash.js"');
    expect(updated).toHaveTextContent('data-api-url="https://a.example.com/api/events"');
    expect(updated).toHaveTextContent('data-allow-localhost="true"');
    expect(window.localStorage.getItem(`datagoat.scriptOrigin.${SITE}`)).toBe(
      "https://a.example.com",
    );
  });

  it("uses the cookieless script for cookieless websites", async () => {
    openPage(`/app/${SITE2}/settings/install`);
    expect(await screen.findByRole("figure", { name: "HTML snippet" })).toHaveTextContent(
      "/js/script.cookieless.js",
    );
    expect(screen.getByLabelText(/Hash-based routing/)).toBeDisabled();
    expect(screen.getByText(/This website uses cookieless mode/)).toBeInTheDocument();
  });

  it("shows the consent calls in consent mode", async () => {
    resetMockState({ signedIn: true });
    const w = state.websites[0];
    if (w) w.privacyMode = "consent";
    renderApp(`/app/${SITE}/settings/install`);
    expect(await screen.findByRole("figure", { name: "consent snippet" })).toHaveTextContent(
      'window.datagoat("consent", true)',
    );
  });

  it("reports an installation that already has data", async () => {
    openPage(`/app/${SITE}/settings/install`);
    expect(
      await screen.findByText(/DataGoat is receiving events from example.com/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Nothing showing up?")).not.toBeInTheDocument();
  });

  it("explains failures when no event has arrived", async () => {
    server.use(
      http.get("/api/v1/analytics/overview", () =>
        HttpResponse.json({ status: "success", data: [{ pageviews: 0 }] }),
      ),
      http.get("/api/v1/analytics/realtime", () =>
        HttpResponse.json(
          { status: "error", error: { code: 500, message: "D1 unavailable" } },
          { status: 500 },
        ),
      ),
    );
    openPage(`/app/${SITE}/settings/install`);
    expect(
      await screen.findByText("Could not check for events: D1 unavailable"),
    ).toBeInTheDocument();
    expect(screen.getByText("Nothing showing up?")).toBeInTheDocument();
  });

  it("saves edited details from step 1", async () => {
    openPage(`/app/${SITE}/settings/install`);
    await userEvent.selectOptions(await screen.findByLabelText("Timezone"), "UTC");
    const step = screen.getByLabelText("Timezone").closest("section") as HTMLElement;
    await userEvent.click(within(step).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(state.websites[0]?.timezone).toBe("UTC"));
  });
});
