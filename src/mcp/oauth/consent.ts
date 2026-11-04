/**
 * Consent requests: the validated authorization request travels from `GET /oauth/authorize` to the
 * consent page and back to `POST /oauth/authorize` as a signed, 10-minute token, so nothing is
 * written to D1 until the user approves. A nonce cookie binds the request to the browser that
 * started it.
 */
import { hmacSha256Base64Url, timingSafeEqual } from "../../lib/crypto";
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "../../lib/encoding";
import { randomToken } from "../../lib/ids";

export const CONSENT_TTL_MS = 10 * 60_000;
export const CONSENT_COOKIE = "dg_oauth_consent";

export interface ConsentRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  /** Scopes the client asked for (supported ones only; may be empty). */
  scopes: string[];
  resource: string;
  expiresAt: number;
  nonce: string;
}

interface Payload {
  v: 1;
  c: string;
  r: string;
  cc: string;
  s: string | null;
  sc: string[];
  res: string;
  e: number;
  n: string;
}

const label = (body: string) => `oauth-consent:v1:${body}`;

export async function signConsentRequest(
  secret: string,
  input: Omit<ConsentRequest, "expiresAt" | "nonce">,
  now: number,
): Promise<{ token: string; request: ConsentRequest }> {
  const request: ConsentRequest = {
    ...input,
    expiresAt: now + CONSENT_TTL_MS,
    nonce: randomToken(18),
  };
  const payload: Payload = {
    v: 1,
    c: request.clientId,
    r: request.redirectUri,
    cc: request.codeChallenge,
    s: request.state,
    sc: request.scopes,
    res: request.resource,
    e: request.expiresAt,
    n: request.nonce,
  };
  const body = toBase64Url(utf8(JSON.stringify(payload)));
  const sig = await hmacSha256Base64Url(secret, label(body));
  return { token: `${body}.${sig}`, request };
}

export type ConsentProblem = "invalid" | "expired";

/** Verify a consent token. Returns the request or the reason it is unusable. */
export async function verifyConsentRequest(
  secret: string,
  token: string,
  now: number,
): Promise<ConsentRequest | ConsentProblem> {
  if (!token || token.length > 8000) return "invalid";
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return "invalid";
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacSha256Base64Url(secret, label(body));
  if (!timingSafeEqual(expected, sig)) return "invalid";
  let payload: Payload;
  try {
    payload = JSON.parse(fromUtf8(fromBase64Url(body))) as Payload;
  } catch {
    return "invalid";
  }
  if (payload.v !== 1) return "invalid";
  if (payload.e <= now) return "expired";
  return {
    clientId: payload.c,
    redirectUri: payload.r,
    codeChallenge: payload.cc,
    state: payload.s,
    scopes: payload.sc,
    resource: payload.res,
    expiresAt: payload.e,
    nonce: payload.n,
  };
}

/** Build the client redirect with OAuth response parameters (RFC 6749 §4.1.2, RFC 9207 iss). */
export function clientRedirect(
  redirectUri: string,
  params: Record<string, string | null | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined) url.searchParams.set(k, v);
  }
  return url.toString();
}
