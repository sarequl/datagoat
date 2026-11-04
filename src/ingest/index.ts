/**
 * W1 — Tracker & ingest. Owns POST /api/events (DataFast-compatible collector), bot filtering,
 * identity (cookie / cookieless / consent), enrichment (channels.ts, ua.ts, geo.ts) and the
 * single-batch write of event + session + visitor (plan §8). See handler.ts for the pipeline.
 *
 * Hot path rules: no KV, one db.batch(), respond 200 immediately and write in ctx.waitUntil(),
 * rate limit with INGEST_IP_LIMITER (key `${siteId}:${ip}`) and INGEST_SITE_LIMITER (key siteId).
 */
import { Hono } from "hono";
import type { JobDefinition } from "../jobs/registry";
import type { AppEnv } from "../types";
import { handleEvent, preflight } from "./handler";
import { rotateSaltsJob } from "./salts";

export const ingestRoutes = new Hono<AppEnv>();

ingestRoutes.options("/api/events", () => preflight());
ingestRoutes.post("/api/events", (c) =>
  handleEvent(c.req.raw, { env: c.env, waitUntil: (p) => c.executionCtx.waitUntil(p) }),
);

export const ingestJobs: JobDefinition[] = [rotateSaltsJob];
