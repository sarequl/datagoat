/**
 * `/api/v1/admin/websites` CRUD, website API keys and team (DataFast Account API), plus DataGoat
 * extensions: team role changes and pending invites.
 */
import { Hono } from "hono";
import { z } from "zod";
import { isRole, type Role } from "../../../../shared/permissions";
import { getAccess, getAuth } from "../../../auth/context";
import {
  type ApiKeyRow,
  displayKeyOf,
  generateSecret,
  hashSecret,
  invalidateCredential,
  keyPrefixOf,
  MAX_KEYS_PER_SITE,
  websiteKeyDto,
} from "../../../auth/credentials";
import { invalidateMembership, listUserSiteRows } from "../../../auth/memberships";
import { requireAccountAccess, requireSiteAccess } from "../../../auth/middleware";
import { queueInviteEmail } from "../../../growth/alerts/account-emails";
import { sha256Hex } from "../../../lib/crypto";
import { ApiError } from "../../../lib/errors";
import { newId, randomToken } from "../../../lib/ids";
import { success } from "../../../lib/response";
import { siteCache } from "../../../lib/site-cache";
import { loadSiteById, rowToSite } from "../../../lib/sites";
import { toIso } from "../../../lib/time";
import { parseJsonBody, zEmail } from "../../../lib/validate";
import type { AppEnv } from "../../../types";
import {
  CreateWebsiteBody,
  prepareCreateWebsite,
  UpdateWebsiteBody,
  updateWebsite,
  websiteDto,
  websiteSummaryDto,
} from "./websites-service";

export const websiteRoutes = new Hono<AppEnv>();

const WEBSITE = "websiteId";

// ---------------------------------------------------------------------------
// Websites
// ---------------------------------------------------------------------------

websiteRoutes.get("/websites", requireAccountAccess("websites:read"), async (c) => {
  const auth = getAuth(c);
  const rows = await listUserSiteRows(c.env.DB, auth.user.id);
  const sites = rows
    .map((row) => ({ site: rowToSite(row), role: String(row.member_role) as Role }))
    .filter(({ site }) => auth.websiteIds === "all" || auth.websiteIds.includes(site.id))
    .map(({ site, role }) =>
      websiteSummaryDto(site, auth.roleCap && role === "owner" ? auth.roleCap : role),
    );
  return success(c, sites);
});

const WebsiteOrderBody = z
  .object({ websiteIds: z.array(z.string().trim().min(1).max(64)).min(1).max(200) })
  .strict();

/**
 * DG: save the caller's website order (DataFast's drag-and-drop reorder on the websites
 * dashboard). Ids the user is not a member of are ignored; websites left out keep their place
 * after the listed ones. Writes one membership row per listed website.
 */
websiteRoutes.put(
  "/account/website-order",
  requireAccountAccess("websites:read", { allowSiteKey: false }),
  async (c) => {
    const auth = getAuth(c);
    const { websiteIds } = await parseJsonBody(c, WebsiteOrderBody, { maxBytes: 16 * 1024 });
    const rows = await listUserSiteRows(c.env.DB, auth.user.id);
    const mine = new Map<string, string>();
    for (const row of rows) {
      mine.set(String(row.id), String(row.id));
      mine.set(String(row.public_id), String(row.id));
    }
    const ordered = [
      ...new Set(websiteIds.map((id) => mine.get(id)).filter((id) => id)),
    ] as string[];
    const rest = rows.map((r) => String(r.id)).filter((id) => !ordered.includes(id));
    const stmt = c.env.DB.prepare(
      "UPDATE memberships SET position = ? WHERE site_id = ? AND user_id = ? AND position IS NOT ?",
    );
    const writes = [...ordered, ...rest].map((id, i) => stmt.bind(i, id, auth.user.id, i));
    for (let i = 0; i < writes.length; i += 50) await c.env.DB.batch(writes.slice(i, i + 50));
    const sorted = await listUserSiteRows(c.env.DB, auth.user.id);
    return success(
      c,
      sorted
        .map((row) => ({ site: rowToSite(row), role: String(row.member_role) as Role }))
        .filter(({ site }) => auth.websiteIds === "all" || auth.websiteIds.includes(site.id))
        .map(({ site, role }) =>
          websiteSummaryDto(site, auth.roleCap && role === "owner" ? auth.roleCap : role),
        ),
    );
  },
);

