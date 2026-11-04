/**
 * Dashboard authentication endpoints under `/api/auth`.
 *
 *   POST /api/auth/login                       {email, password} → session cookie
 *   POST /api/auth/logout
 *   POST /api/auth/logout-all                  end every session of the user (sign out everywhere)
 *   GET  /api/auth/me                          current user + websites
 *   PUT  /api/auth/password                    {currentPassword, newPassword}
 *   GET  /api/auth/invites/:token              invite details
 *   POST /api/auth/invites/:token/accept       {name?, password?}
 *   GET  /api/auth/password-resets/:token      reset link validity
 *   POST /api/auth/password-resets/:token      {password}
 */
import { Hono } from "hono";
import { z } from "zod";
import { websiteSummaryDto } from "../api/v1/account/websites-service";
import {
  clampIterations,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  sha256Hex,
  verifyPassword,
} from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { newId } from "../lib/ids";
import { success } from "../lib/response";
import { rowToSite } from "../lib/sites";
import { toIso } from "../lib/time";
import { parseJsonBody, zEmail } from "../lib/validate";
import type { AppEnv } from "../types";
import { type AuthUser, getAuth } from "./context";
import { listUserSiteRows } from "./memberships";
import { authenticate, requireSession } from "./middleware";
import {
  clearSessionCookie,
  endSession,
  readSession,
  revokeOtherSessionsStatement,
  startSession,
} from "./sessions";
import { assertLoginAllowed, recordLoginFailure } from "./throttle";

export const MIN_PASSWORD_LENGTH = 8;
export const zPassword = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(256, "must be at most 256 characters");

export function passwordIterations(env: Cloudflare.Env): number {
  return clampIterations(env.PASSWORD_ITERATIONS);
}

export function userDto(user: AuthUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image,
    createdAt: toIso(user.createdAt),
  };
}

export async function meDto(db: D1Database, user: AuthUser) {
  const rows = await listUserSiteRows(db, user.id);
  return {
    user: userDto(user),
    websites: rows.map((row) =>
      websiteSummaryDto(rowToSite(row), row.member_role as "owner" | "member" | "viewer"),
    ),
  };
}

function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? "unknown";
}

export const authRoutes = new Hono<AppEnv>();

const LoginBody = z.object({ email: zEmail, password: z.string().min(1).max(256) }).strict();

authRoutes.post("/login", async (c) => {
  const { email, password } = await parseJsonBody(c, LoginBody, { maxBytes: 4096 });
  const ip = clientIp(c.req.raw);
  await assertLoginAllowed(c.env.LOGIN_THROTTLE, ip, email);
  const row = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?")
    .bind(email)
    .first<Record<string, unknown>>();
  const iterations = passwordIterations(c.env);
  // Hash even for unknown emails so response timing does not reveal which emails exist.
  const check = await verifyPassword(
    password,
    row ? String(row.password_hash) : DUMMY_PASSWORD_HASH,
    iterations,
  );
  if (!row || !check.valid) {
    await recordLoginFailure(c.env.LOGIN_THROTTLE, ip, email);
    throw new ApiError(401, "Invalid email or password");
  }
  const user: AuthUser = {
    id: String(row.id),
    email: String(row.email),
    name: (row.name as string | null) ?? null,
    image: (row.image as string | null) ?? null,
    createdAt: Number(row.created_at),
  };
  if (check.needsRehash) {
    const rehashed = await hashPassword(password, iterations);
    await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(rehashed, user.id)
      .run();
  }
  await startSession(c, user.id);
  return success(c, await meDto(c.env.DB, user));
});

authRoutes.post("/logout", async (c) => {
  const session = await readSession(c);
  if (session) await endSession(c.env.DB, session.idHash);
  clearSessionCookie(c);
  return success(c, { message: "Logged out" });
});

authRoutes.post("/logout-all", authenticate, requireSession, async (c) => {
  const auth = getAuth(c);
  await revokeOtherSessionsStatement(c.env.DB, auth.user.id, null).run();
  clearSessionCookie(c);
  return success(c, { message: "Signed out of every session" });
});

authRoutes.get("/me", authenticate, async (c) => {
  const auth = getAuth(c);
  return success(c, { ...(await meDto(c.env.DB, auth.user)), authKind: auth.kind });
});

const PasswordBody = z
  .object({ currentPassword: z.string().min(1).max(256), newPassword: zPassword })
  .strict();

authRoutes.put("/password", authenticate, requireSession, async (c) => {
  const auth = getAuth(c);
  const { currentPassword, newPassword } = await parseJsonBody(c, PasswordBody, { maxBytes: 4096 });
  const row = await c.env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
    .bind(auth.user.id)
    .first<{ password_hash: string }>();
  const iterations = passwordIterations(c.env);
  const check = await verifyPassword(
    currentPassword,
    row?.password_hash ?? DUMMY_PASSWORD_HASH,
    iterations,
  );
  if (!row || !check.valid) throw new ApiError(400, "Current password is incorrect");
  if (currentPassword === newPassword)
    throw new ApiError(400, "The new password must differ from the current one");
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?",
    ).bind(await hashPassword(newPassword, iterations), now, now, auth.user.id),
    revokeOtherSessionsStatement(c.env.DB, auth.user.id, auth.credentialId),
  ]);
  return success(c, { message: "Password changed. Other sessions were signed out." });
});

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

interface InviteRow {
  id: string;
  site_id: string;
  email: string;
  role: string;
  invited_by: string | null;
  expires_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
}

