/** W2 — Server-side events (DataFast `POST|DELETE /api/v1/goals`, `POST /api/v1/identify`). */
import { Hono } from "hono";
import { stubRoutes } from "../../../lib/stub";
import type { AppEnv } from "../../../types";

export const ingestApiRoutes = new Hono<AppEnv>();

stubRoutes(ingestApiRoutes, "W2", [
  ["POST", "/api/v1/goals"],
  ["DELETE", "/api/v1/goals"],
  ["POST", "/api/v1/identify"],
]);
