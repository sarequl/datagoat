/**
 * Identifier helpers.
 *
 * - `newId()`: 24 lowercase hex characters (4-byte seconds timestamp + 8 random bytes), the same
 *   shape as DataFast's MongoDB ObjectIds, so clients that validate `_id`/`websiteId` keep working.
 *   Ids sort roughly by creation time.
 * - `newTrackingId()`: public `data-website-id` value, `dfid_` + 16 base62 characters. Sites created
 *   by import may keep any opaque tracking id (plan §3.1).
 * - `randomToken()`: URL-safe secret material for sessions, invites, share links.
 */
import { randomBytes } from "./crypto";
import { toBase64Url, toHex } from "./encoding";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function newId(nowMs: number = Date.now()): string {
  const seconds = Math.floor(nowMs / 1000) >>> 0;
  return seconds.toString(16).padStart(8, "0") + toHex(randomBytes(8));
}

export function isObjectIdLike(value: string): boolean {
  return /^[0-9a-f]{24}$/.test(value);
}

/** Uniformly random base62 string (rejection sampling, no modulo bias). */
export function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248) out += BASE62[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function newTrackingId(): string {
  return `dfid_${randomBase62(16)}`;
}

/** URL-safe random token with `bytes` bytes of entropy (default 32 = 256 bits). */
export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

export function uuidv4(): string {
  return crypto.randomUUID();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** DataFast visitor ids are UUID v4 (`datafast_visitor_id` cookie). */
export function isUuidV4(value: string): boolean {
  return UUID_V4_RE.test(value);
}

/** DataFast session ids are `s` + UUID v4 (`datafast_session_id` cookie). */
export function isSessionId(value: string): boolean {
  return value.length === 37 && value[0] === "s" && UUID_V4_RE.test(value.slice(1));
}
