/**
 * Short-lived signed tokens for the Shopify OAuth `state` and the WooCommerce `user_id` round trip.
 * Stateless (no D1 or KV write): `base64url(JSON).base64url(HMAC-SHA256)` keyed by SESSION_SECRET
 * with a per-purpose prefix, so a token minted for one flow is useless in another.
 */
import { hmacSha256Base64Url, timingSafeEqual } from "../lib/crypto";
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "../lib/encoding";
import { randomToken } from "../lib/ids";

export interface StatePayload {
  /** Purpose, e.g. "shopify-oauth". */
  p: string;
  /** Expiry, epoch ms. */
  exp: number;
  /** Random nonce. */
  n: string;
  [key: string]: unknown;
}

function key(secret: string, purpose: string): string {
  return `datagoat:${purpose}:${secret}`;
}

export async function signState(
  secret: string,
  purpose: string,
  data: Record<string, unknown>,
  ttlMs: number,
  now = Date.now(),
): Promise<string> {
  const payload: StatePayload = { ...data, p: purpose, exp: now + ttlMs, n: randomToken(12) };
  const body = toBase64Url(utf8(JSON.stringify(payload)));
  return `${body}.${await hmacSha256Base64Url(key(secret, purpose), body)}`;
}

/** Returns the payload, or null when the token is malformed, forged, for another purpose or expired. */
export async function verifyState(
  secret: string,
  purpose: string,
  token: string,
  now = Date.now(),
): Promise<StatePayload | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || token.length > 2048) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = await hmacSha256Base64Url(key(secret, purpose), body);
  if (!timingSafeEqual(expected, mac)) return null;
  let payload: StatePayload;
  try {
    payload = JSON.parse(fromUtf8(fromBase64Url(body))) as StatePayload;
  } catch {
    return null;
  }
  if (payload.p !== purpose || typeof payload.exp !== "number" || payload.exp <= now) return null;
  return payload;
}
