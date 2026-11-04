import { describe, expect, it } from "vitest";
import { toBase64, toHex, utf8 } from "../../../src/lib/encoding";
import {
  standardWebhookKeys,
  verifyBodyHmacBase64,
  verifyBodyHmacHex,
  verifyPaddleSignature,
  verifyStandardWebhook,
  verifyStripeSignature,
} from "../../../src/providers/signatures";

/** Independent HMAC (not the module's helper) so tests do not verify the code with itself. */
async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? utf8(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, utf8(data)));
}

const BODY = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
const NOW = 1_762_000_000_000;
const T = Math.floor(NOW / 1000);

describe("Stripe-Signature", () => {
  const secret = "whsec_stripe_test_secret";
  it("accepts a valid v1 signature and rejects tampering, wrong secrets and old timestamps", async () => {
    const sig = toHex(await hmac(secret, `${T}.${BODY}`));
    const header = `t=${T},v1=${sig}`;
    expect(await verifyStripeSignature(BODY, header, secret, NOW)).toBe(true);
    expect(await verifyStripeSignature(`${BODY} `, header, secret, NOW)).toBe(false);
    expect(await verifyStripeSignature(BODY, header, "whsec_other", NOW)).toBe(false);
    expect(await verifyStripeSignature(BODY, header, secret, NOW + 301_000)).toBe(false);
    expect(await verifyStripeSignature(BODY, null, secret, NOW)).toBe(false);
    expect(await verifyStripeSignature(BODY, `t=${T}`, secret, NOW)).toBe(false);
    // Several v1 entries (secret rotation): any match wins.
    expect(await verifyStripeSignature(BODY, `t=${T},v1=deadbeef,v1=${sig}`, secret, NOW)).toBe(
      true,
    );
  });
});

describe("Standard Webhooks (Polar, Dodo)", () => {
  it("verifies whsec_ base64 secrets", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(24));
    const secret = `whsec_${toBase64(raw)}`;
    const sig = toBase64(await hmac(raw, `msg_1.${T}.${BODY}`));
    const headers = new Headers({
      "webhook-id": "msg_1",
      "webhook-timestamp": String(T),
      "webhook-signature": `v1,bogus v1,${sig}`,
    });
    expect(await verifyStandardWebhook(BODY, headers, secret, NOW)).toEqual({ id: "msg_1" });
    expect(await verifyStandardWebhook(BODY, headers, secret, NOW + 400_000)).toBeNull();
    headers.set("webhook-id", "msg_2");
    expect(await verifyStandardWebhook(BODY, headers, secret, NOW)).toBeNull();
  });

  it("verifies Polar's older secrets, whose raw UTF-8 bytes are the key", async () => {
    const secret = "polar_whs_0123456789abcdefghijklmnop";
    const sig = toBase64(await hmac(secret, `wh_9.${T}.${BODY}`));
    const headers = new Headers({
      "webhook-id": "wh_9",
      "webhook-timestamp": String(T),
      "webhook-signature": `v1,${sig}`,
    });
    expect(await verifyStandardWebhook(BODY, headers, secret, NOW)).toEqual({ id: "wh_9" });
    expect(standardWebhookKeys(secret)).toHaveLength(1);
  });

  it("rejects missing headers", async () => {
    expect(await verifyStandardWebhook(BODY, new Headers(), "whsec_AAAA", NOW)).toBeNull();
  });
});

describe("body HMACs", () => {
  it("Lemon Squeezy / Creem hex", async () => {
    const sig = toHex(await hmac("ls-secret", BODY));
    expect(await verifyBodyHmacHex(BODY, sig, "ls-secret")).toBe(true);
    expect(await verifyBodyHmacHex(BODY, sig.toUpperCase(), "ls-secret")).toBe(true);
    expect(await verifyBodyHmacHex(BODY, sig, "nope")).toBe(false);
    expect(await verifyBodyHmacHex(BODY, null, "ls-secret")).toBe(false);
  });

  it("Shopify / WooCommerce base64", async () => {
    const sig = toBase64(await hmac("shpss_secret", BODY));
    expect(await verifyBodyHmacBase64(BODY, sig, "shpss_secret")).toBe(true);
    expect(await verifyBodyHmacBase64(`${BODY}x`, sig, "shpss_secret")).toBe(false);
  });
});

describe("Paddle-Signature", () => {
  it("verifies ts;h1 over ts:body with a replay window", async () => {
    const secret = "pdl_ntfset_secret";
    const sig = toHex(await hmac(secret, `${T}:${BODY}`));
    expect(await verifyPaddleSignature(BODY, `ts=${T};h1=${sig}`, secret, NOW)).toBe(true);
    expect(await verifyPaddleSignature(BODY, `ts=${T};h1=${sig}`, secret, NOW + 600_000)).toBe(
      false,
    );
    expect(await verifyPaddleSignature(BODY, `ts=${T + 1};h1=${sig}`, secret, NOW)).toBe(false);
  });
});
