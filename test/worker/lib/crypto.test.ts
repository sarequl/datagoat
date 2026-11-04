import { describe, expect, it } from "vitest";
import {
  clampIterations,
  decryptJson,
  decryptString,
  encryptJson,
  encryptString,
  hashPassword,
  hmacSha256Base64,
  hmacSha256Hex,
  PBKDF2_MAX_ITERATIONS,
  sha256Hex,
  timingSafeEqual,
  verifyHmacSha256,
  verifyPassword,
} from "../../../src/lib/crypto";
import { fromBase64Url, fromHex, toBase64Url, toHex } from "../../../src/lib/encoding";

const KEY = "k".repeat(32);

describe("hashing", () => {
  it("computes SHA-256 test vectors", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("computes HMAC-SHA256 (RFC 4231 case 2)", async () => {
    expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("verifies HMAC signatures in hex, base64 and base64url", async () => {
    const hex = await hmacSha256Hex("secret", "payload");
    const b64 = await hmacSha256Base64("secret", "payload");
    expect(await verifyHmacSha256("secret", "payload", hex)).toBe(true);
    expect(await verifyHmacSha256("secret", "payload", hex.toUpperCase())).toBe(true);
    expect(await verifyHmacSha256("secret", "payload", b64, "base64")).toBe(true);
    expect(await verifyHmacSha256("secret", "payload2", hex)).toBe(false);
    expect(await verifyHmacSha256("other", "payload", hex)).toBe(false);
  });

  it("compares in constant time and handles length differences", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
  });

  it("round-trips hex and base64url", () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 63]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(() => fromHex("zz")).toThrow();
  });
});

describe("AES-GCM", () => {
  it("encrypts and decrypts with a fresh IV each time", async () => {
    const a = await encryptString(KEY, "rk_live_secret");
    const b = await encryptString(KEY, "rk_live_secret");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(await decryptString(KEY, a)).toBe("rk_live_secret");
  });

  it("binds ciphertext to additional data", async () => {
    const ct = await encryptString(KEY, "secret", "provider:stripe:site1");
    expect(await decryptString(KEY, ct, "provider:stripe:site1")).toBe("secret");
    await expect(decryptString(KEY, ct, "provider:stripe:site2")).rejects.toThrow();
  });

  it("rejects tampering, wrong keys, bad formats and short keys", async () => {
    const ct = await encryptString(KEY, "secret");
    const parts = ct.split(".");
    const flipped = `${parts[0]}.${parts[1]}.${(parts[2] ?? "").slice(0, -2)}AA`;
    await expect(decryptString(KEY, flipped)).rejects.toThrow();
    await expect(decryptString("x".repeat(32), ct)).rejects.toThrow();
    await expect(decryptString(KEY, "v2.a.b")).rejects.toThrow("Unsupported");
    await expect(encryptString("short", "x")).rejects.toThrow("at least 32");
  });

  it("round-trips JSON", async () => {
    const value = { apiKey: "abc", storeId: 12 };
    expect(await decryptJson(KEY, await encryptJson(KEY, value))).toEqual(value);
  });
});

describe("PBKDF2 passwords", () => {
  it("hashes with the requested iterations and verifies", async () => {
    const hash = await hashPassword("hunter22", 10_000);
    expect(hash).toMatch(/^pbkdf2_sha256\$10000\$/);
    expect(await verifyPassword("hunter22", hash, 10_000)).toEqual({
      valid: true,
      needsRehash: false,
    });
    expect(await verifyPassword("hunter23", hash, 10_000)).toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it("flags hashes whose parameters differ from the configured count", async () => {
    const hash = await hashPassword("hunter22", 10_000);
    expect(await verifyPassword("hunter22", hash, 20_000)).toEqual({
      valid: true,
      needsRehash: true,
    });
  });

  it("caps iterations at the Workers runtime limit of 100,000", async () => {
    expect(clampIterations(1_000_000)).toBe(PBKDF2_MAX_ITERATIONS);
    expect(clampIterations("5")).toBe(10_000);
    expect(clampIterations(undefined)).toBe(PBKDF2_MAX_ITERATIONS);
    const hash = await hashPassword("pw", 500_000);
    expect(hash.split("$")[1]).toBe("100000");
    expect((await verifyPassword("pw", hash)).valid).toBe(true);
  });

  it("rejects malformed hashes without throwing", async () => {
    expect((await verifyPassword("pw", "plain")).valid).toBe(false);
    expect((await verifyPassword("pw", "pbkdf2_sha256$999999999$AA==$AA==")).valid).toBe(false);
    expect((await verifyPassword("pw", "pbkdf2_sha256$1000$!!$!!")).valid).toBe(false);
  });

  it("normalises Unicode before hashing", async () => {
    const hash = await hashPassword("café", 10_000);
    expect((await verifyPassword("café", hash, 10_000)).valid).toBe(true);
  });
});
