/**
 * OAuth 2.0 connect flows for the growth integrations, built from each provider's public docs:
 *
 * - GitHub (OAuth app or GitHub App user token):
 *   https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 * - Google Search Console (Google OAuth 2.0 for web server apps, offline access):
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 * - Meta Marketing API (Facebook Login, then a long-lived token):
 *   https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 *   https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
 * - X API v2 (OAuth 2.0 authorization code with PKCE):
 *   https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code
 *
 * The `state` parameter is a signed (HMAC-SHA256, SESSION_SECRET), expiring payload naming the
 * site, user and provider; a short-lived HttpOnly cookie binds it to the browser and carries the
 * PKCE verifier. Nothing is written to D1 until the callback stores the encrypted credentials.
 */
import { hmacSha256Base64Url, sha256, timingSafeEqual } from "../../lib/crypto";
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "../../lib/encoding";
import { randomToken } from "../../lib/ids";
import type { IntegrationKind, OAuthCredentials } from "../shared/connections";
import { type Fetcher, ProviderError, requestJson } from "../shared/http";

export const META_GRAPH = "https://graph.facebook.com/v23.0";

export interface OAuthProvider {
  kind: IntegrationKind;
  label: string;
  envId: keyof Cloudflare.Env & string;
  envSecret: keyof Cloudflare.Env & string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  scopeSeparator: string;
  pkce: boolean;
  /** How the client authenticates at the token endpoint. */
  clientAuth: "body" | "basic";
  extraParams?: Record<string, string>;
}

