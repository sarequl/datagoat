/**
 * MCP and OAuth test helpers: JSON-RPC calls to /mcp and a complete OAuth authorization flow
 * through the real endpoints (register → authorize → consent decision → token).
 */
import { exports } from "cloudflare:workers";
import { expect } from "vitest";
import { sha256 } from "../../../src/lib/crypto";
import { toBase64Url } from "../../../src/lib/encoding";
import { randomBase62 } from "../../../src/lib/ids";
import { sessionCookie } from "../../helpers/factories";
import { cookieFrom, ORIGIN } from "../../helpers/http";

const worker = () => (exports as unknown as { default: Fetcher }).default;

export interface RawResponse {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: tests inspect arbitrary JSON
  body: any;
  cookies: string[];
}

/** fetch the Worker without following redirects. */
export async function raw(path: string, init: RequestInit = {}): Promise<RawResponse> {
  const res = await worker().fetch(
    new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }),
  );
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep text
  }
  return { status: res.status, headers: res.headers, body, cookies: res.headers.getSetCookie() };
}

let rpcId = 0;

/** POST one JSON-RPC message (or batch) to /mcp. */
export async function rpc(
  token: string | null,
  body: unknown,
  options: { path?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(options.headers ?? {}),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return raw(options.path ?? "/mcp", { method: "POST", headers, body: JSON.stringify(body) });
}

export function request(method: string, params?: Record<string, unknown>) {
  rpcId += 1;
  return { jsonrpc: "2.0", id: rpcId, method, ...(params ? { params } : {}) };
}

export interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  // biome-ignore lint/suspicious/noExplicitAny: tests inspect arbitrary JSON
  structuredContent?: any;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/** Call a tool and return the MCP result (asserting the JSON-RPC layer succeeded). */
export async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  path = "/mcp",
): Promise<ToolCallResult> {
  const res = await rpc(token, request("tools/call", { name, arguments: args }), { path });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.error, JSON.stringify(res.body.error)).toBeUndefined();
  return res.body.result as ToolCallResult;
}

/** The 501 message of an endpoint another team has not merged yet, or null. */
export function pendingOwner(result: ToolCallResult): string | null {
  if (!result.isError) return null;
  const msg = String(result.structuredContent?.error?.message ?? "");
  const m = /Not implemented yet: .* \(owner: (W\d)\)/.exec(msg);
  return m ? (m[1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase62(64);
  return { verifier, challenge: toBase64Url(await sha256(verifier)) };
}

export const REDIRECT = "https://client.example/callback";

export async function registerClient(
  metadata: Record<string, unknown> = {},
): Promise<{ clientId: string; clientSecret?: string }> {
  const res = await raw("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Agent",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      ...metadata,
    }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { clientId: res.body.client_id, clientSecret: res.body.client_secret };
}

export interface AuthorizeStart {
  requestToken: string;
  consentCookie: string;
  location: string;
}

export async function startAuthorize(
  params: Record<string, string>,
): Promise<RawResponse & { location: string }> {
  const res = await raw(`/oauth/authorize?${new URLSearchParams(params)}`);
  return { ...res, location: res.headers.get("location") ?? "" };
}

export async function beginConsent(
  clientId: string,
  challenge: string,
  extra: Record<string, string> = {},
): Promise<AuthorizeStart> {
  const res = await startAuthorize({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz-state",
    resource: `${ORIGIN}/mcp`,
    ...extra,
  });
  expect(res.status).toBe(302);
  const loc = new URL(res.location, ORIGIN);
  expect(loc.pathname).toBe("/oauth/consent");
  const requestToken = loc.searchParams.get("request");
  expect(requestToken).toBeTruthy();
  const consentCookie = cookieFrom(res.cookies, "dg_oauth_consent");
  expect(consentCookie).toBeTruthy();
  return {
    requestToken: requestToken as string,
    consentCookie: consentCookie as string,
    location: res.location,
  };
}

export async function decide(
  start: AuthorizeStart,
  sessionCookieValue: string,
  body: { approve: boolean; scopes?: string[]; websiteIds?: string[] },
  options: { cookie?: string } = {},
): Promise<RawResponse> {
  return raw("/oauth/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      cookie: options.cookie ?? `${sessionCookieValue}; ${start.consentCookie}`,
    },
    body: JSON.stringify({ request: start.requestToken, ...body }),
  });
}

export async function tokenRequest(
  params: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return raw("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });
}

export interface Connected {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  scope: string;
  verifier: string;
}

/** Run the whole authorization code flow for `userId` and return the tokens. */
export async function connect(
  userId: string,
  scopes: string[],
  websiteIds: string[],
  options: { resource?: string } = {},
): Promise<Connected> {
  const { clientId } = await registerClient();
  const { verifier, challenge } = await pkcePair();
  const resource = options.resource ?? `${ORIGIN}/mcp`;
  const start = await beginConsent(clientId, challenge, { resource });
  const session = await sessionCookie(userId);
  const decision = await decide(start, session, { approve: true, scopes, websiteIds });
  expect(decision.status, JSON.stringify(decision.body)).toBe(200);
  const redirect = new URL(decision.body.data.redirectTo);
  const code = redirect.searchParams.get("code") as string;
  expect(redirect.searchParams.get("state")).toBe("xyz-state");
  expect(redirect.searchParams.get("iss")).toBe(ORIGIN);
  const token = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource,
  });
  expect(token.status, JSON.stringify(token.body)).toBe(200);
  return {
    clientId,
    accessToken: token.body.access_token,
    refreshToken: token.body.refresh_token,
    scope: token.body.scope,
    verifier,
  };
}
