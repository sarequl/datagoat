/**
 * OAuth 2.1 authorization server for MCP clients (Claude, ChatGPT, Cursor, Codex, …):
 *
 *   GET  /.well-known/oauth-authorization-server     RFC 8414 metadata
 *   GET  /.well-known/oauth-protected-resource[/mcp|/api/mcp]   RFC 9728 metadata
 *   POST /oauth/register      RFC 7591 dynamic client registration
 *   GET  /oauth/authorize     validate, then redirect to the consent page (/oauth/consent)
 *   GET  /oauth/consent/details   what the consent page shows (signed request + session)
 *   POST /oauth/authorize     the user's decision (session cookie, same origin)
 *   POST /oauth/token         authorization_code (PKCE S256) and refresh_token (rotating)
 *   POST /oauth/revoke        RFC 7009
 *
 * Only the authorization code grant with PKCE S256 exists: no implicit, password or plain PKCE.
 * Responses carry `iss` (RFC 9207). Tokens are bound to the exact MCP resource (RFC 8707).
 */
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { OAuthConsentDetails, OAuthDecisionResult } from "../../../shared/api-types";
import { listUserSiteRows } from "../../auth/memberships";
import { sameOriginGuard } from "../../auth/middleware";
import { readSession } from "../../auth/sessions";
import { sha256 } from "../../lib/crypto";
import { toBase64Url } from "../../lib/encoding";
import { ApiError } from "../../lib/errors";
import { log } from "../../lib/log";
import { success } from "../../lib/response";
import { parseJsonBody } from "../../lib/validate";
import type { AppEnv } from "../../types";
import { mcpResources } from "../auth";
import { CORS_HEADERS } from "../server";
import {
  ClientError,
  findClient,
  type OAuthClient,
  redirectUriMatches,
  registerClient,
  secretMatches,
  validateClientMetadata,
} from "./clients";
import {
  CONSENT_COOKIE,
  clientRedirect,
  signConsentRequest,
  verifyConsentRequest,
} from "./consent";
import { DEFAULT_SCOPES, OAUTH_SCOPES, parseScopeParam, SUPPORTED_SCOPES } from "./scopes";
import {
  connectionIsLive,
  consumeCode,
  findCode,
  findToken,
  hashToken,
  loadConnection,
  prepareConnectionAndCode,
  prepareTokenPair,
  revokeAccessToken,
  revokeConnection,
  rotateRefreshToken,
} from "./store";

export const oauthRoutes = new Hono<AppEnv>();

const originOf = (c: Context) => new URL(c.req.url).origin;

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

function oauthJson(
  body: unknown,
  status: 200 | 201 | 400 | 401 | 429 | 503 = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...NO_STORE, ...CORS_HEADERS, ...headers },
  });
}

function oauthError(
  error: string,
  description: string,
  status: 400 | 401 | 429 | 503 = 400,
  headers: Record<string, string> = {},
): Response {
  return oauthJson({ error, error_description: description }, status, headers);
}

/** Per-IP limits on the unauthenticated OAuth endpoints (Workers Rate Limiting, no storage). */
async function rateLimited(c: Context<AppEnv>, bucket: string): Promise<boolean> {
  const ip = c.req.header("cf-connecting-ip");
  if (!ip) return false;
  const outcome = await c.env.API_LIMITER.limit({ key: `oauth:${bucket}:${ip}` });
  return !outcome.success;
}

const preflight = (c: Context) => c.body(null, 204, CORS_HEADERS);

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ],
    scopes_supported: SUPPORTED_SCOPES,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    service_documentation: "https://github.com/sarequl/datagoat/blob/main/docs/mcp.md",
  };
}

function protectedResource(origin: string, path: "/mcp" | "/api/mcp") {
  return {
    resource: `${origin}${path}`,
    authorization_servers: [origin],
    scopes_supported: SUPPORTED_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "DataGoat analytics",
    resource_documentation: "https://github.com/sarequl/datagoat/blob/main/docs/mcp.md",
  };
}

const publicJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "Cache-Control": "public, max-age=300",
      ...CORS_HEADERS,
    },
  });