export const PROVIDERS: Record<IntegrationKind, OAuthProvider> = {
  github: {
    kind: "github",
    label: "GitHub",
    envId: "GITHUB_CLIENT_ID",
    envSecret: "GITHUB_CLIENT_SECRET",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    // `repo` is needed to read commits of private repositories (classic OAuth apps). GitHub Apps
    // ignore scopes and use the app's "Contents: read" permission instead.
    scopes: ["repo"],
    scopeSeparator: " ",
    pkce: false,
    clientAuth: "body",
  },
  gsc: {
    kind: "gsc",
    label: "Google Search Console",
    envId: "GOOGLE_CLIENT_ID",
    envSecret: "GOOGLE_CLIENT_SECRET",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    scopeSeparator: " ",
    pkce: true,
    clientAuth: "body",
    extraParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
  meta_ads: {
    kind: "meta_ads",
    label: "Meta Ads",
    envId: "META_APP_ID",
    envSecret: "META_APP_SECRET",
    authorizeUrl: "https://www.facebook.com/v23.0/dialog/oauth",
    tokenUrl: `${META_GRAPH}/oauth/access_token`,
    scopes: ["ads_read"],
    scopeSeparator: ",",
    pkce: false,
    clientAuth: "body",
  },
  x: {
    kind: "x",
    label: "X",
    envId: "X_CLIENT_ID",
    envSecret: "X_CLIENT_SECRET",
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read", "users.read", "offline.access"],
    scopeSeparator: " ",
    pkce: true,
    clientAuth: "basic",
  },
};

function envValue(env: Cloudflare.Env, key: string): string | undefined {
  const v = (env as unknown as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function oauthConfigured(env: Cloudflare.Env, kind: IntegrationKind): boolean {
  const p = PROVIDERS[kind];
  return Boolean(envValue(env, p.envId) && envValue(env, p.envSecret));
}

export function clientCredentials(
  env: Cloudflare.Env,
  kind: IntegrationKind,
): { id: string; secret: string } | null {
  const p = PROVIDERS[kind];
  const id = envValue(env, p.envId);
  const secret = envValue(env, p.envSecret);
  return id && secret ? { id, secret } : null;
}

// ---------------------------------------------------------------------------
// Signed state
// ---------------------------------------------------------------------------

export interface OAuthState {
  kind: IntegrationKind;
  siteId: string;
  userId: string;
  nonce: string;
  exp: number;
  returnTo: string;
}

export const STATE_TTL_MS = 10 * 60_000;
export const STATE_COOKIE = "dg_oauth";

export async function signState(secret: string, state: OAuthState): Promise<string> {
  const payload = toBase64Url(utf8(JSON.stringify(state)));
  const mac = await hmacSha256Base64Url(secret, `oauth-state:${payload}`);
  return `${payload}.${mac}`;
}

export async function verifyState(
  secret: string,
  value: string,
  now: number,
): Promise<OAuthState | null> {
  const [payload, mac] = value.split(".");
  if (!payload || !mac) return null;
  const expected = await hmacSha256Base64Url(secret, `oauth-state:${payload}`);
  if (!timingSafeEqual(expected, mac)) return null;
  let state: OAuthState;
  try {
    state = JSON.parse(fromUtf8(fromBase64Url(payload))) as OAuthState;
  } catch {
    return null;
  }
  if (typeof state.exp !== "number" || state.exp < now) return null;
  return state;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return toBase64Url(await sha256(verifier));
}

export function newVerifier(): string {
  return randomToken(48);
}

export function authorizeUrl(
  provider: OAuthProvider,
  clientId: string,
  redirectUri: string,
  state: string,
  challenge: string | null,
): string {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", provider.scopes.join(provider.scopeSeparator));
  url.searchParams.set("state", state);
  if (challenge) {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(provider.extraParams ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

function toCredentials(
  res: TokenResponse,
  provider: OAuthProvider,
  now: number,
  previous?: OAuthCredentials,
): OAuthCredentials {
  if (res.error || !res.access_token) {
    throw new ProviderError(
      provider.label,
      400,
      `${provider.label}: ${res.error_description ?? res.error ?? "no access token returned"}`,
    );
  }
  const expiresIn = Number(res.expires_in);
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    scope: res.scope ?? previous?.scope ?? null,
    via: "oauth",
  };
}

async function tokenRequest(
  fetcher: Fetcher,
  provider: OAuthProvider,
  client: { id: string; secret: string },
  params: Record<string, string>,
): Promise<TokenResponse> {
  const form = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (provider.clientAuth === "basic") {
    headers.authorization = `Basic ${btoa(`${client.id}:${client.secret}`)}`;
    form.set("client_id", client.id);
  } else {
    form.set("client_id", client.id);
    form.set("client_secret", client.secret);
  }
  return requestJson<TokenResponse>(fetcher, provider.label, provider.tokenUrl, {
    method: "POST",
    headers,
    body: form.toString(),
  });
}

export async function exchangeCode(
  fetcher: Fetcher,
  env: Cloudflare.Env,
  kind: IntegrationKind,
  code: string,
  redirectUri: string,
  verifier: string | null,
  now: number,
): Promise<OAuthCredentials> {
  const provider = PROVIDERS[kind];
  const client = clientCredentials(env, kind);
  if (!client) throw new ProviderError(provider.label, 503, `${provider.label} is not configured`);
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  };
  if (verifier) params.code_verifier = verifier;
  let creds = toCredentials(await tokenRequest(fetcher, provider, client, params), provider, now);
  if (kind === "meta_ads") {
    // Exchange the short-lived user token for a long-lived (~60 day) one.
    const url = new URL(`${META_GRAPH}/oauth/access_token`);
    url.searchParams.set("grant_type", "fb_exchange_token");
    url.searchParams.set("client_id", client.id);
    url.searchParams.set("client_secret", client.secret);
    url.searchParams.set("fb_exchange_token", creds.accessToken);
    const long = await requestJson<TokenResponse>(fetcher, provider.label, url.toString());
    creds = toCredentials(long, provider, now);
  }
  return creds;
}

/** Refresh the access token when it expires within 5 minutes. Returns null when still fresh. */
export async function refreshIfNeeded(
  fetcher: Fetcher,
  env: Cloudflare.Env,
  kind: IntegrationKind,
  creds: OAuthCredentials,
  now: number,
): Promise<OAuthCredentials | null> {
  if (!creds.expiresAt || creds.expiresAt - 5 * 60_000 > now) return null;
  const provider = PROVIDERS[kind];
  if (!creds.refreshToken) {
    throw new ProviderError(
      provider.label,
      401,
      `${provider.label}: access expired; reconnect the integration`,
    );
  }
  const client = clientCredentials(env, kind);
  if (!client) throw new ProviderError(provider.label, 503, `${provider.label} is not configured`);
  const res = await tokenRequest(fetcher, provider, client, {
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
  });
  return toCredentials(res, provider, now, creds);
}

/** Pages a callback may send the user back to (`/app/<siteId>/<page>`). */
export const RETURN_PAGES = ["integrations", "search-console", "ads", "mentions"] as const;
