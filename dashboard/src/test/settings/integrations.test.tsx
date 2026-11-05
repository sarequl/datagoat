import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { server } from "../../mocks/node";
import { state } from "../../mocks/state";
import { openPage, recordRequests, SITE, writes } from "./helpers";

afterEach(() => server.events.removeAllListeners());

const provider = (id: string) =>
  waitFor(() => {
    const el = document.getElementById(`integration-${id}`);
    if (!el) throw new Error(`no card for ${id}`);
    return el;
  });

/** Open a growth integration's row (Manage, Set up or Details). */
async function openRow(kind: string) {
  const row = await provider(kind);
  await userEvent.click(within(row).getByRole("button", { name: /^(Manage|Set up|Details)$/ }));
  return row;
}

describe("integrations directory", () => {
  it("lists connected integrations first, filters by category and searches", async () => {
    openPage(`/app/${SITE}/integrations`);
    const connected = await screen.findByRole("region", { name: "Connected" });
    expect(within(connected).getByRole("heading", { name: "Stripe" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Payments" })).toHaveTextContent("Lemon Squeezy");
    expect(screen.getByText(/\d+ connected/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /^Growth/ }));
    expect(screen.queryByRole("region", { name: "Payments" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Stripe" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Meta Ads" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /^All/ }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search integrations" }), "lemon");
    expect(screen.getByRole("heading", { name: "Lemon Squeezy" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Paddle" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search integrations" }), "zzz");
    expect(screen.getByText(/No integrations match/)).toBeInTheDocument();
  });
});

describe("payment providers", () => {
  it("shows a connected provider's status, re-syncs and disconnects it", async () => {
    openPage(`/app/${SITE}/integrations`);
    const stripe = await provider("stripe");
    expect(within(stripe).getByText("Connected")).toBeInTheDocument();
    expect(within(stripe).getByText("Example Inc.")).toBeInTheDocument();
    await userEvent.click(within(stripe).getByRole("button", { name: "Re-sync" }));
    expect(await within(stripe).findByText("Stripe payment re-sync queued")).toBeInTheDocument();
    await userEvent.click(within(stripe).getByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect Stripe?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(
      await within(stripe).findByRole("button", { name: "Connect Stripe" }),
    ).toBeInTheDocument();
    expect(state.integrations[SITE]?.stripe.connected).toBe(false);
  });

  it("connects Lemon Squeezy with setup steps, validation and the currency note", async () => {
    const log = recordRequests();
    openPage(`/app/${SITE}/integrations`);
    const ls = await provider("lemonsqueezy");
    await userEvent.click(within(ls).getByRole("button", { name: "Connect Lemon Squeezy" }));
    expect(within(ls).getByText(/Settings > API and create an API key/)).toBeInTheDocument();
    await userEvent.type(within(ls).getByLabelText("Store ID"), "abc");
    await userEvent.click(within(ls).getByRole("button", { name: "Connect Lemon Squeezy" }));
    expect(within(ls).getByText("The API key is required.")).toBeInTheDocument();
    expect(within(ls).getByText("The store ID is a number.")).toBeInTheDocument();
    expect(writes(log, "POST", "/integrations/")).toHaveLength(0);

    await userEvent.type(within(ls).getByLabelText("API key"), "ls_key_123");
    await userEvent.clear(within(ls).getByLabelText("Store ID"));
    await userEvent.type(within(ls).getByLabelText("Store ID"), "4242");
    await userEvent.click(within(ls).getByRole("button", { name: "Connect Lemon Squeezy" }));
    expect(
      await within(ls).findByText(
        "Lemon Squeezy connected successfully. Payments in EUR are converted to USD.",
      ),
    ).toBeInTheDocument();
    expect(writes(log, "POST", "/integrations/lemonsqueezy")[0]?.body).toEqual({
      lemonsqueezyApiKey: "ls_key_123",
      lemonsqueezyStoreId: "4242",
    });
    await waitFor(() => expect(within(ls).getByText("Connected")).toBeInTheDocument());
    expect(within(ls).getByText("Importing past payments…")).toBeInTheDocument();
  });

  it("refuses Stripe secret keys before sending and shows provider errors", async () => {
    openPage(`/app/${SITE}/integrations`);
    const stripe = await provider("stripe");
    await userEvent.click(within(stripe).getByRole("button", { name: "Disconnect" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }),
    );
    await userEvent.click(await within(stripe).findByRole("button", { name: "Connect Stripe" }));
    const key = within(stripe).getByLabelText("Restricted API key");
    expect(key).toHaveAttribute("type", "password");
    await userEvent.type(key, "sk_live_123");
    await userEvent.click(within(stripe).getByRole("button", { name: "Connect Stripe" }));
    expect(within(stripe).getByRole("alert")).toHaveTextContent("Use a restricted key (rk_…)");
    await userEvent.clear(key);
    await userEvent.type(key, "rk_live_invalid");
    await userEvent.click(within(stripe).getByRole("button", { name: "Connect Stripe" }));
    expect(
      await within(stripe).findByText("Stripe rejected the key: Invalid API Key provided"),
    ).toBeInTheDocument();
  });

  it("shows webhook URLs for Dodo and the install link flow for Shopify", async () => {
    openPage(`/app/${SITE}/integrations`);
    const dodo = await provider("dodo");
    await userEvent.click(within(dodo).getByRole("button", { name: "Connect Dodo Payments" }));
    expect(within(dodo).getByLabelText("Dodo Payments webhook URL")).toHaveValue(
      `${window.location.origin}/webhooks/dodo/${SITE}`,
    );
    const shopify = await provider("shopify");
    await userEvent.click(within(shopify).getByRole("button", { name: "Connect Shopify" }));
    const install = within(shopify).getByRole("link", { name: "Install app" });
    await userEvent.click(install);
    expect(within(shopify).getByRole("alert")).toHaveTextContent("myshopify.com domain");
    await userEvent.type(within(shopify).getByLabelText("Store domain"), "Acme.myshopify.com");
    expect(install).toHaveAttribute(
      "href",
      `/api/apps/shopify/install?shop=acme.myshopify.com&websiteId=${SITE}`,
    );
  });

  it("explains the WooCommerce plugin connection", async () => {
    openPage(`/app/${SITE}/integrations`);
    const woo = await provider("woocommerce");
    await userEvent.click(within(woo).getByRole("button", { name: "Connect WooCommerce" }));
    expect(within(woo).getByText(/Install and activate the DataGoat plugin/)).toBeInTheDocument();
    expect(within(woo).getByLabelText("Website ID")).toHaveValue(SITE);
    expect(within(woo).getByRole("link", { name: "Create an API key" })).toHaveAttribute(
      "href",
      `/app/${SITE}/keys`,
    );
  });

  it("is read-only for viewers", async () => {
    openPage(`/app/${SITE}/integrations`, { role: "viewer" });
    const stripe = await provider("stripe");
    expect(within(stripe).queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Connect/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Connect/ })).not.toBeInTheDocument();
  });
});

describe("growth integrations", () => {
  it("saves the GitHub repository and disconnects", async () => {
    const log = recordRequests();
    openPage(`/app/${SITE}/integrations`);
    const card = await openRow("github");
    const repo = await within(card).findByLabelText("Repository");
    await userEvent.type(repo, "not a repo");
    await userEvent.click(within(card).getByRole("button", { name: "Save" }));
    expect(within(card).getByRole("alert")).toHaveTextContent("Use the owner/name form");
    await userEvent.clear(repo);
    await userEvent.type(repo, "acme/site");
    await userEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes(log, "PUT", "/integrations/github")[0]?.body).toEqual({ repo: "acme/site" }),
    );
    await userEvent.click(within(card).getByRole("button", { name: "Disconnect GitHub" }));
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Disconnect GitHub?" })).getByRole("button", {
        name: "Disconnect",
      }),
    );
    expect(await within(card).findByRole("link", { name: "Connect GitHub" })).toHaveAttribute(
      "href",
      `/api/connect/github/start?websiteId=${SITE}`,
    );
  });

  it("starts the Search Console and Meta Ads OAuth flows", async () => {
    openPage(`/app/${SITE}/integrations`);
    expect(
      await screen.findByRole("link", { name: "Connect Google Search Console" }),
    ).toHaveAttribute("href", `/api/connect/google-search-console/start?websiteId=${SITE}`);
    expect(screen.getByRole("link", { name: "Connect Meta Ads" })).toHaveAttribute(
      "href",
      `/api/connect/meta-ads/start?websiteId=${SITE}`,
    );
    await openRow("meta-ads");
    expect(screen.getByRole("figure", { name: "Meta URL parameters" })).toHaveTextContent(
      "utm_campaign={{campaign.id}}",
    );
  });

  it("connects GitHub with a repository and a pasted token when OAuth is not configured", async () => {
    server.use(
      http.get(`/api/v1/admin/websites/${SITE}/integrations/github`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            kind: "github",
            connected: false,
            status: null,
            settings: { webhookUrl: `https://datagoat.example/webhooks/github/${SITE}` },
            lastSyncedAt: null,
            lastError: null,
            oauthConfigured: false,
            connectUrl: null,
            hasCredentials: false,
          },
        }),
      ),
    );
    const log = recordRequests();
    openPage(`/app/${SITE}/integrations`);
    const card = await openRow("github");
    expect(await within(card).findByText(/Sign-in with GitHub is not set up/)).toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: "Connect GitHub" })).not.toBeInTheDocument();
    await userEvent.type(within(card).getByLabelText("Repository"), "acme/private-site");
    await userEvent.type(within(card).getByLabelText("Access token"), "short");
    await userEvent.click(within(card).getByRole("button", { name: "Save" }));
    expect(within(card).getByRole("alert")).toHaveTextContent("does not look like a GitHub token");
    await userEvent.clear(within(card).getByLabelText("Access token"));
    await userEvent.type(within(card).getByLabelText("Access token"), "github_pat_0123456789abc");
    await userEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes(log, "PUT", "/integrations/github")[0]?.body).toEqual({
        repo: "acme/private-site",
        accessToken: "github_pat_0123456789abc",
      }),
    );
    // Connected: the push webhook URL and its signing secret are ready to copy.
    expect(await within(card).findByLabelText("Webhook secret")).toHaveValue(
      "3f9a1c0d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
    );
    expect(within(card).getByLabelText("Push webhook URL")).toHaveValue(
      `https://datagoat.example/webhooks/github/${SITE}`,
    );
    expect(within(card).getByText("Connected")).toBeInTheDocument();
  });

  it("connects Meta Ads with a system-user token when OAuth is not configured", async () => {
    server.use(
      http.get(`/api/v1/admin/websites/${SITE}/integrations/meta-ads`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            kind: "meta_ads",
            connected: false,
            status: null,
            settings: {},
            lastSyncedAt: null,
            lastError: null,
            oauthConfigured: false,
            connectUrl: null,
            hasCredentials: false,
          },
        }),
      ),
    );
    const log = recordRequests();
    openPage(`/app/${SITE}/integrations`);
    const card = await openRow("meta-ads");
    expect(await within(card).findByText(/Facebook sign-in is not set up/)).toBeInTheDocument();
    await userEvent.type(
      within(card).getByRole("textbox", { name: "Ad account IDs" }),
      "act_42{Enter}",
    );
    await userEvent.type(
      within(card).getByRole("textbox", { name: "Campaign IDs" }),
      "1202{Enter}",
    );
    await userEvent.type(
      within(card).getByLabelText("Access token"),
      "EAAB-system-user-token-0123456789",
    );
    await userEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(writes(log, "PUT", "/integrations/meta-ads")[0]?.body).toEqual({
        adAccountIds: ["act_42"],
        campaignIds: ["1202"],
        accessToken: "EAAB-system-user-token-0123456789",
      }),
    );
  });

  it("keeps the copy button outside the wrapped Meta UTM template", async () => {
    openPage(`/app/${SITE}/integrations`);
    await openRow("meta-ads");
    const figure = await screen.findByRole("figure", { name: "Meta URL parameters" });
    const pre = figure.querySelector("pre") as HTMLElement;
    expect(pre).toHaveTextContent("utm_source=meta&utm_medium=paid-social");
    expect(pre.querySelector("button")).toBeNull();
    expect(pre.className).toContain("whitespace-pre-wrap");
    expect(within(figure).getByRole("button", { name: "Copy Meta URL parameters" })).toBeVisible();
  });

  it("edits X and Reddit keywords and link-in-bio handles", async () => {
    const log = recordRequests();
    openPage(`/app/${SITE}/integrations`);
    await openRow("x");
    const keywords = await screen.findByRole("textbox", { name: "Mention keywords" });
    await userEvent.type(keywords, "abc{Enter}");
    expect(screen.getByText("Keywords are 4 to 15 characters.")).toBeInTheDocument();
    await userEvent.clear(keywords);
    await userEvent.type(keywords, "DataGoat{Enter}");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Link-in-bio handles" }),
      "goatdev{Enter}",
    );
    const card = keywords.closest("section") as HTMLElement;
    await userEvent.click(within(card).getByRole("button", { name: "Save" }));
    // The saved body keeps any handles already configured and adds the new one.
    await waitFor(() => {
      const body = writes(log, "PUT", "/integrations/x")[0]?.body as
        | { keywords: string[]; handles: string[] }
        | undefined;
      expect(body?.keywords).toEqual(["DataGoat"]);
      expect(body?.handles).toContain("@goatdev");
    });
    expect(await within(card).findByText("Saved")).toBeInTheDocument();
  });
});