websiteRoutes.post(
  "/websites",
  requireAccountAccess("websites:write", { allowSiteKey: false }),
  async (c) => {
    const auth = getAuth(c);
    if (auth.websiteIds !== "all") {
      throw new ApiError(403, "Tokens restricted to specific websites cannot create websites");
    }
    const body = await parseJsonBody(c, CreateWebsiteBody);
    const created = await prepareCreateWebsite(c.env.DB, body, auth.user.id);
    await c.env.DB.batch(created.statements);
    return success(c, [
      { websiteId: created.id, domain: body.domain, trackingId: created.publicId },
    ]);
  },
);

websiteRoutes.get(
  "/websites/:websiteId",
  requireSiteAccess("settings:read", { param: WEBSITE }),
  (c) => {
    const { site, role } = getAccess(c);
    return success(c, [websiteDto(site, role)]);
  },
);

websiteRoutes.put(
  "/websites/:websiteId",
  requireSiteAccess("settings:write", { param: WEBSITE }),
  async (c) => {
    const { site, role } = getAccess(c);
    const body = await parseJsonBody(c, UpdateWebsiteBody, { maxBytes: 32 * 1024 });
    const updated = await updateWebsite(c.env.DB, site, body);
    return success(c, [websiteDto(updated, role)]);
  },
);

websiteRoutes.delete(
  "/websites/:websiteId",
  requireSiteAccess("websites:write", { param: WEBSITE }),
  async (c) => {
    const { auth, site, role } = getAccess(c);
    if (auth.kind !== "session") {
      // DataFast: website deletion is dashboard-only.
      throw new ApiError(
        403,
        `Website deletion cannot be done programmatically. Please delete this website from the DataGoat dashboard: ${new URL(c.req.url).origin}/app/${site.id}/settings/danger`,
      );
    }
    if (role !== "owner") throw new ApiError(403, "Only the website owner can delete it");
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE sites SET deleted_at = ?, share_token = NULL, updated_at = ? WHERE id = ?",
      ).bind(now, now, site.id),
      c.env.DB.prepare(
        "UPDATE api_keys SET revoked_at = ? WHERE site_id = ? AND revoked_at IS NULL",
      ).bind(now, site.id),
      c.env.DB.prepare(
        "UPDATE invites SET revoked_at = ? WHERE site_id = ? AND accepted_at IS NULL AND revoked_at IS NULL",
      ).bind(now, site.id),
    ]);
    siteCache.invalidate(site);
    invalidateCredential();
    return success(c, [
      { message: "Website deleted. Its data is removed in the background.", websiteId: site.id },
    ]);
  },
);

// ---------------------------------------------------------------------------
// Website API keys (df_)
// ---------------------------------------------------------------------------

websiteRoutes.get(
  "/websites/:websiteId/apikeys",
  requireSiteAccess("api-keys:read", { param: WEBSITE }),
  async (c) => {
    const { site } = getAccess(c);
    const res = await c.env.DB.prepare(
      `SELECT * FROM api_keys WHERE site_id = ? AND kind = 'df' AND revoked_at IS NULL AND is_mobile = 0
      ORDER BY created_at DESC`,
    )
      .bind(site.id)
      .all<ApiKeyRow>();
    return success(
      c,
      (res.results ?? []).map((row) => websiteKeyDto(row)),
    );
  },
);

const CreateKeyBody = z
  .object({
    name: z.string().trim().max(100).nullish(),
    includePii: z.boolean().optional(),
    isMobile: z.boolean().optional(),
  })
  .strict();

