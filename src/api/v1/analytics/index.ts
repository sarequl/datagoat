/**
 * W2 — Analytics API (DataFast `/api/v1/analytics/*`) plus DataGoat breakdowns used by the
 * dashboard (channels, entry-pages, exit-pages, heatmap). All routes:
 * `requireSiteAccess("analytics:read")`, filters via src/lib/filters.ts, metrics via
 * src/lib/metrics.ts, computation in src/query. See docs/api/contract.md.
 * `/api/v1/analytics/bot-traffic*` belongs to W6 and `/api/v1/analytics/revenue` to W3.
 */
import { Hono } from "hono";
import { getAccess } from "../../../auth/context";
import { requireSiteAccess } from "../../../auth/middleware";
import type { AppEnv } from "../../../types";
import * as h from "./handlers";

export const analyticsRoutes = new Hono<AppEnv>();

const ROUTES: Array<[string, h.AnalyticsHandler]> = [
  ["/api/v1/analytics/overview", h.overview],
  ["/api/v1/analytics/timeseries", h.timeseries],
  ["/api/v1/analytics/metadata", h.metadata],
  ["/api/v1/analytics/realtime", h.realtime],
  ["/api/v1/analytics/realtime/map", h.realtimeMapHandler],
  ["/api/v1/analytics/realtime/replay", h.realtimeReplayHandler],
  ["/api/v1/analytics/pages", h.pages],
  ["/api/v1/analytics/entry-pages", h.entryPages],
  ["/api/v1/analytics/exit-pages", h.exitPages],
  ["/api/v1/analytics/exit-clicks", h.exitClicksHandler],
  ["/api/v1/analytics/referrers", h.referrers],
  ["/api/v1/analytics/channels", h.channels],
  ["/api/v1/analytics/campaigns", h.campaigns],
  ["/api/v1/analytics/countries", h.countries],
  ["/api/v1/analytics/regions", h.regions],
  ["/api/v1/analytics/cities", h.cities],
  ["/api/v1/analytics/devices", h.devices],
  ["/api/v1/analytics/browsers", h.browsers],
  ["/api/v1/analytics/operating-systems", h.operatingSystems],
  ["/api/v1/analytics/hostnames", h.hostnames],
  ["/api/v1/analytics/goals", h.goals],
  ["/api/v1/analytics/goals/properties", h.goalPropertiesHandler],
  ["/api/v1/analytics/funnels/:funnelId", h.funnelResults],
  ["/api/v1/analytics/heatmap", h.heatmap],
];

for (const [path, handler] of ROUTES) {
  analyticsRoutes.get(path, requireSiteAccess("analytics:read"), (c) =>
    handler(c, getAccess(c).site, { publicView: false, showRevenue: true }),
  );
}
