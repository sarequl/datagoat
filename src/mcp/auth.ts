/**
 * Who is calling `/mcp`: a `df_` website key or `dft_` account token (resolved exactly as on
 * `/api/v1`), or an MCP OAuth access token (`dgo_`). OAuth access tokens are accepted only here;
 * `/api/v1` never resolves them.
 */
import type { AuthContext } from "../auth/context";
import { isApiKeySecret, resolveBearer } from "../auth/credentials";
import { log } from "../lib/log";
import { permissionsOfScopes } from "./oauth/scopes";
import {
  ACCESS_PREFIX,
  type Connection,
  type ConnectionRow,
  connectionIsLive,
  hashToken,
  rowToConnection,
} from "./oauth/store";

export interface McpCaller {
  /** Base identity: the token's own context, or the OAuth connection's. */
  auth: AuthContext;
  /** Set for OAuth callers. */
  connection: Connection | null;
  /** OAuth scopes of the connection (empty for API tokens). */
  oauthScopes: string[];
}

/** The MCP endpoint paths; `/api/mcp` is DataFast's path, kept as an alias. */
export const MCP_PATHS = ["/mcp", "/api/mcp"] as const;

export function mcpResources(origin: string): string[] {
  return MCP_PATHS.map((p) => `${origin}${p}`);
}

export function protectedResourceMetadataUrl(origin: string, path: string): string {
  return `${origin}/.well-known/oauth-protected-resource${path}`;
}

/** `WWW-Authenticate` for 401s and insufficient-scope responses (RFC 6750, RFC 9728). */
export function wwwAuthenticate(
  origin: string,
  path: string,
  extra: { error?: string; description?: string; scope?: string } = {},
): string {
  const parts = [`Bearer realm="DataGoat"`];
  if (extra.error) parts.push(`error="${extra.error}"`);
  if (extra.description) parts.push(`error_description="${extra.description.replace(/"/g, "'")}"`);
  if (extra.scope) parts.push(`scope="${extra.scope}"`);
  parts.push(`resource_metadata="${protectedResourceMetadataUrl(origin, path)}"`);
  return parts.join(", ");
}

const USAGE_FLUSH_MS = 10 * 60_000;
const lastFlush = new Map<string, number>();

interface OAuthRow extends ConnectionRow {
  t_kind: string;
  t_expires_at: number;
  t_revoked_at: number | null;
  t_resource: string;
  u_email: string;
  u_name: string | null;
  u_image: string | null;
  u_created_at: number;
}

async function resolveOAuth(
  token: string,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  origin: string,
  now: number,
): Promise<McpCaller | null> {
  if (token.length > 200) return null;
  const row = await env.DB.prepare(
    `SELECT c.*, t.kind AS t_kind, t.expires_at AS t_expires_at, t.revoked_at AS t_revoked_at,
            t.resource AS t_resource, u.email AS u_email, u.name AS u_name, u.image AS u_image,
            u.created_at AS u_created_at
       FROM oauth_tokens t
       JOIN oauth_connections c ON c.id = t.connection_id
       JOIN users u ON u.id = c.user_id
      WHERE t.token_hash = ?`,
  )
    .bind(await hashToken(token))
    .first<OAuthRow>();
  if (row?.t_kind !== "access" || row.t_revoked_at !== null || row.t_expires_at <= now) {
    return null;
  }
  const connection = rowToConnection(row);
  if (!connectionIsLive(connection, now)) return null;
  // A token works only at the MCP endpoints of the server that issued it.
  if (!mcpResources(origin).includes(row.t_resource)) return null;
  const last = lastFlush.get(connection.id) ?? connection.lastUsedAt ?? 0;
  if (now - last >= USAGE_FLUSH_MS) {
    lastFlush.set(connection.id, now);
    if (lastFlush.size > 2000) lastFlush.clear();
    ctx.waitUntil(
      env.DB.prepare("UPDATE oauth_connections SET last_used_at = ? WHERE id = ?")
        .bind(now, connection.id)
        .run()
        .catch((err: unknown) => log.warn("oauth.usage_flush_failed", { error: String(err) })),
    );
  }
  return {
    connection,
    oauthScopes: connection.scopes,
    auth: {
      kind: "oauth",
      user: {
        id: row.user_id,
        email: row.u_email,
        name: row.u_name,
        image: row.u_image,
        createdAt: row.u_created_at,
      },
      credentialId: connection.id,
      scopes: permissionsOfScopes(connection.scopes),
      websiteIds: connection.siteIds,
      includePii: connection.scopes.includes("visitors:details"),
    },
  };
}

/** Resolve the Bearer credential presented at /mcp; null when unknown, expired or revoked. */
export async function resolveMcpCaller(
  token: string,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  origin: string,
  now = Date.now(),
): Promise<McpCaller | null> {
  if (token.startsWith(ACCESS_PREFIX)) return resolveOAuth(token, env, ctx, origin, now);
  if (!isApiKeySecret(token)) return null;
  const auth = await resolveBearer(token, env, ctx, now);
  if (!auth) return null;
  return { auth, connection: null, oauthScopes: [] };
}

/** Test helper. */
export function resetMcpAuthState(): void {
  lastFlush.clear();
}
