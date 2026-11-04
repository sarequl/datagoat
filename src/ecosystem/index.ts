/**
 * W8 — Ecosystem: server routes for the apps and SDKs in packages/* and apps/*: the mobile app
 * (sign-in that mints a read-only mobile dft_ token, push devices, sale/alert pushes), the Shopify
 * app (connect, OAuth install, lifecycle webhooks, custom pixel) and the WooCommerce connect flow.
 * Shopify and WooCommerce create provider_connections rows used by W3's adapters.
 */
import { Hono } from "hono";
import type { JobDefinition } from "../jobs/registry";
import type { AppEnv } from "../types";
import { mobileRoutes } from "./mobile";
import { pushJob } from "./push";
import { shopifyRoutes } from "./shopify";
import { woocommerceRoutes } from "./woocommerce";

export const ecosystemRoutes = new Hono<AppEnv>();

ecosystemRoutes.route("/", mobileRoutes);
ecosystemRoutes.route("/", shopifyRoutes);
ecosystemRoutes.route("/", woocommerceRoutes);

export const ecosystemJobs: JobDefinition[] = [pushJob];
