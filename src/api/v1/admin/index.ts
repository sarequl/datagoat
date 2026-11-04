/**
 * W2 — Website admin resources under /api/v1/admin/websites/:websiteId: tracked goals, goal
 * customizations, funnels, notes and alert rules + history (DataFast), and DataGoat's segments,
 * share link and usage. Website/key/team/token routes live in ../account (F0); integrations in
 * src/providers (W3); alert evaluation/delivery, the alert test send, bot traffic, imports and
 * growth integrations in src/growth (W6).
 */
import { Hono } from "hono";
import type { JobDefinition } from "../../../jobs/registry";
import { QUERY_JOBS } from "../../../query/jobs";
import type { AppEnv } from "../../../types";
import { alertRoutes } from "./alerts";
import { funnelAdminRoutes } from "./funnels";
import { goalAdminRoutes } from "./goals";
import { noteRoutes } from "./notes";
import { segmentRoutes } from "./segments";
import { shareRoutes } from "./share";

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.route("/", goalAdminRoutes);
adminRoutes.route("/", funnelAdminRoutes);
adminRoutes.route("/", noteRoutes);
adminRoutes.route("/", segmentRoutes);
adminRoutes.route("/", shareRoutes);
adminRoutes.route("/", alertRoutes);

/** Rollups, retention pruning and prediction training (src/query/jobs). */
export const queryJobs: JobDefinition[] = [...QUERY_JOBS];
