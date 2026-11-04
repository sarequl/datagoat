/**
 * W6 — Growth: alerts and weekly digest, AI-crawler bot traffic (ingest + API + settings + token),
 * X/Reddit mentions and X link attribution, GitHub commit markers, Google Search Console,
 * Meta Ads spend/ROAS, Plausible import, and the OAuth connect flows for those integrations.
 */
import { Hono } from "hono";
import type { JobDefinition } from "../jobs/registry";
import { stubRoutes } from "../lib/stub";
import type { AppEnv } from "../types";

export const growthRoutes = new Hono<AppEnv>();

const W = "/api/v1/admin/websites/:websiteId";
const INTEGRATIONS = ["github", "google-search-console", "meta-ads", "x"] as const;

stubRoutes(growthRoutes, "W6", [
  // Bot traffic (DataFast)
  ["POST", "/api/ai-crawls"],
  ["GET", "/api/v1/analytics/bot-traffic"],
  ["GET", "/api/v1/analytics/bot-traffic/pages"],
  ["GET", "/api/v1/admin/bot-traffic/usage"],
  ["GET", `${W}/bot-traffic/settings`],
  ["PATCH", `${W}/bot-traffic/settings`],
  ["GET", `${W}/bot-traffic/token`],
  ["POST", `${W}/bot-traffic/token`],
  ["PUT", `${W}/bot-traffic/token`],
  ["DELETE", `${W}/bot-traffic/token`],
  // Alerts (DataFast) + test send (DataGoat)
  ["GET", `${W}/alerts`],
  ["POST", `${W}/alerts`],
  ["GET", `${W}/alerts/history`],
  ["PUT", `${W}/alerts/:alertId`],
  ["DELETE", `${W}/alerts/:alertId`],
  ["POST", `${W}/alerts/:alertId/test`],
  // Mentions (DataFast) and DataGoat growth reads
  ["GET", "/api/v1/mentions"],
  ["GET", "/api/v1/x/links"],
  ["GET", "/api/v1/github/commits"],
  ["GET", "/api/v1/search-console"],
  ["GET", "/api/v1/ads/campaigns"],
  ["GET", "/api/v1/ads/summary"],
  // Growth integrations
  ...INTEGRATIONS.flatMap(
    (k) =>
      [
        ["GET", `${W}/integrations/${k}`],
        ["PUT", `${W}/integrations/${k}`],
        ["DELETE", `${W}/integrations/${k}`],
      ] as const,
  ),
  ...INTEGRATIONS.flatMap(
    (k) =>
      [
        ["GET", `/api/connect/${k}/start`],
        ["GET", `/api/connect/${k}/callback`],
      ] as const,
  ),
  ["POST", "/webhooks/github/:siteId"],
  // Plausible import
  ["GET", `${W}/imports`],
  ["POST", `${W}/imports`],
  ["GET", `${W}/imports/:importId`],
  ["DELETE", `${W}/imports/:importId`],
  ["POST", `${W}/imports/:importId/rows`],
  ["POST", `${W}/imports/:importId/complete`],
]);

/** e.g. "alerts.evaluate" (minute), "alerts.deliver" (minute), "digest.weekly", "mentions.sync", "gsc.sync". */
export const growthJobs: JobDefinition[] = [];