for (const path of [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
  "/.well-known/oauth-authorization-server/api/mcp",
]) {
  oauthRoutes.get(path, (c) => publicJson(authorizationServerMetadata(originOf(c))));
  oauthRoutes.options(path, preflight);
}
oauthRoutes.get("/.well-known/oauth-protected-resource", (c) =>
  publicJson(protectedResource(originOf(c), "/mcp")),
);
oauthRoutes.get("/.well-known/oauth-protected-resource/mcp", (c) =>
  publicJson(protectedResource(originOf(c), "/mcp")),
);
oauthRoutes.get("/.well-known/oauth-protected-resource/api/mcp", (c) =>
  publicJson(protectedResource(originOf(c), "/api/mcp")),
);
for (const path of [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-protected-resource/api/mcp",
]) {
  oauthRoutes.options(path, preflight);
}

// ---------------------------------------------------------------------------
// Dynamic client registration
// ---------------------------------------------------------------------------

oauthRoutes.options("/oauth/register", preflight);
oauthRoutes.post("/oauth/register", async (c) => {
  if (await rateLimited(c, "register")) {
    return oauthError("temporarily_unavailable", "Too many registrations; retry later", 429);
  }
  const text = await c.req.text();
  if (text.length > 16 * 1024) {
    return oauthError("invalid_client_metadata", "Registration request is too large");
  }
  let input: unknown;
  try {
    input = JSON.parse(text || "null");
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON");
  }
  try {
    const metadata = validateClientMetadata(input);
    const now = Date.now();
    const { client, secret } = await registerClient(c.env.DB, metadata, now);
    log.info("oauth.client_registered", { clientId: client.id, method: client.authMethod });
    return oauthJson(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(now / 1000),
        ...(secret
          ? {
              client_secret: secret,
              client_secret_expires_at: Math.floor((client.expiresAt ?? 0) / 1000),
            }
          : {}),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: client.authMethod,
        grant_types: client.grantTypes,
        response_types: ["code"],
        ...metadata.stored,
      },
      201,
    );
  } catch (err) {
    if (err instanceof ClientError) return oauthError(err.code, err.message);
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Authorization endpoint
// ---------------------------------------------------------------------------

function consentPageError(c: Context, error: string, description: string): Response {
  const qs = new URLSearchParams({ error, error_description: description });
  return c.redirect(`/oauth/consent?${qs}`, 302);
}

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

async function loadClient(c: Context<AppEnv>, clientId: string, now: number) {
  try {
    return await findClient(c.env.DB, clientId, now);
  } catch (err) {
    if (err instanceof ClientError) return err;
    throw err;
  }
}

oauthRoutes.get("/oauth/authorize", async (c) => {
  const origin = originOf(c);
  const q = c.req.query();
  const now = Date.now();
  if (!q.client_id) return consentPageError(c, "invalid_request", "client_id is required");
  const client = await loadClient(c, q.client_id, now);
  if (client instanceof ClientError) return consentPageError(c, "invalid_client", client.message);
  if (!client) {
    return consentPageError(
      c,
      "invalid_client",
      "Unknown client. The app must register with DataGoat first (it usually does this automatically).",
    );
  }
  const redirectUri =
    q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
    return consentPageError(
      c,
      "invalid_request",
      "redirect_uri does not match the app's registration",
    );
  }
  const back = (error: string, description: string) =>
    c.redirect(
      clientRedirect(redirectUri, {
        error,
        error_description: description,
        state: q.state,
        iss: origin,
      }),
      302,
    );
  if (q.response_type !== "code") {
    return back("unsupported_response_type", "Only response_type=code is supported");
  }
  if (!q.code_challenge || !CHALLENGE_RE.test(q.code_challenge)) {
    return back("invalid_request", "A PKCE code_challenge (S256) is required");
  }
  if ((q.code_challenge_method ?? "plain") !== "S256") {
    return back("invalid_request", "code_challenge_method must be S256");
  }
  if (q.state && q.state.length > 2000) return back("invalid_request", "state is too long");
  const resource = q.resource ?? `${origin}/mcp`;
  if (!mcpResources(origin).includes(resource)) {
    return back("invalid_target", `resource must be ${origin}/mcp`);
  }
  const { token, request } = await signConsentRequest(
    c.env.SESSION_SECRET,
    {
      clientId: client.id,
      redirectUri,
      codeChallenge: q.code_challenge,
      state: q.state ?? null,
      scopes: parseScopeParam(q.scope),
      resource,
    },
    now,
  );
  setCookie(c, CONSENT_COOKIE, request.nonce, {
    path: "/oauth",
    httpOnly: true,
    secure: origin.startsWith("https://") || new URL(origin).hostname === "localhost",
    sameSite: "Lax",
    maxAge: 600,
  });
  c.header("Referrer-Policy", "no-referrer");
  return c.redirect(`/oauth/consent?request=${encodeURIComponent(token)}`, 302);
});

/** The consent page itself: the dashboard SPA, framed by nobody. */
oauthRoutes.get("/oauth/consent", async (c) => {
  const res = await c.env.ASSETS.fetch(new Request(new URL("/", c.req.url)));
  const headers = new Headers(res.headers);
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers });
});

