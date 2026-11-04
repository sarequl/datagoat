/**
 * W3 — Revenue: payment provider adapters (stripe, polar, lemonsqueezy, paddle, dodo, creem,
 * shopify, woocommerce), DataFast's Payments API, provider webhooks, integration admin routes,
 * revenue analytics, and the sync / hint-resolution / FX jobs (plan §10).
 *
 * Webhook paths are explicit per provider (no `/webhooks/:provider` catch-all) because W6 owns
 * `/webhooks/github/:siteId`. Integration paths are explicit for the same reason (W6 owns
 * `/integrations/github|google-search-console|meta-ads|x`).
 *
 * Module map: types.ts (adapter interface), engine.ts (attribution + storage), lifecycle.ts
 * (subscription goals), fx.ts (ECB rates), connections.ts (encrypted credentials), adapters/*,
 * payments-api.ts, integrations-api.ts, webhooks.ts, revenue-api.ts, jobs.ts, hints.ts (W1 hooks).
 */
import { Hono } from "hono";
import type { JobDefinition } from "../jobs/registry";
import type { AppEnv } from "../types";
import { integrationRoutes } from "./integrations-api";
import { providerJobDefinitions } from "./jobs";
import { paymentsRoutes } from "./payments-api";
import { revenueRoutes } from "./revenue-api";
import { webhookRoutes } from "./webhooks";

export const providerRoutes = new Hono<AppEnv>();

providerRoutes.route("/", paymentsRoutes);
providerRoutes.route("/", revenueRoutes);
providerRoutes.route("/", integrationRoutes);
providerRoutes.route("/", webhookRoutes);

export const providerJobs: JobDefinition[] = [...providerJobDefinitions];

export { saveConnection } from "./connections";
export { attributeByEmail, hintFromExtraData, paymentHintStatement } from "./hints";
export { processWebhook } from "./webhooks";
