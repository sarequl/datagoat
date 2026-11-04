/**
 * `GET|PUT /api/v1/admin/account` and `/api/v1/admin/access-tokens` (DataFast Account API).
 */
import { Hono } from "hono";
import { z } from "zod";
import { type Grant, grantsWithin, isPermission } from "../../../../shared/permissions";
import { getAuth } from "../../../auth/context";
import {
  type ApiKeyRow,
  accessTokenDto,
  displayKeyOf,
  generateSecret,
  hashSecret,
  invalidateCredential,
  keyPrefixOf,
  MAX_TOKENS_PER_USER,
} from "../../../auth/credentials";
import { requireAccountAccess } from "../../../auth/middleware";
import { ApiError } from "../../../lib/errors";
import { newId } from "../../../lib/ids";
import { success } from "../../../lib/response";
import { parseJsonBody } from "../../../lib/validate";
import type { AppEnv } from "../../../types";

export const accountRoutes = new Hono<AppEnv>();

function accountDto(user: {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  createdAt: number;
}) {
  return {
    _id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    hasAccess: true,
    planType: "self_hosted",
    isFreeTrialActive: false,
    freeTrialStartAt: null,
    billingCycleStartAt: null,
    billingCycleEndAt: null,
    createdAt: new Date(user.createdAt).toISOString(),
  };
}

accountRoutes.get("/account", requireAccountAccess("analytics:read"), (c) => {
  const auth = getAuth(c);
  return success(c, [
    { ...accountDto(auth.user), ...(auth.keySiteId ? { websiteId: auth.keySiteId } : {}) },
  ]);
});

const UpdateAccountBody = z
  .object({ name: z.string().trim().min(1, "name is required").max(100) })
  .strict();

accountRoutes.put(
  "/account",
  requireAccountAccess("analytics:read", { allowSiteKey: false }),
  async (c) => {
    const auth = getAuth(c);
    const { name } = await parseJsonBody(c, UpdateAccountBody);
    const now = Date.now();
    await c.env.DB.prepare("UPDATE users SET name = ?, updated_at = ? WHERE id = ?")
      .bind(name, now, auth.user.id)
      .run();
    return success(c, [{ id: auth.user.id, name, email: auth.user.email, image: auth.user.image }]);
  },
);

// ---------------------------------------------------------------------------
// Access tokens (dft_)
// ---------------------------------------------------------------------------

accountRoutes.get(
  "/access-tokens",
  requireAccountAccess("api-keys:read", { allowSiteKey: false }),
  async (c) => {
    const auth = getAuth(c);
    const res = await c.env.DB.prepare(
      `SELECT * FROM api_keys WHERE user_id = ? AND kind = 'dft' AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    )
      .bind(auth.user.id)
      .all<ApiKeyRow>();
    return success(
      c,
      (res.results ?? []).map((row) => accessTokenDto(row)),
    );
  },
);

const CreateTokenBody = z
  .object({
    name: z.string().trim().max(100).nullish(),
    permissions: z
      .array(z.string())
      .min(1, "permissions must not be empty")
      .max(40)
      .refine((list) => list.every((p) => p === "*" || isPermission(p)), {
        message: "contains an unknown permission",
      })
      .optional(),
    websiteIds: z.array(z.string().min(1).max(64)).max(100).optional(),
    includePii: z.boolean().optional(),
    expiresInDays: z.number().int().min(1).max(3650).nullish(),
  })
  .strict();

accountRoutes.post(
  "/access-tokens",
  requireAccountAccess("api-keys:write", { allowSiteKey: false }),
  async (c) => {
    const auth = getAuth(c);
    const body = await parseJsonBody(c, CreateTokenBody);
    const permissions = [...new Set(body.permissions ?? ["*"])] as Grant[];
    if (!grantsWithin(permissions, auth.scopes)) {
      throw new ApiError(403, "Requested permissions exceed the permissions of the calling token");
    }
    if (body.includePii && !auth.includePii) {
      throw new ApiError(403, "The calling token cannot grant access to customer names and emails");
    }
    const websiteIds = [...new Set(body.websiteIds ?? [])];
    if (auth.websiteIds !== "all") {
      if (websiteIds.length === 0)
        throw new ApiError(403, "Requested website scope exceeds the calling token");
      const allowed = auth.websiteIds;
      if (!websiteIds.every((id) => allowed.includes(id))) {
        throw new ApiError(403, "Requested website scope exceeds the calling token");
      }
    }
    if (websiteIds.length) {
      const res = await c.env.DB.prepare(
        `SELECT m.site_id FROM memberships m JOIN sites s ON s.id = m.site_id
        WHERE m.user_id = ? AND s.deleted_at IS NULL AND m.site_id IN (${websiteIds.map(() => "?").join(", ")})`,
      )
        .bind(auth.user.id, ...websiteIds)
        .all<{ site_id: string }>();
      const found = new Set((res.results ?? []).map((r) => r.site_id));
      const missing = websiteIds.filter((id) => !found.has(id));
      if (missing.length) throw new ApiError(400, `Unknown websiteIds: ${missing.join(", ")}`);
    }
    const count = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND kind = 'dft' AND revoked_at IS NULL",
    )
      .bind(auth.user.id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_TOKENS_PER_USER) {
      throw new ApiError(400, `Token limit reached (max ${MAX_TOKENS_PER_USER})`);
    }
    const now = Date.now();
    const secret = generateSecret("dft");
    const row: ApiKeyRow = {
      id: newId(now),
      kind: "dft",
      site_id: null,
      user_id: auth.user.id,
      name: body.name ?? null,
      key_hash: await hashSecret(secret),
      key_prefix: keyPrefixOf(secret),
      display_key: displayKeyOf(secret),
      permissions: JSON.stringify(permissions),
      website_ids: JSON.stringify(websiteIds),
      include_pii: body.includePii === true ? 1 : 0,
      is_mobile: 0,
      oauth_connection_id: null,
      expires_at: body.expiresInDays ? now + body.expiresInDays * 86_400_000 : null,
      created_at: now,
      updated_at: now,
      last_used_at: null,
      usage_count: 0,
      revoked_at: null,
    };
    await c.env.DB.prepare(
      `INSERT INTO api_keys (id, kind, site_id, user_id, name, key_hash, key_prefix, display_key, permissions,
       website_ids, include_pii, is_mobile, expires_at, created_at, updated_at)
     VALUES (?, 'dft', NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
      .bind(
        row.id,
        row.user_id,
        row.name,
        row.key_hash,
        row.key_prefix,
        row.display_key,
        row.permissions,
        row.website_ids,
        row.include_pii,
        row.expires_at,
        now,
        now,
      )
      .run();
    return success(c, [accessTokenDto(row, secret)]);
  },
);

accountRoutes.delete(
  "/access-tokens/:tokenId",
  requireAccountAccess("api-keys:write", { allowSiteKey: false }),
  async (c) => {
    const auth = getAuth(c);
    const row = await c.env.DB.prepare(
      "DELETE FROM api_keys WHERE id = ? AND user_id = ? AND kind = 'dft' RETURNING key_hash",
    )
      .bind(c.req.param("tokenId"), auth.user.id)
      .first<{ key_hash: string }>();
    if (!row) throw new ApiError(404, "Access token not found");
    invalidateCredential(row.key_hash);
    return success(c, [{ message: "Access token deleted successfully" }]);
  },
);