websiteRoutes.post(
  "/websites/:websiteId/apikeys",
  requireSiteAccess("api-keys:write", { param: WEBSITE }),
  async (c) => {
    const { auth, site } = getAccess(c);
    const body = await parseJsonBody(c, CreateKeyBody);
    if (body.includePii && !auth.includePii) {
      throw new ApiError(
        403,
        "The calling credential cannot grant access to customer names and emails",
      );
    }
    const count = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM api_keys WHERE site_id = ? AND kind = 'df' AND revoked_at IS NULL AND is_mobile = 0",
    )
      .bind(site.id)
      .first<{ n: number }>();
    if (!body.isMobile && (count?.n ?? 0) >= MAX_KEYS_PER_SITE) {
      throw new ApiError(400, `Key limit reached (max ${MAX_KEYS_PER_SITE} per website)`);
    }
    const now = Date.now();
    const secret = generateSecret("df");
    const row: ApiKeyRow = {
      id: newId(now),
      kind: "df",
      site_id: site.id,
      user_id: auth.user.id,
      name: body.name ?? null,
      key_hash: await hashSecret(secret),
      key_prefix: keyPrefixOf(secret),
      display_key: displayKeyOf(secret),
      permissions: '["*"]',
      website_ids: JSON.stringify([site.id]),
      include_pii: body.includePii ? 1 : 0,
      is_mobile: body.isMobile ? 1 : 0,
      oauth_connection_id: null,
      expires_at: null,
      created_at: now,
      updated_at: now,
      last_used_at: null,
      usage_count: 0,
      revoked_at: null,
    };
    await c.env.DB.prepare(
      `INSERT INTO api_keys (id, kind, site_id, user_id, name, key_hash, key_prefix, display_key, permissions,
       website_ids, include_pii, is_mobile, created_at, updated_at)
     VALUES (?, 'df', ?, ?, ?, ?, ?, ?, '["*"]', ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        site.id,
        row.user_id,
        row.name,
        row.key_hash,
        row.key_prefix,
        row.display_key,
        row.website_ids,
        row.include_pii,
        row.is_mobile,
        now,
        now,
      )
      .run();
    return success(c, [websiteKeyDto(row, secret)]);
  },
);

websiteRoutes.put(
  "/websites/:websiteId/apikeys/:apiKeyId",
  requireSiteAccess("api-keys:write", { param: WEBSITE }),
  async (c) => {
    const { site } = getAccess(c);
    const now = Date.now();
    const secret = generateSecret("df");
    const keyHash = await hashSecret(secret);
    const old = await c.env.DB.prepare(
      "SELECT key_hash FROM api_keys WHERE id = ? AND site_id = ? AND kind = 'df' AND revoked_at IS NULL",
    )
      .bind(c.req.param("apiKeyId"), site.id)
      .first<{ key_hash: string }>();
    if (!old) throw new ApiError(404, "API key not found");
    const row = await c.env.DB.prepare(
      `UPDATE api_keys SET key_hash = ?, key_prefix = ?, display_key = ?, updated_at = ?, last_used_at = NULL,
         usage_count = 0 WHERE id = ? RETURNING *`,
    )
      .bind(keyHash, keyPrefixOf(secret), displayKeyOf(secret), now, c.req.param("apiKeyId"))
      .first<ApiKeyRow>();
    if (!row) throw new ApiError(404, "API key not found");
    invalidateCredential(old.key_hash);
    return success(c, [websiteKeyDto(row, secret)]);
  },
);

websiteRoutes.delete(
  "/websites/:websiteId/apikeys/:apiKeyId",
  requireSiteAccess("api-keys:write", { param: WEBSITE }),
  async (c) => {
    const { site } = getAccess(c);
    const row = await c.env.DB.prepare(
      "DELETE FROM api_keys WHERE id = ? AND site_id = ? AND kind = 'df' RETURNING key_hash",
    )
      .bind(c.req.param("apiKeyId"), site.id)
      .first<{ key_hash: string }>();
    if (!row) throw new ApiError(404, "API key not found");
    invalidateCredential(row.key_hash);
    return success(c, [{ deleted: true }]);
  },
);

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

websiteRoutes.get(
  "/websites/:websiteId/team",
  requireSiteAccess("team:read", { param: WEBSITE }),
  async (c) => {
    const { site } = getAccess(c);
    const res = await c.env.DB.prepare(
      `SELECT u.id, u.name, u.email, u.image, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.site_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, m.created_at`,
    )
      .bind(site.id)
      .all<Record<string, unknown>>();
    return success(
      c,
      (res.results ?? []).map((r) => ({
        userId: String(r.id),
        name: (r.name as string | null) ?? null,
        email: String(r.email),
        image: (r.image as string | null) ?? null,
        role: String(r.role),
        joinedAt: toIso(Number(r.created_at)),
      })),
    );
  },
);

const InviteBody = z
  .object({ email: zEmail, role: z.enum(["viewer", "member"]).default("viewer") })
  .strict();

websiteRoutes.post(
  "/websites/:websiteId/team",
  requireSiteAccess("team:write", { param: WEBSITE, allowSiteKey: false, minRole: "owner" }),
  async (c) => {
    const { user, site } = getAccess(c);
    const body = await parseJsonBody(c, InviteBody);
    if (body.email === user.email.toLowerCase())
      throw new ApiError(400, "You cannot invite yourself");
    const existing = await c.env.DB.prepare(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.site_id = ? AND u.email = ?`,
    )
      .bind(site.id, body.email)
      .first();
    if (existing) throw new ApiError(409, "This email is already a member of the website");
    const now = Date.now();
    const token = randomToken(32);
    const id = newId(now);
    try {
      await c.env.DB.prepare(
        `INSERT INTO invites (id, site_id, email, role, token_hash, invited_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          site.id,
          body.email,
          body.role,
          await sha256Hex(`invite:${token}`),
          user.id,
          now,
          now + INVITE_TTL_MS,
        )
        .run();
    } catch (err) {
      if (String(err).includes("UNIQUE"))
        throw new ApiError(409, "This email already has a pending invite");
      throw err;
    }
    const inviteUrl = `${new URL(c.req.url).origin}/invite/${token}`;
    // W6: email the invite when an email provider is configured (otherwise share the link).
    const emailQueued = await queueInviteEmail(c.env, c.env.DB, {
      siteId: site.id,
      siteLabel: site.name?.trim() || site.domain,
      email: body.email,
      role: body.role,
      inviteUrl,
      inviterName: user.name,
      expiresAt: now + INVITE_TTL_MS,
      invitationId: id,
    });
    return success(c, [
      {
        message: emailQueued
          ? "Invitation created and emailed to the user."
          : "Invitation created. Send the invite link to the user.",
        invitationId: id,
        email: body.email,
        role: body.role,
        inviteUrl,
        expiresAt: toIso(now + INVITE_TTL_MS),
        emailQueued,
      },
    ]);
  },
);

const RemoveBody = z.object({ userId: z.string().min(1).max(64) }).strict();

websiteRoutes.delete(
  "/websites/:websiteId/team",
  requireSiteAccess("team:write", { param: WEBSITE, allowSiteKey: false, minRole: "owner" }),
  async (c) => {
    const { user, site } = getAccess(c);
    const { userId } = await parseJsonBody(c, RemoveBody);
    if (userId === user.id) throw new ApiError(400, "You cannot remove yourself");
    const row = await c.env.DB.prepare(
      "DELETE FROM memberships WHERE site_id = ? AND user_id = ? RETURNING role",
    )
      .bind(site.id, userId)
      .first<{ role: string }>();
    if (!row) throw new ApiError(404, "Team member not found");
    invalidateMembership(site.id, userId);
    invalidateCredential();
    return success(c, [{ message: "Member removed successfully" }]);
  },
);

const RoleBody = z
  .object({ userId: z.string().min(1).max(64), role: z.enum(["owner", "member", "viewer"]) })
  .strict();

/** DataGoat extension: change a member's role. At least one owner always remains. */
websiteRoutes.put(
  "/websites/:websiteId/team",
  requireSiteAccess("team:write", { param: WEBSITE, allowSiteKey: false, minRole: "owner" }),
  async (c) => {
    const { site } = getAccess(c);
    const { userId, role } = await parseJsonBody(c, RoleBody);
    const current = await c.env.DB.prepare(
      "SELECT role FROM memberships WHERE site_id = ? AND user_id = ?",
    )
      .bind(site.id, userId)
      .first<{ role: string }>();
    if (!current || !isRole(current.role)) throw new ApiError(404, "Team member not found");
    if (current.role === "owner" && role !== "owner") {
      const owners = await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM memberships WHERE site_id = ? AND role = 'owner'",
      )
        .bind(site.id)
        .first<{ n: number }>();
      if ((owners?.n ?? 0) <= 1) throw new ApiError(400, "A website must keep at least one owner");
    }
    await c.env.DB.prepare("UPDATE memberships SET role = ? WHERE site_id = ? AND user_id = ?")
      .bind(role, site.id, userId)
      .run();
    invalidateMembership(site.id, userId);
    return success(c, [{ message: "Role updated", userId, role }]);
  },
);

websiteRoutes.get(
  "/websites/:websiteId/team/invites",
  requireSiteAccess("team:read", { param: WEBSITE }),
  async (c) => {
    const { site } = getAccess(c);
    const res = await c.env.DB.prepare(
      `SELECT id, email, role, created_at, expires_at FROM invites
      WHERE site_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
    )
      .bind(site.id, Date.now())
      .all<Record<string, unknown>>();
    return success(
      c,
      (res.results ?? []).map((r) => ({
        invitationId: String(r.id),
        email: String(r.email),
        role: String(r.role),
        createdAt: toIso(Number(r.created_at)),
        expiresAt: toIso(Number(r.expires_at)),
      })),
    );
  },
);

websiteRoutes.delete(
  "/websites/:websiteId/team/invites/:invitationId",
  requireSiteAccess("team:write", { param: WEBSITE, allowSiteKey: false, minRole: "owner" }),
  async (c) => {
    const { site } = getAccess(c);
    const res = await c.env.DB.prepare(
      "UPDATE invites SET revoked_at = ? WHERE id = ? AND site_id = ? AND accepted_at IS NULL AND revoked_at IS NULL",
    )
      .bind(Date.now(), c.req.param("invitationId"), site.id)
      .run();
    if (!res.meta.changes) throw new ApiError(404, "Invitation not found");
    return success(c, [{ message: "Invitation revoked" }]);
  },
);

/** Re-export for setup: load a site fresh (bypassing caches) after creation. */
export { loadSiteById };