async function requireConsentRequest(c: Context<AppEnv>, token: string | undefined) {
  if (!token) throw new ApiError(400, "request is required");
  const verified = await verifyConsentRequest(c.env.SESSION_SECRET, token, Date.now());
  if (verified === "expired") {
    throw new ApiError(410, "This authorization request expired. Start again from your app.");
  }
  if (verified === "invalid") throw new ApiError(400, "Invalid authorization request");
  return verified;
}

async function clientForRequest(c: Context<AppEnv>, clientId: string): Promise<OAuthClient> {
  const client = await loadClient(c, clientId, Date.now());
  if (!client || client instanceof ClientError) throw new ApiError(400, "Unknown client");
  return client;
}

oauthRoutes.get("/oauth/consent/details", async (c) => {
  const request = await requireConsentRequest(c, c.req.query("request"));
  const client = await clientForRequest(c, request.clientId);
  const session = await readSession(c);
  const websites = session
    ? (await listUserSiteRows(c.env.DB, session.user.id)).map((row) => ({
        _id: String(row.id),
        domain: String(row.domain),
        name: (row.name as string | null) ?? null,
        role: String(row.member_role) as "owner" | "member" | "viewer",
      }))
    : [];
  const asked = new Set(request.scopes);
  const details: OAuthConsentDetails = {
    client: {
      id: client.id,
      name: client.name,
      clientUri: client.clientUri,
      logoUri: client.logoUri,
      redirectUri: request.redirectUri,
      redirectHost: redirectHostOf(request.redirectUri),
    },
    scopes: OAUTH_SCOPES.map((s) => ({
      ...s,
      requested: asked.has(s.scope),
      defaultChecked:
        !s.sensitive &&
        s.access === "read" &&
        (asked.size ? asked.has(s.scope) : DEFAULT_SCOPES.includes(s.scope)),
    })),
    resource: request.resource,
    expiresAt: new Date(request.expiresAt).toISOString(),
    user: session
      ? {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
          image: session.user.image,
          createdAt: new Date(session.user.createdAt).toISOString(),
        }
      : null,
    websites,
  };
  return success(c, details, { headers: { "Referrer-Policy": "no-referrer" } });
});

function redirectHostOf(uri: string): string {
  try {
    const url = new URL(uri);
    return url.host || `${url.protocol}//`;
  } catch {
    return uri;
  }
}

const DecisionBody = z
  .object({
    request: z.string().min(1).max(8000),
    approve: z.boolean(),
    scopes: z.array(z.string().max(64)).max(64).optional(),
    websiteIds: z.array(z.string().max(64)).max(500).optional(),
  })
  .strict();

