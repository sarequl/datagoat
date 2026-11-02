import { hmacSha256Hex } from '../util/crypto';
import type { Provider } from './types';

/** Clock skew tolerance for signed webhooks (design/attribution.md §7.2). */
const TOLERANCE_SECONDS = 300;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function withinTolerance(timestamp: string, nowSeconds: number): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return Math.abs(nowSeconds - ts) <= TOLERANCE_SECONDS;
}

/**
 * Stripe: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]`, HMAC-SHA256
 * over `"{t}.{rawBody}"` with the `whsec_` endpoint secret.
 */
export async function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds: number,
): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(',').map((part) => part.trim());
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;
  if (!withinTolerance(timestamp, nowSeconds)) return false;

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return signatures.some((signature) => safeEqual(signature, expected));
}

/**
 * Standard Webhooks (Polar, Dodo Payments): headers `webhook-id`,
 * `webhook-timestamp`, `webhook-signature` (`v1,<hex>[,v1,<hex>...]`),
 * HMAC-SHA256 over `"{id}.{timestamp}.{rawBody}"`.
 */
async function verifyStandardWebhooks(
  rawBody: string,
  headers: Record<string, string | null>,
  key: string,
  nowSeconds: number,
): Promise<boolean> {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'];
  if (!id || !timestamp || !signatureHeader) return false;
  if (!withinTolerance(timestamp, nowSeconds)) return false;

  const expected = await hmacSha256Hex(key, `${id}.${timestamp}.${rawBody}`);
  // Standard Webhooks sends `v1,<hex>` and, with multiple signing secrets,
  // `v1,<hex>,v1,<hex>` — so match the pairs, not a naive comma split.
  const matches = signatureHeader.match(/v1,([0-9a-fA-F]+)/g) ?? [];
  return matches.some((match) => safeEqual(match.slice(3), expected));
}

/**
 * Polar caveat (verified 2026-11-02): secrets created on or after 2026-09-08
 * use Standard Webhooks; older secrets use the older Polar HMAC scheme where
 * the key is the base64 of the full `whsec_…` string. Try both key encodings.
 */
export async function verifyPolarSignature(
  rawBody: string,
  headers: Record<string, string | null>,
  secret: string,
  nowSeconds: number,
): Promise<boolean> {
  if (await verifyStandardWebhooks(rawBody, headers, secret, nowSeconds)) return true;
  const legacyKey = btoa(secret);
  return verifyStandardWebhooks(rawBody, headers, legacyKey, nowSeconds);
}

export function verifyDodoSignature(
  rawBody: string,
  headers: Record<string, string | null>,
  secret: string,
  nowSeconds: number,
): Promise<boolean> {
  return verifyStandardWebhooks(rawBody, headers, secret, nowSeconds);
}

/** Creem: `creem-signature`, HMAC-SHA256 hex over the raw body. */
export async function verifyCreemSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  return safeEqual(header.trim(), expected);
}

/**
 * Dispatcher for the shared pipeline (§7.1 step 1). Returns false on any
 * missing header, bad timestamp, or signature mismatch — the caller responds
 * 401 and does not log the payload.
 */
export async function verifyWebhookSignature(
  provider: Provider,
  rawBody: string,
  headers: Record<string, string | null>,
  secret: string,
  nowSeconds: number,
): Promise<boolean> {
  switch (provider) {
    case 'stripe':
      return verifyStripeSignature(rawBody, headers['stripe-signature'], secret, nowSeconds);
    case 'polar':
      return verifyPolarSignature(rawBody, headers, secret, nowSeconds);
    case 'dodo':
      return verifyDodoSignature(rawBody, headers, secret, nowSeconds);
    case 'creem':
      return verifyCreemSignature(rawBody, headers['creem-signature'], secret);
  }
}
