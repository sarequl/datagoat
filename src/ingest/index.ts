/**
 * W1 — Tracker & ingest. Owns POST /api/events (DataFast-compatible collector), bot filtering,
 * identity (cookie / cookieless / consent), enrichment (channels.ts, ua.ts, geo.ts) and the
 * single-batch write of event + session + visitor (plan §8).
 *
 * Hot path rules: no KV, one db.batch(), respond 200 immediately and write in ctx.waitUntil(),
 * rate limit with INGEST_IP_LIMITER (key `${siteId}:${ip}`) and INGEST_SITE_LIMITER (key siteId).
 */
import { Hono } from "hono";
import type { JobDefinition } from "../jobs/registry";
import { stubRoutes } from "../lib/stub";
import type { AppEnv } from "../types";

export const ingestRoutes = new Hono<AppEnv>();

stubRoutes(ingestRoutes, "W1", [
  ["POST", "/api/events"],
  ["OPTIONS", "/api/events"],
]);

/** e.g. { name: "ingest.rotate-salts", schedule: { every: "day", at: "00:00" }, run } */
export const ingestJobs: JobDefinition[] = [];