oauthRoutes.post("/oauth/authorize", sameOriginGuard, async (c) => {
  const body = await parseJsonBody(c, DecisionBody);
  const request = await requireConsentRequest(c, body.request);
  const session = await readSession(c);
  if (!session) throw new ApiError(401, "Sign in to approve this app");
  if (getCookie(c, CONSENT_COOKIE) !== request.nonce) {
    throw new ApiError(
      403,
      "This authorization request was started in another browser or has been replaced. Start again from your app.",
    );
  }
  const origin = originOf(c);
  const client = await clientForRequest(c, request.clientId);
  if (!body.approve) {
    deleteCookie(c, CONSENT_COOKIE, { path: "/oauth" });
    const result: OAuthDecisionResult = {
      redirectTo: clientRedirect(request.redirectUri, {
        error: "access_denied",
        error_description: "The user declined access",
        state: request.state,
        iss: origin,
      }),
    };
    return success(c, result);
  }
  const scopes = [...new Set(body.scopes ?? [])];
  const unknown = scopes.filter((s) => !SUPPORTED_SCOPES.includes(s));
  if (unknown.length) throw new ApiError(400, `Unknown permissions: ${unknown.join(", ")}`);
  if (scopes.length === 0) throw new ApiError(400, "Select at least one permission");
  const sites = await listUserSiteRows(c.env.DB, session.user.id);
  const siteIds = [...new Set(body.websiteIds ?? [])];
  const mine = new Set(sites.map((r) => String(r.id)));
  const foreign = siteIds.filter((id) => !mine.has(id));
  if (foreign.length) throw new ApiError(400, `Unknown websites: ${foreign.join(", ")}`);
  if (scopes.includes("account-usage:read")) {
    const owned = sites.filter((r) => r.member_role === "owner").map((r) => String(r.id));
    if (!owned.every((id) => siteIds.includes(id))) {
      throw new ApiError(
        400,
        "Bot traffic usage (account-usage:read) needs every website you own to be selected",
      );
    }
  }
  const now = Date.now();
  const created = await prepareConnectionAndCode(
    c.env.DB,
    {
      userId: session.user.id,
      clientId: client.id,
      scopes: SUPPORTED_SCOPES.filter((s) => scopes.includes(s)),
      siteIds,
      resource: request.resource,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
    },
    now,
  );
  await c.env.DB.batch(created.statements);
  deleteCookie(c, CONSENT_COOKIE, { path: "/oauth" });
  log.info("oauth.connection_approved", {
    connectionId: created.connectionId,
    clientId: client.id,
    scopes: scopes.length,
    sites: siteIds.length,
  });
  const result: OAuthDecisionResult = {
    redirectTo: clientRedirect(request.redirectUri, {
      code: created.code,
      state: request.state,
      iss: origin,
    }),
  };
  return success(c, result);
});

// ---------------------------------------------------------------------------
// Token and revocation endpoints
// ---------------------------------------------------------------------------

