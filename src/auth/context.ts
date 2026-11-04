/**
 * The authenticated caller, as exposed to handlers.
 *
 *   const { user, site, role, scopes } = getAccess(c);   // after requireSiteAccess(...)
 *   const auth = c.get("auth");                           // after authenticate
 */
import type { Context } from "hono";
import type { Grant, Role } from "../../shared/permissions";
import { ApiError } from "../lib/errors";
import type { Site } from "../lib/sites";
import type { AppEnv } from "../types";

export type AuthKind = "session" | "site_key" | "account_token" | "oauth";

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  createdAt: number;
}

export interface AuthContext {
  kind: AuthKind;
  user: AuthUser;
  /** api_keys.id, the session id hash, or the OAuth connection id. Rate limits key on this. */
  credentialId: string;
  /** Granted permissions. Dashboard sessions and df_ keys hold ["*"]. */
  scopes: Grant[];
  /** Websites the credential may touch: "all" (subject to membership) or explicit site ids. */
  websiteIds: "all" | string[];
  /** For df_ keys: the key's website. */
  keySiteId?: string;
  /** Highest role this credential may act with (df_ keys: member). */
  roleCap?: Role;
  /** May read customer names and emails. Sessions: true. Keys: the include_pii flag. */
  includePii: boolean;
}

export function getAuth(c: Context<AppEnv>): AuthContext {
  const auth = c.get("auth");
  if (!auth) throw new ApiError(401, "Authentication required");
  return auth;
}

export interface Access {
  auth: AuthContext;
  user: AuthUser;
  site: Site;
  role: Role;
  scopes: Grant[];
}

/** The `{user, site, role, scopes}` bundle for site-scoped handlers (after requireSiteAccess). */
export function getAccess(c: Context<AppEnv>): Access {
  const auth = getAuth(c);
  const site = c.get("site");
  const role = c.get("role");
  if (!site || !role) throw new Error("getAccess() used on a route without requireSiteAccess()");
  return { auth, user: auth.user, site, role, scopes: auth.scopes };
}
