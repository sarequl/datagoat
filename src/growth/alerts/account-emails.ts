/**
 * Account emails: team invites and password resets. The foundation returns invite links in the
 * API response (and prints reset links from `npm run reset-password`) because many installs have
 * no email provider. When email is configured these are also sent through the outbox.
 *
 * - `queueInviteEmail()` is called by the team invite handler (F0) right after it creates an invite.
 * - `POST /api/auth/password-resets {email}` (DG) emails a one-time, 1-hour reset link. It always
 *   answers the same message whether or not the account exists, and sends at most one email per
 *   account every 5 minutes. Without an email provider it answers 503 and points to the CLI.
 */
import { Hono } from "hono";
import { z } from "zod";
import { sha256Hex } from "../../lib/crypto";
import { ApiError } from "../../lib/errors";
import { randomToken } from "../../lib/ids";
import { success } from "../../lib/response";
import { parseJsonBody, zEmail } from "../../lib/validate";
import type { AppEnv } from "../../types";
import { emailConfigured } from "../delivery/email";
import { enqueueStatement } from "../delivery/outbox";
import { emailLayout, textToHtml } from "../delivery/templates";

export const RESET_TTL_MS = 60 * 60_000;
const RESET_COOLDOWN_MS = 5 * 60_000;

export interface InviteEmail {
  siteId: string;
  siteLabel: string;
  email: string;
  role: string;
  inviteUrl: string;
  inviterName: string | null;
  expiresAt: number;
  invitationId: string;
}

/** Queue the invite email. Returns true when it was queued (email configured). */
export async function queueInviteEmail(
  env: Cloudflare.Env,
  db: D1Database,
  invite: InviteEmail,
  now: number = Date.now(),
): Promise<boolean> {
  if (!emailConfigured(env)) return false;
  const who = invite.inviterName ? `${invite.inviterName} invited you` : "You have been invited";
  const text = `${who} to join ${invite.siteLabel} on DataGoat as a ${invite.role}.\n\nAccept the invitation: ${invite.inviteUrl}\n\nThe link expires on ${new Date(invite.expiresAt).toUTCString()}.`;
  await enqueueStatement(
    db,
    {
      siteId: invite.siteId,
      dedupeKey: `invite:${invite.invitationId}`,
      payload: {
        channel: "email",
        to: [invite.email],
        subject: `Join ${invite.siteLabel} on DataGoat`,
        text,
        html: emailLayout({
          title: `Join ${invite.siteLabel} on DataGoat`,
          bodyHtml: textToHtml(`${who} to join ${invite.siteLabel} as a ${invite.role}.`),
          actionUrl: invite.inviteUrl,
          actionLabel: "Accept invitation",
          footer: "If you did not expect this invitation you can ignore this email.",
        }),
      },
    },
    now,
  ).run();
  return true;
}

export const accountEmailRoutes = new Hono<AppEnv>();

const ResetRequest = z.object({ email: zEmail }).strict();
const GENERIC = "If an account exists for that email, a password reset link is on its way.";

accountEmailRoutes.post("/api/auth/password-resets", async (c) => {
  if (!emailConfigured(c.env)) {
    throw new ApiError(
      503,
      "Email is not configured on this server. Ask the operator to run `npm run reset-password -- <email> <url>`.",
    );
  }
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const limited = await c.env.API_LIMITER.limit({ key: `password-reset:${ip}` });
  if (!limited.success)
    throw new ApiError(429, "Too many requests", { headers: { "Retry-After": "60" } });
  const { email } = await parseJsonBody(c, ResetRequest, { maxBytes: 2048 });
  const now = Date.now();
  const user = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!user) return success(c, { message: GENERIC });
  const recent = await c.env.DB.prepare(
    "SELECT 1 AS x FROM password_resets WHERE user_id = ? AND created_at > ? AND used_at IS NULL LIMIT 1",
  )
    .bind(user.id, now - RESET_COOLDOWN_MS)
    .first();
  if (recent) return success(c, { message: GENERIC });
  const token = randomToken(32);
  const link = `${new URL(c.req.url).origin}/reset-password/${token}`;
  const text = `Someone asked to reset the password of your DataGoat account.\n\nChoose a new password: ${link}\n\nThe link works once and expires in one hour. If you did not ask for this, ignore this email.`;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    ).bind(await sha256Hex(`reset:${token}`), user.id, now, now + RESET_TTL_MS),
    enqueueStatement(
      c.env.DB,
      {
        siteId: null,
        dedupeKey: `reset:${await sha256Hex(token)}`,
        payload: {
          channel: "email",
          to: [email],
          subject: "Reset your DataGoat password",
          text,
          html: emailLayout({
            title: "Reset your DataGoat password",
            bodyHtml: textToHtml(
              "Someone asked to reset the password of your DataGoat account. The link works once and expires in one hour. If you did not ask for this, ignore this email.",
            ),
            actionUrl: link,
            actionLabel: "Choose a new password",
          }),
        },
      },
      now,
    ),
  ]);
  return success(c, { message: GENERIC });
});