async function readParams(c: Context): Promise<Record<string, string>> {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  const text = await c.req.text();
  if (text.length > 16 * 1024) return {};
  if (type.includes("application/json")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(obj).filter((e): e is [string, string] => typeof e[1] === "string"),
      );
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function basicCredentials(header: string | undefined): { id: string; secret: string } | null {
  const m = header ? /^Basic\s+(\S+)$/i.exec(header) : null;
  if (!m?.[1]) return null;
  try {
    const decoded = atob(m[1]);
    const i = decoded.indexOf(":");
    if (i < 0) return null;
    return {
      id: decodeURIComponent(decoded.slice(0, i)),
      secret: decodeURIComponent(decoded.slice(i + 1)),
    };
  } catch {
    return null;
  }
}

type ClientAuth = { client: OAuthClient } | { error: Response };

async function authenticateClient(
  c: Context<AppEnv>,
  params: Record<string, string>,
): Promise<ClientAuth> {
  const basic = basicCredentials(c.req.header("authorization"));
  const clientId = basic?.id ?? params.client_id;
  const invalid = (description: string) => ({
    error: oauthError(
      "invalid_client",
      description,
      401,
      basic ? { "WWW-Authenticate": 'Basic realm="DataGoat"' } : {},
    ),
  });
  if (!clientId) return invalid("Client authentication failed: client_id is missing");
  if (basic && params.client_id && params.client_id !== basic.id) {
    return { error: oauthError("invalid_request", "client_id does not match the credentials") };
  }
  const client = await loadClient(c, clientId, Date.now());
  if (!client || client instanceof ClientError) return invalid("Unknown client");
  if (client.authMethod !== "none") {
    const secret = basic?.secret ?? params.client_secret;
    if (!secret || !(await secretMatches(client, secret))) {
      return invalid("Client authentication failed");
    }
  }
  return { client };
}

async function pkceS256(verifier: string): Promise<string> {
  return toBase64Url(await sha256(verifier));
}

const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

function tokenResponse(tokens: {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  scopes: string[];
  now: number;
}): Response {
  return oauthJson({
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: Math.max(1, Math.floor((tokens.accessExpiresAt - tokens.now) / 1000)),
    refresh_token: tokens.refreshToken,
    scope: tokens.scopes.join(" "),
  });
}

oauthRoutes.options("/oauth/token", preflight);
oauthRoutes.post("/oauth/token", async (c) => {
  if (await rateLimited(c, "token")) {
    return oauthError("temporarily_unavailable", "Too many token requests; retry later", 429);
  }
  const params = await readParams(c);
  const auth = await authenticateClient(c, params);
  if ("error" in auth) return auth.error;
  const { client } = auth;
  const db = c.env.DB;
  const now = Date.now();

  if (params.grant_type === "authorization_code") {
    if (!params.code || !params.code_verifier) {
      return oauthError("invalid_request", "code and code_verifier are required");
    }
    const code = await findCode(db, params.code);
    if (!code || code.client_id !== client.id) {
      return oauthError("invalid_grant", "Invalid authorization code");
    }
    if (code.consumed_at !== null) {
      await revokeConnection(db, code.connection_id, now);
      log.warn("oauth.code_replayed", { connectionId: code.connection_id });
      return oauthError(
        "invalid_grant",
        "Authorization code was already used; the connection has been revoked",
      );
    }
    if (code.expires_at <= now) return oauthError("invalid_grant", "Authorization code expired");
    const redirectUri = params.redirect_uri ?? code.redirect_uri;
    if (redirectUri !== code.redirect_uri) {
      return oauthError("invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (!VERIFIER_RE.test(params.code_verifier)) {
      return oauthError("invalid_grant", "Malformed code_verifier");
    }
    if ((await pkceS256(params.code_verifier)) !== code.code_challenge) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }
    if (params.resource && params.resource !== code.resource) {
      return oauthError("invalid_target", "resource does not match the authorization request");
    }
    if (!(await consumeCode(db, code.code_hash, now))) {
      await revokeConnection(db, code.connection_id, now);
      return oauthError(
        "invalid_grant",
        "Authorization code was already used; the connection has been revoked",
      );
    }
    const conn = await loadConnection(db, code.connection_id);
    if (!conn || !connectionIsLive(conn, now)) {
      return oauthError("invalid_grant", "The connection is no longer active");
    }
    const tokens = await prepareTokenPair(db, conn, now);
    await db.batch(tokens.statements);
    return tokenResponse({ ...tokens, scopes: conn.scopes, now });
  }

  if (params.grant_type === "refresh_token") {
    if (!params.refresh_token) return oauthError("invalid_request", "refresh_token is required");
    const row = await findToken(db, params.refresh_token);
    if (row?.kind !== "refresh" || row.client_id !== client.id) {
      return oauthError("invalid_grant", "Invalid refresh token");
    }
    if (row.revoked_at !== null) return oauthError("invalid_grant", "Refresh token was revoked");
    if (row.rotated_at !== null) {
      await revokeConnection(db, row.connection_id, now);
      log.warn("oauth.refresh_replayed", { connectionId: row.connection_id });
      return oauthError(
        "invalid_grant",
        "Refresh token was already used; the connection has been revoked. Reconnect the app.",
      );
    }
    if (row.expires_at <= now) {
      return oauthError("invalid_grant", "Refresh token expired. Reconnect the app.");
    }
    if (params.resource && params.resource !== row.resource) {
      return oauthError("invalid_target", "resource does not match the connection");
    }
    const conn = await loadConnection(db, row.connection_id);
    if (!conn || !connectionIsLive(conn, now)) {
      return oauthError(
        "invalid_grant",
        "The connection expired or was revoked. Reconnect the app.",
      );
    }
    if (!(await rotateRefreshToken(db, row.token_hash, now))) {
      await revokeConnection(db, row.connection_id, now);
      return oauthError(
        "invalid_grant",
        "Refresh token was already used; the connection has been revoked. Reconnect the app.",
      );
    }
    const tokens = await prepareTokenPair(db, conn, now);
    await db.batch(tokens.statements);
    return tokenResponse({ ...tokens, scopes: conn.scopes, now });
  }

  return oauthError(
    "unsupported_grant_type",
    "grant_type must be authorization_code or refresh_token",
  );
});

oauthRoutes.options("/oauth/revoke", preflight);
oauthRoutes.post("/oauth/revoke", async (c) => {
  if (await rateLimited(c, "token")) {
    return oauthError("temporarily_unavailable", "Too many requests; retry later", 429);
  }
  const params = await readParams(c);
  const auth = await authenticateClient(c, params);
  if ("error" in auth) return auth.error;
  if (!params.token) return oauthError("invalid_request", "token is required");
  const now = Date.now();
  const row = await findToken(c.env.DB, params.token);
  // RFC 7009: unknown tokens and tokens of other clients are answered with 200 too.
  if (row && row.client_id === auth.client.id) {
    if (row.kind === "refresh") await revokeConnection(c.env.DB, row.connection_id, now);
    else await revokeAccessToken(c.env.DB, await hashToken(params.token), now);
  }
  return oauthJson({});
});
