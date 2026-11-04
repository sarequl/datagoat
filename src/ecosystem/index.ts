/**
 * W8 — Ecosystem: server routes for the apps and SDKs in packages/* and apps/*: the mobile app
 * (sign-in that mints an is_mobile df_ key, push devices), the Shopify app install flow and the
 * WooCommerce plugin connect flow (they create provider_connections rows used by W3's adapters).
 */
import { Hono } from "hono";
import type { JobDefinition } from "../jobs/registry";
import { stubRoutes } from "../lib/stub";
import type { AppEnv } from "../types";

export const ecosystemRoutes = new Hono<AppEnv>();

stubRoutes(ecosystemRoutes, "W8", [
  ["POST", "/api/v1/mobile/session"],
  ["POST", "/api/v1/mobile/devices"],
  ["DELETE", "/api/v1/mobile/devices/:deviceId"],
  ["GET", "/api/apps/shopify/install"],
  ["GET", "/api/apps/shopify/callback"],
  ["POST", "/api/apps/shopify/webhooks"],
  ["POST", "/api/apps/woocommerce/connect"],
]);

export const ecosystemJobs: JobDefinition[] = [];
