/**
 * Payment providers on the Integrations page: connect fields (docs/api/contract.md §10), client-side
 * checks that mirror the server's, and the setup steps shown next to the form.
 */
import type { PaymentProvider } from "../../../../../shared/api-types";

export interface ProviderField {
  name: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  optional?: boolean;
  hint?: string;
  validate?: (value: string) => string | null;
}

export interface ProviderDef {
  id: PaymentProvider;
  name: string;
  description: string;
  /** credentials: a form posted to …/integrations/<id>; shopify/woocommerce: app installs. */
  connect: "credentials" | "shopify" | "woocommerce";
  fields: ProviderField[];
  steps: string[];
  /** Show the webhook URL (providers whose connect body takes a webhook secret). */
  webhook?: boolean;
  /** Supports a manual re-sync (PATCH). */
  resync: boolean;
}

const required = (label: string) => (v: string) => (v.trim() ? null : `${label} is required.`);

export const PROVIDERS: readonly ProviderDef[] = [
  {
    id: "stripe",
    name: "Stripe",
    description: "Checkout, Payment Links, invoices and subscriptions, read with a restricted key.",
    connect: "credentials",
    resync: true,
    fields: [
      {
        name: "stripeRak",
        label: "Restricted API key",
        placeholder: "rk_live_…",
        secret: true,
        validate: (v) =>
          /^rk_(live|test)_\w+/.test(v.trim())
            ? null
            : v.trim().startsWith("sk_") || v.trim().startsWith("pk_")
              ? "Use a restricted key (rk_…). Secret (sk_) and publishable (pk_) keys are refused for safety."
              : "A Stripe restricted key starts with rk_live_ or rk_test_.",
      },
    ],
    steps: [
      "In Stripe, open Developers > API keys and choose Create restricted key.",
      "Name it DataGoat. Give Read access to Charges, Checkout Sessions, Customers, Events, Invoices, Payment Intents and Subscriptions. Leave everything else at None.",
      "Create the key, copy it and paste it below. DataGoat checks Stripe for new payments every minute and imports past payments in the background.",
      "For exact attribution, put the visitor's datafast_visitor_id cookie in the Checkout Session metadata. Payment Links work when the success URL includes ?session_id={CHECKOUT_SESSION_ID}.",
    ],
  },
  {
    id: "lemonsqueezy",
    name: "Lemon Squeezy",
    description: "Orders and subscriptions from your Lemon Squeezy store.",
    connect: "credentials",
    resync: true,
    fields: [
      {
        name: "lemonsqueezyApiKey",
        label: "API key",
        secret: true,
        validate: required("The API key"),
      },
      {
        name: "lemonsqueezyStoreId",
        label: "Store ID",
        placeholder: "12345",
        validate: (v) => (/^\d+$/.test(v.trim()) ? null : "The store ID is a number."),
      },
    ],
    steps: [
      "In Lemon Squeezy, open Settings > API and create an API key named DataGoat.",
      "Find the store ID under Settings > Stores (the number next to the store name).",
      "Pass checkout[custom][datafast_visitor_id] when you create checkouts; payment links work when the redirect URL includes ?order_id=[order_id].",
    ],
  },
  {
    id: "polar",
    name: "Polar",
    description: "Orders and subscriptions from your Polar organization.",
    connect: "credentials",
    resync: true,
    fields: [
      {
        name: "polarAccessToken",
        label: "Organization access token",
        placeholder: "polar_oat_…",
        secret: true,
        validate: required("The access token"),
      },
      {
        name: "polarOrgId",
        label: "Organization ID",
        validate: required("The organization ID"),
      },
    ],
    steps: [
      "In Polar, open Settings > Access Tokens and create a token with the orders:read and subscriptions:read scopes. Add checkouts:read for checkout links, organizations:read to show the organization name, and webhooks:write so DataGoat can create the webhook for you.",
      "Copy the organization ID from Settings > General.",
      "Add datafast_visitor_id to checkout metadata, or use checkout links whose success URL includes ?checkout_id={CHECKOUT_ID}.",
    ],
  },
  {
    id: "paddle",
    name: "Paddle",
    description: "Paddle Billing transactions and subscriptions.",
    connect: "credentials",
    resync: true,
    fields: [
      {
        name: "paddleApiKey",
        label: "API key",
        placeholder: "pdl_live_…",
        secret: true,
        validate: (v) =>
          v.trim().startsWith("pdl_live_") ? null : "A live Paddle API key starts with pdl_live_.",
      },
    ],
    steps: [
      "In Paddle, open Developer tools > Authentication and create an API key with read access to transactions, customers and subscriptions.",
      "Paste it below. Paddle API keys can expire; DataGoat shows the expiry date so you can replace the key in time.",
      "Pass datafast_visitor_id in the checkout's customData for exact attribution.",
    ],
  },
  {
    id: "dodo",
    name: "Dodo Payments",
    description: "Payments and subscriptions from Dodo Payments.",
    connect: "credentials",
    resync: true,
    webhook: true,
    fields: [
      { name: "apiKey", label: "API key", secret: true, validate: required("The API key") },
      {
        name: "webhookSecret",
        label: "Webhook signing secret (optional)",
        secret: true,
        optional: true,
        hint: "For instant sale alerts. Without it DataGoat polls for payments.",
      },
    ],
    steps: [
      "In Dodo Payments, open Developer > API keys and create a key.",
      "Optional: add a webhook endpoint with the URL below and paste its signing secret.",
      "Put datafast_visitor_id in the payment or subscription metadata for exact attribution.",
    ],
  },
  {
    id: "creem",
    name: "Creem",
    description: "Checkouts and subscriptions from Creem.",
    connect: "credentials",
    resync: true,
    webhook: true,
    fields: [
      { name: "apiKey", label: "API key", secret: true, validate: required("The API key") },
      {
        name: "webhookSecret",
        label: "Webhook signing secret (optional)",
        secret: true,
        optional: true,
        hint: "For instant sale alerts. Without it DataGoat polls for payments.",
      },
    ],
    steps: [
      "In Creem, open Developers and copy your API key.",
      "Optional: add a webhook with the URL below and paste its signing secret.",
      "Pass datafast_visitor_id in the checkout metadata for exact attribution.",
    ],
  },
  {
    id: "shopify",
    name: "Shopify",
    description: "Storefront tracking and orders through the DataGoat Shopify app.",
    connect: "shopify",
    resync: false,
    fields: [
      {
        name: "shop",
        label: "Store domain",
        placeholder: "your-store.myshopify.com",
        validate: (v) =>
          /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(v.trim())
            ? null
            : "Enter your store's myshopify.com domain.",
      },
    ],
    steps: [
      "Enter your store's myshopify.com domain and choose Install app. Shopify asks you to approve the DataGoat app.",
      "The app adds tracking to your storefront and sends orders to DataGoat, so no manual script is needed.",
      "The app must be configured for this DataGoat instance first (see docs/settings.md).",
    ],
  },
  {
    id: "woocommerce",
    name: "WooCommerce",
    description: "Orders from WooCommerce through the DataGoat WordPress plugin.",
    connect: "woocommerce",
    resync: false,
    fields: [],
    steps: [
      "Install and activate the DataGoat plugin on your WordPress site (packages/wordpress-plugin).",
      "Create a website API key on the API keys page.",
      "In WordPress, open Settings > DataGoat, enter this DataGoat URL, the website ID and the API key, then choose Connect WooCommerce.",
      "The plugin adds the tracking script and reports orders, refunds and renewals.",
    ],
  },
];

export function providerById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
