/** Account tools: whoami, display name and dft_ account tokens. */
import { z } from "zod";
import { grantsAllow, grantsWithin, isPermission } from "../../../shared/permissions";
import { permissionsOfScopes } from "../oauth/scopes";
import { type Args, enc, type ToolContext, type ToolDef, ToolError } from "./kit";
import { bindToConnection } from "./resources";

function canUse(tc: ToolContext, permission: "websites:read", oauthScope: string): boolean {
  const { caller } = tc;
  if (caller.connection) return caller.oauthScopes.includes(oauthScope);
  return grantsAllow(caller.auth.scopes, permission);
}

interface TokenDto {
  id: string;
  permissions: string[];
  websiteIds: string[];
}

/** For OAuth callers: whether a dft_ token lies inside the connection's websites and scopes. */
function tokenWithinConnection(tc: ToolContext, token: TokenDto): boolean {
  const conn = tc.caller.connection;
  if (!conn) return true;
  const perms = permissionsOfScopes(conn.scopes);
  return (
    token.websiteIds.length > 0 &&
    token.websiteIds.every((id) => conn.siteIds.includes(id)) &&
    grantsWithin(token.permissions, perms)
  );
}

export const accountTools: ToolDef[] = [
  {
    name: "whoami",
    title: "Who am I",
    description:
      "The signed-in account, the credential in use (type, permissions or OAuth scopes, website access) and, when allowed, the accessible websites.",
    input: z.object({}).strict(),
    access: "read",
    permission: "analytics:read",
    oauth: [],
    owner: "F0",
    site: false,
    run: async (_args: Args, tc: ToolContext) => {
      const { caller } = tc;
      const conn = caller.connection;
      const out: Record<string, unknown> = {};
      if (!conn || caller.oauthScopes.includes("account:read")) {
        const account = await tc.call({ method: "GET", path: "/api/v1/admin/account" });
        if (account.status !== 200) return { status: account.status, body: account.body };
        out.account = (account.body as { data?: unknown[] }).data?.[0] ?? null;
      } else {
        out.account = { name: caller.auth.user.name, note: "account:read was not granted" };
      }
      out.credential = conn
        ? {
            type: "oauth",
            connectionId: conn.id,
            clientId: conn.clientId,
            scopes: conn.scopes,
            websiteIds: conn.siteIds,
            includesPersonalData: caller.auth.includePii,
            expiresAt: new Date(conn.expiresAt).toISOString(),
          }
        : {
            type: caller.auth.kind === "site_key" ? "website_key" : "account_token",
            permissions: caller.auth.scopes,
            websiteIds: caller.auth.websiteIds,
            includesPersonalData: caller.auth.includePii,
          };
      if (canUse(tc, "websites:read", "websites:read")) {
        const sites = await tc.call(
          { method: "GET", path: "/api/v1/admin/websites" },
          { grants: ["websites:read"] },
        );
        if (sites.status === 200) out.websites = (sites.body as { data?: unknown }).data;
      }
      return { status: 200, body: { status: "success", data: out } };
    },
  },
  {
    name: "account_update",
    title: "Update account name",
    description: "Change your display name.",
    input: z.object({ name: z.string().trim().min(1).max(100) }).strict(),
    access: "write",
    permission: "analytics:read",
    oauth: ["account:write"],
    owner: "F0",
    site: false,
    request: (args) => ({
      method: "PUT",
      path: "/api/v1/admin/account",
      body: { name: args.name },
    }),
  },
  {
    name: "access_tokens_list",
    title: "List account tokens",
    description: "Your dft_ account tokens (metadata only; secrets are never returned).",
    input: z.object({}).strict(),
    access: "read",
    permission: "api-keys:read",
    oauth: ["access-tokens:read"],
    owner: "F0",
    site: false,
    request: () => ({ method: "GET", path: "/api/v1/admin/access-tokens" }),
    after: async (_args, result, tc) => {
      if (!tc.caller.connection || result.status !== 200) return undefined;
      const body = result.body as { data?: TokenDto[] };
      const data = (body.data ?? []).filter((t) => tokenWithinConnection(tc, t));
      return { ...result, body: { ...body, data } };
    },
  },
  {
    name: "access_tokens_create",
    title: "Create account token",
    description:
      'Mint a dft_ token, never broader than the calling credential; the value is returned once. permissions: e.g. ["analytics:read","websites:read"] or ["*"] (not with OAuth). websiteIds: [] = all websites. With OAuth, the token is limited to the connection\'s websites and permissions and expires with it.',
    input: z
      .object({
        name: z.string().max(100).optional(),
        permissions: z.array(z.string().max(40)).min(1).max(40).optional(),
        websiteIds: z.array(z.string().min(1).max(64)).max(100).optional(),
        includePii: z.boolean().optional(),
        expiresInDays: z.number().int().min(1).max(3650).optional(),
      })
      .strict(),
    access: "write",
    destructive: true,
    permission: "api-keys:write",
    oauth: ["access-tokens:write"],
    owner: "F0",
    site: false,
    guard: (args, tc) => {
      const conn = tc.caller.connection;
      if (!conn) return;
      const perms = permissionsOfScopes(conn.scopes);
      const asked: string[] = args.permissions ?? perms;
      if (asked.includes("*") || !asked.every((p) => isPermission(p) && perms.includes(p))) {
        throw new ToolError(
          `With OAuth, permissions must be a subset of this connection's: ${perms.join(", ") || "(none)"}`,
        );
      }
      const sites: string[] = args.websiteIds ?? conn.siteIds;
      if (sites.length === 0 || !sites.every((id) => conn.siteIds.includes(id))) {
        throw new ToolError(
          "With OAuth, websiteIds must be a non-empty subset of this connection's websites",
        );
      }
    },
    request: (args, tc) => {
      const conn = tc.caller.connection;
      const body: Record<string, unknown> = {};
      for (const k of ["name", "permissions", "websiteIds", "includePii", "expiresInDays"]) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      if (conn) {
        body.permissions ??= permissionsOfScopes(conn.scopes);
        body.websiteIds ??= conn.siteIds;
      }
      return { method: "POST", path: "/api/v1/admin/access-tokens", body };
    },
    after: async (_args, result, tc) => {
      if (result.status === 200) {
        const id = (result.body as { data?: Array<{ id?: unknown }> })?.data?.[0]?.id;
        await bindToConnection(tc, id);
      }
      return undefined;
    },
  },
  {
    name: "access_tokens_delete",
    title: "Delete account token",
    description: "Permanently revoke one of your dft_ tokens.",
    input: z.object({ tokenId: z.string().min(1).max(64) }).strict(),
    access: "write",
    destructive: true,
    permission: "api-keys:write",
    oauth: ["access-tokens:write"],
    owner: "F0",
    site: false,
    guard: async (args, tc) => {
      if (!tc.caller.connection) return;
      const list = await tc.call(
        { method: "GET", path: "/api/v1/admin/access-tokens" },
        { grants: ["api-keys:read"] },
      );
      const tokens = ((list.body as { data?: TokenDto[] })?.data ?? []).filter((t) =>
        tokenWithinConnection(tc, t),
      );
      if (!tokens.some((t) => t.id === args.tokenId)) {
        throw new ToolError("Access token not found within this connection's access");
      }
    },
    request: (args) => ({
      method: "DELETE",
      path: `/api/v1/admin/access-tokens/${enc(args.tokenId)}`,
    }),
  },
];
