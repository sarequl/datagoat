/**
 * W2 — Analytics API (DataFast `/api/v1/analytics/*`) plus DataGoat breakdowns used by the
 * dashboard (channels, entry-pages, exit-pages). All routes: `requireSiteAccess("analytics:read")`,
 * filters via src/lib/filters.ts, metrics via src/lib/metrics.ts. See docs/api/contract.md.
 * `/api/v1/analytics/bot-traffic*` belongs to W6 and `/api/v1/analytics/revenue` to W3.
 */
import { Hono } from "hono";
import { stubRoutes } from "../../../lib/stub";
import type { AppEnv } from "../../../types";

export const analyticsRoutes = new Hono<AppEnv>();

stubRoutes(analyticsRoutes, "W2", [
  ["GET", "/api/v1/analytics/overview"],
  ["GET", "/api/v1/analytics/timeseries"],
  ["GET", "/api/v1/analytics/metadata"],
  ["GET", "/api/v1/analytics/realtime"],
  ["GET", "/api/v1/analytics/realtime/map"],
  ["GET", "/api/v1/analytics/pages"],
  ["GET", "/api/v1/analytics/entry-pages"],
  ["GET", "/api/v1/analytics/exit-pages"],
  ["GET", "/api/v1/analytics/exit-clicks"],
  ["GET", "/api/v1/analytics/referrers"],
  ["GET", "/api/v1/analytics/channels"],
  ["GET", "/api/v1/analytics/campaigns"],
  ["GET", "/api/v1/analytics/countries"],
  ["GET", "/api/v1/analytics/regions"],
  ["GET", "/api/v1/analytics/cities"],
  ["GET", "/api/v1/analytics/devices"],
  ["GET", "/api/v1/analytics/browsers"],
  ["GET", "/api/v1/analytics/operating-systems"],
  ["GET", "/api/v1/analytics/hostnames"],
  ["GET", "/api/v1/analytics/goals"],
  ["GET", "/api/v1/analytics/goals/properties"],
  ["GET", "/api/v1/analytics/funnels/:funnelId"],
]);
