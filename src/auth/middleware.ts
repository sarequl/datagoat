/**
 * Authentication and authorization middleware. One code path accepts either the dashboard
 * session cookie or a Bearer credential (df_, dft_, or a registered resolver such as MCP OAuth)
 * and exposes `{user, site, role, scopes}` to handlers (see context.ts).
 *
 * Typical use in a router:
 *
 *   app.get("/overview", requireSiteAccess("analytics:read"), handler)          // ?websiteId= or df_ key
 *   app.put("/websites/:websiteId", requireSiteAccess("settings:write", { param: "websiteId" }), h)
 *   app.post("/access-tokens", requireAccountAccess("api-keys:write", { allowSiteKey: false }), h)
 *
 * Rules (DataFast parity):
 * - df_ keys act on their own website only, with every website permission, capped at member role.
 * - dft_ tokens need `?websiteId=` (or a path id) on website routes, the permission, the website in
 *   their allowlist, and a membership whose role allows the permission.
 * - Dashboard sessions hold every permission; their role on the website still applies.
 * - Viewers are read-only; members cannot write team; owners can do everything.
 */
import type { Context, MiddlewareHandler } from "hono";
import {
  grantsAllow,
  minRole,
  type Permission,
  type Role,
  roleAllows,
  roleAtLeast,
} from "../../shared/permissions";
import { ApiError } from "../lib/errors";
import { siteCache } from "../lib/site-cache";
import type { Site } from "../lib/sites";
import type { AppEnv } from "../types";
import type { AuthContext, AuthKind } from "./context";
import { resolveBearer } from "./credentials";
import { getRole } from "./memberships";
import { readSession } from "./sessions";

/** Resolve the caller. Never rejects a request without credentials; use requireAuth for that. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("auth")) return next();
  const header = c.req.header("authorization");
  if (header !== undefined) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!match?.[1])
      throw new ApiError(401, "Invalid Authorization header. Use: Authorization: Bearer <token>");
    const auth = await resolveBearer(
      match[1],
      c.env,
      c.executionCtx as unknown as ExecutionContext,
    );
    if (!auth) throw new ApiError(401, "Invalid, expired or revoked API key");
    c.set("auth", auth);
    return next();
  }
  const session = await readSession(c);
  if (session) {
    c.set("auth", {
      kind: "session",
      user: session.user,
      credentialId: session.idHash,
      scopes: ["*"],
      websiteIds: "all",
      includePii: true,
    } satisfies AuthContext);
  }
  return next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("auth")) throw new ApiError(401, "Authentication required");
  return next();
};

export interface SiteAccessOptions {
  /** Path parameter holding the website id (admin routes). Default: `?websiteId=` or the df_ key. */
  param?: string;
  /** Reject df_ website keys (owner-only and account-level actions). Default true = allowed. */
  allowSiteKey?: boolean;
  /** Minimum role regardless of permission (e.g. "owner" for team writes). */
  minRole?: Role;
  /** Accept only these credential kinds. */
  kinds?: AuthKind[];
}

function credentialAllowsSite(auth: AuthContext, site: Site): boolean {
  if (auth.websiteIds === "all") return true;
  return auth.websiteIds.includes(site.id);
}

async function findSite(db: D1Database, idOrPublicId: string): Promise<Site | null> {
  return (await siteCache.byId(db, idOrPublicId)) ?? (await siteCache.byPublicId(db, idOrPublicId));
}

/** Resolve and authorize the target website for a request. Sets `site` and `role`. */
export async function resolveSiteAccess(
  c: Context<AppEnv>,
  permission: Permission,
  options: SiteAccessOptions = {},
): Promise<{ site: Site; role: Role }> {
  const auth = c.get("auth");
  if (!auth) throw new ApiError(401, "Authentication required");
  if (options.kinds && !options.kinds.includes(auth.kind)) {
    throw new ApiError(403, "This credential type cannot call this endpoint");
  }
  if (auth.kind === "site_key" && options.allowSiteKey === false) {
    throw new ApiError(
      403,
      "Website API keys (df_) cannot call this endpoint; use an account token (dft_)",
    );
  }
  if (!grantsAllow(auth.scopes, permission)) {
    throw new ApiError(403, `Missing permission: ${permission}`);
  }
  const requested = options.param ? c.req.param(options.param) : c.req.query("websiteId");
  let siteRef = requested;
  if (!siteRef) {
    if (auth.kind === "site_key" && auth.keySiteId) siteRef = auth.keySiteId;
    else throw new ApiError(400, "websiteId query parameter is required with this credential");
  }
  const site = await findSite(c.env.DB, siteRef);
  if (!site) throw new ApiError(404, "Website not found");
  if (auth.kind === "site_key" && auth.keySiteId !== site.id) {
    throw new ApiError(403, "This website API key cannot access that website");
  }
  if (!credentialAllowsSite(auth, site)) {
    throw new ApiError(403, "This token cannot access that website");
  }
  const memberRole = await getRole(c.env.DB, site.id, auth.user.id);
  if (!memberRole) {
    // Existence is not revealed to non-members.
    throw new ApiError(
      auth.kind === "site_key" ? 401 : 404,
      auth.kind === "site_key"
        ? "API key owner no longer has access to this website"
        : "Website not found",
    );
  }
  const role = auth.roleCap ? minRole(memberRole, auth.roleCap) : memberRole;
  if (!roleAllows(role, permission)) {
    throw new ApiError(403, `Your role (${role}) does not allow ${permission}`);
  }
  if (options.minRole && !roleAtLeast(role, options.minRole)) {
    throw new ApiError(403, `This action requires the ${options.minRole} role`);
  }
  c.set("site", site);
  c.set("role", role);
  return { site, role };
}

/** Middleware form of `resolveSiteAccess`. */
export function requireSiteAccess(
  permission: Permission,
  options: SiteAccessOptions = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await resolveSiteAccess(c, permission, options);
    return next();
  };
}

export interface AccountAccessOptions {
  allowSiteKey?: boolean;
  kinds?: AuthKind[];
}

/** Account-level permission check (no website context): tokens, website creation, account. */
export function requireAccountAccess(
  permission: Permission,
  options: AccountAccessOptions = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth) throw new ApiError(401, "Authentication required");
    if (options.kinds && !options.kinds.includes(auth.kind)) {
      throw new ApiError(403, "This credential type cannot call this endpoint");
    }
    if (auth.kind === "site_key" && options.allowSiteKey === false) {
      throw new ApiError(
        403,
        "Website API keys (df_) cannot call this endpoint; use an account token (dft_)",
      );
    }
    if (!grantsAllow(auth.scopes, permission))
      throw new ApiError(403, `Missing permission: ${permission}`);
    return next();
  };
}

/** Only the dashboard session (cookie) may call this route. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth) throw new ApiError(401, "Authentication required");
  if (auth.kind !== "session")
    throw new ApiError(403, "This action is only available in the dashboard");
  return next();
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF protection for cookie-authenticated requests: unsafe methods must come from the same
 * origin. Requests with a Bearer token are exempt (browsers never attach those automatically).
 */
export const sameOriginGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || c.req.header("authorization")) return next();
  const origin = c.req.header("origin");
  const fetchSite = c.req.header("sec-fetch-site");
  const self = new URL(c.req.url).origin;
  if (origin && origin !== self) throw new ApiError(403, "Cross-origin request rejected");
  if (!origin && fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ApiError(403, "Cross-origin request rejected");
  }
  return next();
};
