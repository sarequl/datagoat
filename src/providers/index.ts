/**
 * W3 — Revenue: payment provider adapters (stripe, polar, lemonsqueezy, paddle, dodo, creem,
 * shopify, woocommerce), DataFast's Payments API, provider webhooks, integration admin routes,
 * revenue analytics, and the sync / hint-resolution / FX jobs (plan §10).
 *
 * Webhook paths are explicit per provider (no `/webhooks/:provider` catch-all) because W6 owns
 * `/webhooks/github/:siteId`. Integration paths are explicit for the same reason (W6 owns
 * `/integrations/github|google-search-console|meta-ads|x`).
 */
import { Hono } from "hono";
import type { JobDefinition } from "../jobs/registry";
import { type Method, stubRoutes } from "../lib/stub";
import type { AppEnv } from "../types";

export const providerRoutes = new Hono<AppEnv>();

const I = "/api/v1/admin/websites/:websiteId/integrations";
const PROVIDERS = [
  "stripe",
  "polar",
  "lemonsqueezy",
  "paddle",
  "dodo",
  "creem",
  "shopify",
  "woocommerce",
] as const;

stubRoutes(providerRoutes, "W3", [
  ["POST", "/api/v1/payments"],
  ["DELETE", "/api/v1/payments"],
  ["GET", "/api/v1/payments"],
  ["GET", "/api/v1/analytics/revenue"],
  ["GET", I],
  ...(["stripe", "polar", "lemonsqueezy", "paddle", "dodo", "creem"] as const).map(
    (p) => ["POST", `${I}/${p}`] as readonly [Method, string],
  ),
  ...PROVIDERS.map((p) => ["DELETE", `${I}/${p}`] as readonly [Method, string]),
  ...PROVIDERS.map((p) => ["PATCH", `${I}/${p}`] as readonly [Method, string]),
  ...PROVIDERS.map((p) => ["POST", `/webhooks/${p}/:siteId`] as readonly [Method, string]),
]);

/** e.g. provider sync ("providers.sync", every minute), "providers.resolve-hints", "providers.fx" (daily). */
export const providerJobs: JobDefinition[] = [];
