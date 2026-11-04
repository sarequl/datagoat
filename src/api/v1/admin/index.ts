/**
 * W2 — Website admin resources under /api/v1/admin/websites/:websiteId: tracked goals, goal
 * customizations, funnels, notes (DataFast), and DataGoat's segments, share link and usage.
 * Website/key/team/token routes live in ../account (F0); integrations in src/providers (W3);
 * alerts, bot traffic, imports and growth integrations in src/growth (W6).
 */
import { Hono } from "hono";
import type { JobDefinition } from "../../../jobs/registry";
import { stubRoutes } from "../../../lib/stub";
import type { AppEnv } from "../../../types";

export const adminRoutes = new Hono<AppEnv>();

const W = "/api/v1/admin/websites/:websiteId";

stubRoutes(adminRoutes, "W2", [
  ["GET", `${W}/goals`],
  ["GET", `${W}/goals/customizations`],
  ["PATCH", `${W}/goals/customizations`],
  ["DELETE", `${W}/goals/customizations`],
  ["GET", `${W}/funnels`],
  ["POST", `${W}/funnels`],
  ["PUT", `${W}/funnels/:funnelId`],
  ["DELETE", `${W}/funnels/:funnelId`],
  ["GET", `${W}/notes`],
  ["POST", `${W}/notes`],
  ["PUT", `${W}/notes/:noteId`],
  ["DELETE", `${W}/notes/:noteId`],
  ["GET", `${W}/segments`],
  ["POST", `${W}/segments`],
  ["PUT", `${W}/segments/:segmentId`],
  ["DELETE", `${W}/segments/:segmentId`],
  ["GET", `${W}/share`],
  ["POST", `${W}/share`],
  ["DELETE", `${W}/share`],
  ["GET", `${W}/usage`],
]);

/** Rollups, retention pruning, prediction models: e.g. "query.rollups", "query.retention". */
export const queryJobs: JobDefinition[] = [];
