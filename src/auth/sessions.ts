/**
 * Dashboard sessions (plan §13): a signed, HttpOnly, Secure, SameSite=Lax cookie valid 30 days.
 *
 * Cookie value: `<token>.<hmac>` where token is 32 random bytes (base64url) and hmac is
 * HMAC-SHA256(SESSION_SECRET, token). The HMAC lets forged cookies fail without a D1 read; the
 * server keeps only SHA-256(token) in `auth_sessions`, so logout and password changes revoke
 * sessions. Validating a session costs one D1 read and no writes.
 */
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { hmacSha256Base64Url, MIN_SECRET_LENGTH, sha256Hex, timingSafeEqual } from "../lib/crypto";
import { randomToken } from "../lib/ids";
import type { AppEnv } from "../types";
import type { AuthUser } from "./context";

export const SESSION_COOKIE = "dg_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function secretOf(env: Cloudflare.Env): string {
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
}

export async function signSessionToken(env: Cloudflare.Env, token: string): Promise<string> {
  return `${token}.${await hmacSha256Base64Url(secretOf(env), `session:${token}`)}`;
}

/** Returns the raw token when the cookie's signature is valid, else null. */
export async function verifySessionCookie(
  env: Cloudflare.Env,
  cookie: string,
): Promise<string | null> {
  const dot = cookie.lastIndexOf(".");
  if (dot <= 0) return null;
  const token = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const expected = await hmacSha256Base64Url(secretOf(env), `session:${token}`);
  return timingSafeEqual(sig, expected) ? token : null;
}

export async function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(`session:${token}`);
}

function isSecureRequest(c: Context): boolean {
  const url = new URL(c.req.url);
  return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

/** Create a session row and set the cookie. Returns the session id hash. */
export async function startSession(
  c: Context<AppEnv>,
  userId: string,
  now = Date.now(),
): Promise<string> {
  const token = randomToken(32);
  const idHash = await hashSessionToken(token);
  const country = (c.req.raw as Request & { cf?: { country?: string } }).cf?.country ?? null;
  await c.env.DB.prepare(
    "INSERT INTO auth_sessions (id_hash, user_id, created_at, expires_at, user_agent, ip_country) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      idHash,
      userId,
      now,
      now + SESSION_TTL_MS,
      (c.req.header("user-agent") ?? "").slice(0, 300),
      country,
    )
    .run();
  setCookie(c, SESSION_COOKIE, await signSessionToken(c.env, token), {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return idHash;
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, {
    path: "/",
    secure: isSecureRequest(c),
    httpOnly: true,
    sameSite: "Lax",
  });
}

export interface ResolvedSession {
  idHash: string;
  user: AuthUser;
  expiresAt: number;
}

/** Resolve the session cookie on a request, or null. */
export async function readSession(
  c: Context<AppEnv>,
  now = Date.now(),
): Promise<ResolvedSession | null> {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie) return null;
  const token = await verifySessionCookie(c.env, cookie);
  if (!token) return null;
  const idHash = await hashSessionToken(token);
  const row = await c.env.DB.prepare(
    `SELECT s.id_hash, s.expires_at, u.id, u.email, u.name, u.image, u.created_at
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.expires_at > ?`,
  )
    .bind(idHash, now)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    idHash,
    expiresAt: Number(row.expires_at),
    user: {
      id: String(row.id),
      email: String(row.email),
      name: (row.name as string | null) ?? null,
      image: (row.image as string | null) ?? null,
      createdAt: Number(row.created_at),
    },
  };
}

export async function endSession(db: D1Database, idHash: string): Promise<void> {
  await db.prepare("DELETE FROM auth_sessions WHERE id_hash = ?").bind(idHash).run();
}

/** Revoke every session of a user except `keepIdHash` (used after a password change). */
export function revokeOtherSessionsStatement(
  db: D1Database,
  userId: string,
  keepIdHash: string | null,
) {
  return keepIdHash
    ? db
        .prepare("DELETE FROM auth_sessions WHERE user_id = ? AND id_hash != ?")
        .bind(userId, keepIdHash)
    : db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(userId);
}
