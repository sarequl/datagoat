/**
 * Permission strings and roles. Shared by the Worker and the dashboard.
 * The permission names are DataFast's (docs/api/authentication), so DataFast tokens
 * scoped the same way behave the same here. DataGoat-only endpoints reuse these names
 * (see docs/api/contract.md, "Permissions").
 */

export const PERMISSIONS = [
  "analytics:read",
  "goals:read",
  "goals:write",
  "payments:read",
  "payments:write",
  "identify:write",
  "websites:read",
  "websites:write",
  "settings:read",
  "settings:write",
  "funnels:read",
  "funnels:write",
  "alerts:read",
  "alerts:write",
  "team:read",
  "team:write",
  "api-keys:read",
  "api-keys:write",
  "notes:read",
  "notes:write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
/** A granted permission: a concrete permission or the full-access wildcard. */
export type Grant = Permission | "*";

export const ROLES = ["owner", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Record<Role, number> = { viewer: 1, member: 2, owner: 3 };

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** True when `role` is at least `minimum` (owner > member > viewer). */
export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** The lower of two roles. Used to cap df_ website keys at member level. */
export function minRole(a: Role, b: Role): Role {
  return ROLE_RANK[a] <= ROLE_RANK[b] ? a : b;
}

/** True when the grant list allows `permission` ("*" allows everything). */
export function grantsAllow(grants: readonly string[], permission: Permission): boolean {
  return grants.includes("*") || grants.includes(permission);
}

/** True when `requested` is a subset of what `held` allows. */
export function grantsWithin(requested: readonly string[], held: readonly string[]): boolean {
  if (held.includes("*")) return true;
  if (requested.includes("*")) return false;
  return requested.every((p) => held.includes(p));
}

/**
 * Whether a website role may use a permission on that website.
 * Viewers are read-only; members can use everything except team writes;
 * owners can use everything.
 */
export function roleAllows(role: Role, permission: Permission): boolean {
  if (role === "owner") return true;
  if (role === "member") return permission !== "team:write";
  return permission.endsWith(":read");
}
