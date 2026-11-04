/**
 * THE route table. Every area exposes one Hono router whose routes use absolute paths, and is
 * mounted here at "/". Areas never edit each other's routers; adding an area is one line.
 * Shared middleware for API prefixes is applied here, before any router.
 *
 * Ownership (docs/CONTRACTS.md):
 *   F0  /api/health, /api/setup, /api/auth/*, /api/v1/admin/{account,access-tokens,websites[/:id],
 *       websites/:id/apikeys*, websites/:id/team*}
 *   W1  /api/events
 *   W2  /api/v1/analytics/*, /api/v1/visitors*, /api/v1/goals, /api/v1/identify,
 *       /api/v1/admin/websites/:id/{goals*,funnels*,notes*,segments*,share,usage}, /share/*, /api/share/*
 *   W3  /api/v1/payments, /api/v1/analytics/revenue, /api/v1/admin/websites/:id/integrations[/<provider>],
 *       /webhooks/<provider>/:siteId
 *   W6  /api/ai-crawls, /api/v1/analytics/bot-traffic*, /api/v1/admin/bot-traffic/usage,
 *       /api/v1/admin/websites/:id/{bot-traffic/*,alerts*,imports*,integrations/<growth>},
 *       /api/v1/{mentions,x,github,search-console,ads}*, /api/connect/*, /webhooks/github/:siteId
 *   W7  /mcp, /api/mcp, /oauth/*, /.well-known/*, /api/v1/admin/oauth/*
 *   W8  /api/v1/mobile/*, /api/apps/*
 */
import type { Hono } from "hono";
import { accountAdminRoutes } from "./api/v1/account";
import { adminRoutes } from "./api/v1/admin";
import { analyticsRoutes } from "./api/v1/analytics";
import { ingestApiRoutes } from "./api/v1/ingest-api";
import { publicRoutes } from "./api/v1/public";
import { visitorsRoutes } from "./api/v1/visitors";
import { authenticate, sameOriginGuard } from "./auth/middleware";
import { apiRateLimit } from "./auth/rate-limit";
import { authRoutes } from "./auth/routes";
import { MIGRATIONS } from "./db/migrations.generated";
import { ecosystemRoutes } from "./ecosystem";
import { growthRoutes } from "./growth";
import { ingestRoutes } from "./ingest";
import { mcpRoutes } from "./mcp";
import { providerRoutes } from "./providers";
import { setupRoutes } from "./setup";
import type { AppEnv } from "./types";

export function mountRoutes(app: Hono<AppEnv>): void {
  // Shared middleware. /api/v1/* accepts the session cookie or a Bearer credential.
  app.use("/api/v1/*", sameOriginGuard, authenticate, apiRateLimit);
  app.use("/api/auth/*", sameOriginGuard);
  app.use("/api/setup", sameOriginGuard);

  // F0 — foundation
  app.get("/api/health", (c) =>
    c.json({
      status: "success",
      data: { ok: true, schema: "current", migrations: MIGRATIONS.length },
    }),
  );
  app.route("/api/setup", setupRoutes);
  app.route("/api/auth", authRoutes);
  app.route("/", accountAdminRoutes);

  // W1 — tracker & ingest
  app.route("/", ingestRoutes);

  // W2 — analytics API, visitors, server-side events, website admin resources, share links
  app.route("/", analyticsRoutes);
  app.route("/", visitorsRoutes);
  app.route("/", ingestApiRoutes);
  app.route("/", adminRoutes);
  app.route("/", publicRoutes);

  // W3 — revenue
  app.route("/", providerRoutes);

  // W6 — growth
  app.route("/", growthRoutes);

  // W7 — MCP, OAuth
  app.route("/", mcpRoutes);

  // W8 — ecosystem
  app.route("/", ecosystemRoutes);
}
