/**
 * W7 — Agents: the MCP server (streamable HTTP at /mcp, alias /api/mcp), the OAuth 2.1
 * authorization server for MCP clients (PKCE S256, dynamic registration, client metadata
 * documents, rotating refresh tokens) and connected-apps management. The `cli/` package is the
 * other half of W7.
 *
 * MCP tools call the Worker's own /api/v1 handlers in-process (dispatch.ts), authenticated by a
 * one-time internal Bearer registered with `registerBearerResolver()`. OAuth access tokens are
 * accepted only at the MCP endpoints, never on /api/v1.
 */
import { Hono } from "hono";
import type { JobDefinition } from "../jobs/registry";
import type { AppEnv } from "../types";
import { registerInternalResolver } from "./dispatch";
import { mcpCleanupJob } from "./jobs";
import { connectionRoutes } from "./oauth/connections";
import { oauthRoutes } from "./oauth/routes";
import { handleMcp } from "./server";

registerInternalResolver();

export const mcpRoutes = new Hono<AppEnv>();

for (const path of ["/mcp", "/api/mcp"]) {
  mcpRoutes.on(["GET", "POST", "DELETE", "OPTIONS"], path, handleMcp);
}
mcpRoutes.route("/", oauthRoutes);
mcpRoutes.route("/", connectionRoutes);

export const mcpJobs: JobDefinition[] = [mcpCleanupJob];
