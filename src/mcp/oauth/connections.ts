/**
 * Connected apps: `GET /api/v1/admin/oauth/connections` and
 * `DELETE /api/v1/admin/oauth/connections/:connectionId` (dashboard session, or a dft_ token with
 * api-keys:read / api-keys:write). Revoking blocks the connection's tokens and refreshes at once
 * and revokes every credential minted through it.
 */
import { Hono } from "hono";
import type { OAuthConnection } from "../../../shared/api-types";
import { getAuth } from "../../auth/context";
import { requireAccountAccess } from "../../auth/middleware";
import { ApiError } from "../../lib/errors";
import { success } from "../../lib/response";
import { toIsoOrNull } from "../../lib/time";
import type { AppEnv } from "../../types";
import { type ConnectionRow, revokeConnection, rowToConnection } from "./store";

export const connectionRoutes = new Hono<AppEnv>();

const KINDS = ["session", "account_token"] as const;

connectionRoutes.get(
  "/api/v1/admin/oauth/connections",
  requireAccountAccess("api-keys:read", { allowSiteKey: false, kinds: [...KINDS] }),
  async (c) => {
    const auth = getAuth(c);
    const now = Date.now();
    const res = await c.env.DB.prepare(
      `SELECT c.*, cl.name AS client_name FROM oauth_connections c
         LEFT JOIN oauth_clients cl ON cl.id = c.client_id
        WHERE c.user_id = ? AND c.revoked_at IS NULL AND c.expires_at > ?
        ORDER BY c.created_at DESC`,
    )
      .bind(auth.user.id, now)
      .all<ConnectionRow & { client_name: string | null }>();
    const data: OAuthConnection[] = (res.results ?? []).map((row) => {
      const conn = rowToConnection(row);
      return {
        id: conn.id,
        client: { id: conn.clientId, name: row.client_name },
        scopes: conn.scopes,
        websiteIds: conn.siteIds,
        createdAt: new Date(conn.createdAt).toISOString(),
        expiresAt: new Date(conn.expiresAt).toISOString(),
        lastUsedAt: toIsoOrNull(conn.lastUsedAt),
      };
    });
    return success(c, data);
  },
);

connectionRoutes.delete(
  "/api/v1/admin/oauth/connections/:connectionId",
  requireAccountAccess("api-keys:write", { allowSiteKey: false, kinds: [...KINDS] }),
  async (c) => {
    const auth = getAuth(c);
    const id = c.req.param("connectionId");
    const row = await c.env.DB.prepare(
      "SELECT id FROM oauth_connections WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
      .bind(id, auth.user.id)
      .first<{ id: string }>();
    if (!row) throw new ApiError(404, "Connection not found");
    await revokeConnection(c.env.DB, id, Date.now());
    return success(c, [{ message: "Access revoked" }]);
  },
);
