/**
 * W7 — Agents: the MCP server (streamable HTTP at /mcp, alias /api/mcp), the OAuth 2.1
 * authorization server for MCP clients (PKCE S256, dynamic registration, rotating refresh
 * tokens), connected-apps management, and the `cli/` package. OAuth access tokens plug into the
 * shared auth middleware with `registerBearerResolver()` (src/auth/credentials.ts).
 */
import { Hono } from "hono";
import type { JobDefinition } from "../jobs/registry";
import { stubRoutes } from "../lib/stub";
import type { AppEnv } from "../types";

export const mcpRoutes = new Hono<AppEnv>();

stubRoutes(mcpRoutes, "W7", [
  ["POST", "/mcp"],
  ["GET", "/mcp"],
  ["DELETE", "/mcp"],
  ["POST", "/api/mcp"],
  ["GET", "/api/mcp"],
  ["DELETE", "/api/mcp"],
  ["GET", "/.well-known/oauth-authorization-server"],
  ["GET", "/.well-known/oauth-protected-resource"],
  ["GET", "/.well-known/oauth-protected-resource/mcp"],
  ["GET", "/oauth/authorize"],
  ["POST", "/oauth/authorize"],
  ["GET", "/oauth/consent"],
  ["POST", "/oauth/token"],
  ["POST", "/oauth/register"],
  ["POST", "/oauth/revoke"],
  ["GET", "/api/v1/admin/oauth/connections"],
  ["DELETE", "/api/v1/admin/oauth/connections/:connectionId"],
]);

/** e.g. "mcp.cleanup" (daily): expired codes, tokens, connections. */
export const mcpJobs: JobDefinition[] = [];
