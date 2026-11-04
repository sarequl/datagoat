/**
 * Website memberships (owner / member / viewer), cached per isolate for 30 seconds.
 * Writers call `invalidateMembership()` after changing a role.
 */
import { isRole, type Role } from "../../shared/permissions";

const TTL_MS = 30_000;
const cache = new Map<string, { role: Role | null; expires: number }>();

export async function getRole(
  db: D1Database,
  siteId: string,
  userId: string,
  now = Date.now(),
): Promise<Role | null> {
  const key = `${siteId}:${userId}`;
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.role;
  const row = await db
    .prepare("SELECT role FROM memberships WHERE site_id = ? AND user_id = ?")
    .bind(siteId, userId)
    .first<{ role: string }>();
  const role = row && isRole(row.role) ? row.role : null;
  if (cache.size > 2000) cache.clear();
  cache.set(key, { role, expires: now + TTL_MS });
  return role;
}

export function invalidateMembership(siteId?: string, userId?: string): void {
  if (siteId && userId) cache.delete(`${siteId}:${userId}`);
  else cache.clear();
}

export interface MembershipSite {
  siteId: string;
  role: Role;
}

/** Every live site the user belongs to, oldest first. */
export async function listUserSiteRows(
  db: D1Database,
  userId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await db
    .prepare(
      `SELECT s.*, m.role AS member_role FROM memberships m JOIN sites s ON s.id = m.site_id
        WHERE m.user_id = ? AND s.deleted_at IS NULL ORDER BY s.created_at ASC`,
    )
    .bind(userId)
    .all<Record<string, unknown>>();
  return res.results ?? [];
}
