/**
 * W2 — Public share links. `GET /share/:token` serves the dashboard shell for a valid token
 * (via env.ASSETS) and 404s otherwise; `/api/share/:token/*` serves read-only, PII-free analytics
 * for the shared website (same response shapes as /api/v1/analytics/*).
 */
import { Hono } from "hono";
import { stubRoutes } from "../../../lib/stub";
import type { AppEnv } from "../../../types";

export const publicRoutes = new Hono<AppEnv>();

stubRoutes(publicRoutes, "W2", [
  ["GET", "/share/:token"],
  ["GET", "/api/share/:token"],
  ["GET", "/api/share/:token/analytics/:endpoint"],
]);
