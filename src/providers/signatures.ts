/**
 * Webhook signature schemes, all verified with Web Crypto HMAC-SHA256 before the body is parsed.
 *
 * | Provider      | Header(s)                                         | Signed content            | Encoding |
 * |---------------|---------------------------------------------------|---------------------------|----------|
 * | Stripe        | Stripe-Signature `t=..,v1=..`                     | `${t}.${body}`            | hex      |
 * | Polar, Dodo   | Standard Webhooks: webhook-id/-timestamp/-signature | `${id}.${ts}.${body}`   | base64   |
 * | Lemon Squeezy | X-Signature                                       | body                      | hex      |
 * | Paddle        | Paddle-Signature `ts=..;h1=..`                    | `${ts}:${body}`           | hex      |
 * | Creem         | creem-signature                                   | body                      | hex      |
 * | Shopify       | X-Shopify-Hmac-Sha256                             | body                      | base64   |
 * | WooCommerce   | X-WC-Webhook-Signature                            | body                      | base64   |
 *
 * Timestamped schemes reject deliveries older or newer than `TOLERANCE_SECONDS` (replay window).
 */
import { hmacSha256, timingSafeEqual } from "../lib/crypto";
import { fromBase64, toBase64, toHex, utf8 } from "../lib/encoding";

export const TOLERANCE_SECONDS = 300;

async function macHex(key: string | Uint8Array, data: string): Promise<string> {
  return toHex(await hmacSha256(key, data));
}

async function macBase64(key: string | Uint8Array, data: string): Promise<string> {
  return toBase64(await hmacSha256(key, data));
}

function withinTolerance(timestampSeconds: number, nowMs: number, tolerance: number): boolean {
  return (
    Number.isFinite(timestampSeconds) && Math.abs(nowMs / 1000 - timestampSeconds) <= tolerance
  );
}

/** Stripe: `Stripe-Signature: t=1700000000,v1=<hex>,v1=<hex>` over `${t}.${rawBody}`. */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowMs: number,
  tolerance = TOLERANCE_SECONDS,
): Promise<boolean> {
  if (!header || !secret) return false;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v) t = Number(v);
    else if (k === "v1" && v) v1.push(v.toLowerCase());
  }
  if (t === null || !v1.length || !withinTolerance(t, nowMs, tolerance)) return false;
  const expected = await macHex(secret, `${t}.${rawBody}`);
  return v1.some((sig) => timingSafeEqual(expected, sig));
}

/**
 * Standard Webhooks (standardwebhooks.com), used by Polar and Dodo Payments.
 * `webhook-signature` is a space-separated list of `v1,<base64>`.
 *
 * Keys: a `whsec_<base64>` secret is base64-decoded (the Standard Webhooks rule). Polar's older
 * secrets are plain strings whose UTF-8 bytes are the HMAC key (Polar's SDK base64-encodes the
 * raw secret before handing it to the Standard Webhooks library, which decodes it again); both
 * keys are tried, so endpoints created under either scheme verify.
 */
export async function verifyStandardWebhook(
  rawBody: string,
  headers: Headers,
  secret: string,
  nowMs: number,
  tolerance = TOLERANCE_SECONDS,
): Promise<{ id: string } | null> {
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature");
  if (!id || !ts || !sigHeader || !secret) return null;
  if (!withinTolerance(Number(ts), nowMs, tolerance)) return null;
  const signatures = sigHeader
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1,"))
    .map((s) => s.slice(3));
  if (!signatures.length) return null;
  const content = `${id}.${ts}.${rawBody}`;
  for (const key of standardWebhookKeys(secret)) {
    const expected = await macBase64(key, content);
    if (signatures.some((sig) => timingSafeEqual(expected, sig))) return { id };
  }
  return null;
}

/** Candidate HMAC keys for a Standard Webhooks secret (decoded whsec_ first, raw bytes second). */
export function standardWebhookKeys(secret: string): Uint8Array[] {
  const keys: Uint8Array[] = [];
  const stripped = secret.replace(/^(whsec_|polar_whs_)/, "");
  if (secret.startsWith("whsec_")) {
    try {
      keys.push(fromBase64(stripped));
    } catch {
      // not base64; fall through to the raw key
    }
  }
  keys.push(utf8(secret));
  return keys;
}

/** Sign a Standard Webhooks delivery (tests and the webhook self-check). */
export async function signStandardWebhook(
  secret: string,
  id: string,
  timestampSeconds: number,
  rawBody: string,
): Promise<string> {
  const key = standardWebhookKeys(secret)[0] ?? utf8(secret);
  return `v1,${await macBase64(key, `${id}.${timestampSeconds}.${rawBody}`)}`;
}

/** Hex HMAC-SHA256 of the raw body (Lemon Squeezy `X-Signature`, Creem `creem-signature`). */
export async function verifyBodyHmacHex(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature || !secret) return false;
  return timingSafeEqual(await macHex(secret, rawBody), signature.trim().toLowerCase());
}

/** Base64 HMAC-SHA256 of the raw body (Shopify, WooCommerce). */
export async function verifyBodyHmacBase64(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature || !secret) return false;
  return timingSafeEqual(await macBase64(secret, rawBody), signature.trim());
}

/** Paddle Billing: `Paddle-Signature: ts=1671552777;h1=<hex>` over `${ts}:${rawBody}`. */
export async function verifyPaddleSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowMs: number,
  tolerance = TOLERANCE_SECONDS,
): Promise<boolean> {
  if (!header || !secret) return false;
  let ts: number | null = null;
  const h1: string[] = [];
  for (const part of header.split(";")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "ts" && v) ts = Number(v);
    else if (k === "h1" && v) h1.push(v.toLowerCase());
  }
  if (ts === null || !h1.length || !withinTolerance(ts, nowMs, tolerance)) return false;
  const expected = await macHex(secret, `${ts}:${rawBody}`);
  return h1.some((sig) => timingSafeEqual(expected, sig));
}

/** Test/fixture helpers: produce the headers each provider would send. */
export const sign = {
  stripe: async (secret: string, rawBody: string, tSeconds: number) =>
    `t=${tSeconds},v1=${await macHex(secret, `${tSeconds}.${rawBody}`)}`,
  paddle: async (secret: string, rawBody: string, tSeconds: number) =>
    `ts=${tSeconds};h1=${await macHex(secret, `${tSeconds}:${rawBody}`)}`,
  hex: (secret: string, rawBody: string) => macHex(secret, rawBody),
  base64: (secret: string, rawBody: string) => macBase64(secret, rawBody),
  standard: signStandardWebhook,
};
