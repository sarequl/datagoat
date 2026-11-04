/** W2 — Visitors API (DataFast `/api/v1/visitors`, `/api/v1/visitors/{visitorId}`). */
import { Hono } from "hono";
import { stubRoutes } from "../../../lib/stub";
import type { AppEnv } from "../../../types";

export const visitorsRoutes = new Hono<AppEnv>();

stubRoutes(visitorsRoutes, "W2", [
  ["GET", "/api/v1/visitors"],
  ["GET", "/api/v1/visitors/:visitorId"],
]);
