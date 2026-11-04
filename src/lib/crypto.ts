/**
 * Cryptographic helpers built on Web Crypto (available in workerd and browsers).
 *
 * - SHA-256 and HMAC-SHA256 for token hashing and webhook signatures
 * - timing-safe comparison
 * - AES-256-GCM encryption of credentials at rest, keyed from ENCRYPTION_KEY via HKDF
 * - PBKDF2-SHA256 password hashing (the Workers runtime caps iterations at 100,000)
 */
import {
  fromBase64,
  fromBase64Url,
  fromUtf8,
  toBase64,
  toBase64Url,
  toHex,
  utf8,
} from "./encoding";

type Bytes = Uint8Array<ArrayBuffer>;

function toBytes(input: string | ArrayBuffer | Uint8Array): Bytes {
  if (typeof input === "string") return utf8(input);
  if (input instanceof Uint8Array) return new Uint8Array(input) as Bytes;
  return new Uint8Array(input) as Bytes;
}

export async function sha256(input: string | ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", toBytes(input));
}

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<string> {
  return toHex(await sha256(input));
}

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string | Uint8Array): Promise<CryptoKey> {
  const cacheKey = typeof secret === "string" ? `s:${secret}` : `b:${toHex(secret)}`;
  let key = hmacKeyCache.get(cacheKey);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      toBytes(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    if (hmacKeyCache.size > 64) hmacKeyCache.clear();
    hmacKeyCache.set(cacheKey, key);
  }
  return key;
}

export async function hmacSha256(
  secret: string | Uint8Array,
  data: string | ArrayBuffer | Uint8Array,
): Promise<ArrayBuffer> {
  return crypto.subtle.sign("HMAC", await hmacKey(secret), toBytes(data));
}

export async function hmacSha256Hex(
  secret: string | Uint8Array,
  data: string | ArrayBuffer | Uint8Array,
): Promise<string> {
  return toHex(await hmacSha256(secret, data));
}

export async function hmacSha256Base64(
  secret: string | Uint8Array,
  data: string | ArrayBuffer | Uint8Array,
): Promise<string> {
  return toBase64(await hmacSha256(secret, data));
}

export async function hmacSha256Base64Url(
  secret: string | Uint8Array,
  data: string | ArrayBuffer | Uint8Array,
): Promise<string> {
  return toBase64Url(await hmacSha256(secret, data));
}

/**
 * Constant-time comparison. Inputs of different length compare unequal, but the
 * comparison still walks the longer input so timing does not reveal the length of a prefix match.
 */
export function timingSafeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const x = typeof a === "string" ? utf8(a) : a;
  const y = typeof b === "string" ? utf8(b) : b;
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Verify an HMAC-SHA256 signature given as hex (default), base64 or base64url. */
export async function verifyHmacSha256(
  secret: string | Uint8Array,
  data: string | ArrayBuffer | Uint8Array,
  signature: string,
  encoding: "hex" | "base64" | "base64url" = "hex",
): Promise<boolean> {
  const mac = await hmacSha256(secret, data);
  const expected =
    encoding === "hex" ? toHex(mac) : encoding === "base64" ? toBase64(mac) : toBase64Url(mac);
  const given = encoding === "hex" ? signature.toLowerCase() : signature;
  return timingSafeEqual(expected, given);
}

export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(length) as Bytes;
  crypto.getRandomValues(out);
  return out;
}

// ---------------------------------------------------------------------------
// AES-256-GCM for credentials at rest
// ---------------------------------------------------------------------------

const ENCRYPTION_VERSION = "v1";
const aesKeyCache = new Map<string, Promise<CryptoKey>>();

/** Minimum length accepted for SESSION_SECRET and ENCRYPTION_KEY. */
export const MIN_SECRET_LENGTH = 32;

function aesKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    return Promise.reject(
      new Error(`ENCRYPTION_KEY must be at least ${MIN_SECRET_LENGTH} characters`),
    );
  }
  let key = aesKeyCache.get(secret);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey("raw", utf8(secret), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: utf8("datagoat"),
          info: utf8("datagoat:aes-256-gcm:v1"),
        },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    aesKeyCache.set(secret, key);
  }
  return key;
}

/**
 * Encrypt a string. Output format: `v1.<iv base64url>.<ciphertext+tag base64url>`.
 * `aad` (additional authenticated data) binds the ciphertext to a context such as
 * `"provider:stripe:<siteId>"`, so a value copied to another row fails to decrypt.
 */
export async function encryptString(secret: string, plaintext: string, aad = ""): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(aad) },
    await aesKey(secret),
    utf8(plaintext),
  );
  return `${ENCRYPTION_VERSION}.${toBase64Url(iv)}.${toBase64Url(ct)}`;
}

export async function decryptString(secret: string, payload: string, aad = ""): Promise<string> {
  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== ENCRYPTION_VERSION) {
    throw new Error("Unsupported ciphertext format");
  }
  const iv = fromBase64Url(parts[1] ?? "");
  const ct = fromBase64Url(parts[2] ?? "");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: utf8(aad) },
    await aesKey(secret),
    ct,
  );
  return fromUtf8(pt);
}

export async function encryptJson(secret: string, value: unknown, aad = ""): Promise<string> {
  return encryptString(secret, JSON.stringify(value), aad);
}

export async function decryptJson<T = unknown>(
  secret: string,
  payload: string,
  aad = "",
): Promise<T> {
  return JSON.parse(await decryptString(secret, payload, aad)) as T;
}

// ---------------------------------------------------------------------------
// PBKDF2-SHA256 passwords
// ---------------------------------------------------------------------------

/** The Workers runtime rejects PBKDF2 with more than 100,000 iterations. */
export const PBKDF2_MAX_ITERATIONS = 100_000;
export const PBKDF2_MIN_ITERATIONS = 10_000;
const PBKDF2_PREFIX = "pbkdf2_sha256";

export function clampIterations(value: number | string | undefined): number {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : (value ?? NaN);
  if (!Number.isFinite(n)) return PBKDF2_MAX_ITERATIONS;
  return Math.min(PBKDF2_MAX_ITERATIONS, Math.max(PBKDF2_MIN_ITERATIONS, Math.floor(n)));
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey(
    "raw",
    utf8(password.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: toBytes(salt), iterations },
    base,
    256,
  );
}

/** Hash a password. Format: `pbkdf2_sha256$<iterations>$<salt base64>$<hash base64>`. */
export async function hashPassword(
  password: string,
  iterations = PBKDF2_MAX_ITERATIONS,
): Promise<string> {
  const iters = clampIterations(iterations);
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, iters);
  return `${PBKDF2_PREFIX}$${iters}$${toBase64(salt)}$${toBase64(hash)}`;
}

export interface PasswordCheck {
  valid: boolean;
  /** True when the stored hash uses different parameters than `iterations`; rehash on login. */
  needsRehash: boolean;
}

export async function verifyPassword(
  password: string,
  stored: string,
  iterations = PBKDF2_MAX_ITERATIONS,
): Promise<PasswordCheck> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== PBKDF2_PREFIX) return { valid: false, needsRehash: false };
  const iters = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(iters) || iters < 1 || iters > PBKDF2_MAX_ITERATIONS) {
    return { valid: false, needsRehash: false };
  }
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(parts[2] ?? "");
    expected = fromBase64(parts[3] ?? "");
  } catch {
    return { valid: false, needsRehash: false };
  }
  const actual = new Uint8Array(await pbkdf2(password, salt, iters));
  const valid = timingSafeEqual(actual, expected);
  return { valid, needsRehash: valid && iters !== clampIterations(iterations) };
}

/** A precomputed hash used to keep login timing similar when the email does not exist. */
export const DUMMY_PASSWORD_HASH =
  "pbkdf2_sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