async function loadInvite(db: D1Database, token: string): Promise<InviteRow> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new ApiError(404, "Invitation not found");
  const invite = await db
    .prepare("SELECT * FROM invites WHERE token_hash = ?")
    .bind(await sha256Hex(`invite:${token}`))
    .first<InviteRow>();
  if (!invite || invite.revoked_at !== null) throw new ApiError(404, "Invitation not found");
  if (invite.accepted_at !== null) throw new ApiError(410, "This invitation has already been used");
  if (invite.expires_at <= Date.now()) throw new ApiError(410, "This invitation has expired");
  return invite;
}

authRoutes.get("/invites/:token", authenticate, async (c) => {
  const invite = await loadInvite(c.env.DB, c.req.param("token"));
  const site = await c.env.DB.prepare(
    "SELECT id, domain, name FROM sites WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(invite.site_id)
    .first<{ id: string; domain: string; name: string | null }>();
  if (!site) throw new ApiError(404, "Invitation not found");
  const inviter = invite.invited_by
    ? await c.env.DB.prepare("SELECT name, email FROM users WHERE id = ?")
        .bind(invite.invited_by)
        .first<{ name: string | null; email: string }>()
    : null;
  const existing = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?")
    .bind(invite.email)
    .first();
  const auth = c.get("auth");
  return success(c, {
    email: invite.email,
    role: invite.role,
    website: { id: site.id, domain: site.domain, name: site.name },
    invitedBy: inviter ? { name: inviter.name, email: inviter.email } : null,
    expiresAt: toIso(invite.expires_at),
    userExists: Boolean(existing),
    signedInAs: auth?.kind === "session" ? auth.user.email : null,
  });
});

const AcceptBody = z
  .object({ name: z.string().trim().max(100).nullish(), password: zPassword.optional() })
  .strict();

authRoutes.post("/invites/:token/accept", authenticate, async (c) => {
  const invite = await loadInvite(c.env.DB, c.req.param("token"));
  const body = await parseJsonBody(c, AcceptBody, { maxBytes: 4096 });
  const auth = c.get("auth");
  const now = Date.now();
  const db = c.env.DB;
  const markAccepted = db
    .prepare("UPDATE invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL")
    .bind(now, invite.id);
  const addMember = (userId: string) =>
    db
      .prepare(
        `INSERT INTO memberships (site_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (site_id, user_id) DO NOTHING`,
      )
      .bind(invite.site_id, userId, invite.role, now);

  if (auth?.kind === "session") {
    if (auth.user.email.toLowerCase() !== invite.email) {
      throw new ApiError(
        403,
        `This invitation is for ${invite.email}. Sign out and accept it with that account.`,
      );
    }
    await db.batch([addMember(auth.user.id), markAccepted]);
    return success(c, {
      message: "Invitation accepted",
      websiteId: invite.site_id,
      ...(await meDto(db, auth.user)),
    });
  }
  const existing = await db
    .prepare("SELECT id FROM users WHERE email = ?")
    .bind(invite.email)
    .first<{ id: string }>();
  if (existing) throw new ApiError(401, `Sign in as ${invite.email} to accept this invitation`);
  if (!body.password) throw new ApiError(400, "password: required to create your account");
  const userId = newId(now);
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, email, password_hash, name, created_at, updated_at, password_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        userId,
        invite.email,
        await hashPassword(body.password, passwordIterations(c.env)),
        body.name ?? null,
        now,
        now,
        now,
      ),
    addMember(userId),
    markAccepted,
  ]);
  await startSession(c, userId);
  const user: AuthUser = {
    id: userId,
    email: invite.email,
    name: body.name ?? null,
    image: null,
    createdAt: now,
  };
  return success(c, {
    message: "Account created and invitation accepted",
    websiteId: invite.site_id,
    ...(await meDto(db, user)),
  });
});

// ---------------------------------------------------------------------------
// Password reset links (created by `npm run reset-password -- <email>`)
// ---------------------------------------------------------------------------

async function loadReset(
  db: D1Database,
  token: string,
): Promise<{ user_id: string; token_hash: string }> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new ApiError(404, "Reset link not found");
  const tokenHash = await sha256Hex(`reset:${token}`);
  const row = await db
    .prepare(
      "SELECT user_id, token_hash, expires_at, used_at FROM password_resets WHERE token_hash = ?",
    )
    .bind(tokenHash)
    .first<{ user_id: string; token_hash: string; expires_at: number; used_at: number | null }>();
  if (!row) throw new ApiError(404, "Reset link not found");
  if (row.used_at !== null || row.expires_at <= Date.now())
    throw new ApiError(410, "This reset link has expired");
  return row;
}

authRoutes.get("/password-resets/:token", async (c) => {
  const reset = await loadReset(c.env.DB, c.req.param("token"));
  const user = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?")
    .bind(reset.user_id)
    .first<{ email: string }>();
  if (!user) throw new ApiError(404, "Reset link not found");
  return success(c, { email: user.email });
});

const ResetBody = z.object({ password: zPassword }).strict();

authRoutes.post("/password-resets/:token", async (c) => {
  const reset = await loadReset(c.env.DB, c.req.param("token"));
  const { password } = await parseJsonBody(c, ResetBody, { maxBytes: 4096 });
  const now = Date.now();
  const db = c.env.DB;
  await db.batch([
    db
      .prepare(
        "UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?",
      )
      .bind(await hashPassword(password, passwordIterations(c.env)), now, now, reset.user_id),
    db
      .prepare("UPDATE password_resets SET used_at = ? WHERE token_hash = ?")
      .bind(now, reset.token_hash),
    revokeOtherSessionsStatement(db, reset.user_id, null),
  ]);
  return success(c, { message: "Password updated. You can now sign in." });
});
