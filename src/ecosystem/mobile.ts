/**
 * Mobile companion app endpoints (docs/api/contract.md §13):
 *
 *   POST   /api/v1/mobile/session            {email, password, deviceName?} → read-only mobile dft_ token
 *   DELETE /api/v1/mobile/session            revoke the calling mobile token (sign out)
 *   GET    /api/v1/mobile/devices            the caller's push devices
 *   POST   /api/v1/mobile/devices            register / update a push device (upsert on pushToken)
 *   DELETE /api/v1/mobile/devices/:deviceId  forget a device
 *
 * The app then reads everything through the ordinary /api/v1 endpoints with that token
 * (`?websiteId=` like any dft_ token). Tokens carry `is_mobile = 1`, are read-only and appear in
 * the user's access-token list so they can be revoked from the dashboard.
 */
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Grant } from "../../shared/permissions";
import { getAuth } from "../auth/context";
import {
  displayKeyOf,
  generateSecret,
  hashSecret,
  invalidateCredential,
  keyPrefixOf,
  MAX_TOKENS_PER_USER,
} from "../auth/credentials";
import { requireAccountAccess } from "../auth/middleware";
import { meDto, passwordIterations } from "../auth/routes";
import { assertLoginAllowed, recordLoginFailure } from "../auth/throttle";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "../lib/crypto";
import { parseJsonColumn } from "../lib/d1";
import { ApiError } from "../lib/errors";
import { newId } from "../lib/ids";
import { success } from "../lib/response";
import { toIso, toIsoOrNull } from "../lib/time";
import { parseJsonBody, zEmail } from "../lib/validate";
import type { AppEnv } from "../types";

/** What the app needs: list sites, read analytics, revenue, goals and alert history. Never writes. */
export const MOBILE_PERMISSIONS: Grant[] = [
  "analytics:read",
  "websites:read",
  "settings:read",
  "goals:read",
  "payments:read",
  "alerts:read",
];
export const MOBILE_TOKEN_TTL_MS = 365 * 86_400_000;
export const MAX_DEVICES_PER_USER = 20;

export const mobileRoutes = new Hono<AppEnv>();

function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

const SessionBody = z
  .object({
    email: zEmail,
    password: z.string().min(1).max(256),
    deviceName: z.string().trim().max(80).optional(),
  })
  .strict();

mobileRoutes.post("/api/v1/mobile/session", async (c) => {
  const { email, password, deviceName } = await parseJsonBody(c, SessionBody, { maxBytes: 4096 });
  const ip = clientIp(c.req.raw);
  await assertLoginAllowed(c.env.LOGIN_THROTTLE, ip, email);
  const row = await c.env.DB.prepare(
    "SELECT id, email, name, image, created_at, password_hash FROM users WHERE email = ?",
  )
    .bind(email)
    .first<{
      id: string;
      email: string;
      name: string | null;
      image: string | null;
      created_at: number;
      password_hash: string;
    }>();
  const iterations = passwordIterations(c.env);
  const check = await verifyPassword(
    password,
    row ? row.password_hash : DUMMY_PASSWORD_HASH,
    iterations,
  );
  if (!row || !check.valid) {
    await recordLoginFailure(c.env.LOGIN_THROTTLE, ip, email);
    throw new ApiError(401, "Invalid email or password");
  }
  const db = c.env.DB;
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (check.needsRehash) {
    statements.push(
      db
        .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(await hashPassword(password, iterations), row.id),
    );
  }

  // Keep within the per-user token cap: a new sign-in replaces the oldest mobile token.
  const tokens = await db
    .prepare(
      `SELECT id, key_hash, is_mobile FROM api_keys
        WHERE user_id = ? AND kind = 'dft' AND revoked_at IS NULL ORDER BY created_at ASC`,
    )
    .bind(row.id)
    .all<{ id: string; key_hash: string; is_mobile: number }>();
  const live = tokens.results ?? [];
  const excess = live.length - (MAX_TOKENS_PER_USER - 1);
  if (excess > 0) {
    const mobile = live.filter((t) => t.is_mobile === 1).slice(0, excess);
    if (mobile.length < excess) {
      throw new ApiError(
        400,
        `Token limit reached (max ${MAX_TOKENS_PER_USER}). Delete an access token in the dashboard first.`,
      );
    }
    for (const t of mobile) {
      statements.push(db.prepare("DELETE FROM api_keys WHERE id = ?").bind(t.id));
      statements.push(db.prepare("DELETE FROM mobile_devices WHERE token_id = ?").bind(t.id));
      invalidateCredential(t.key_hash);
    }
  }

  const secret = generateSecret("dft");
  const id = newId(now);
  const expiresAt = now + MOBILE_TOKEN_TTL_MS;
  const name = `Mobile app${deviceName ? ` (${deviceName})` : ""}`;
  statements.push(
    db
      .prepare(
        `INSERT INTO api_keys (id, kind, site_id, user_id, name, key_hash, key_prefix, display_key,
           permissions, website_ids, include_pii, is_mobile, expires_at, created_at, updated_at)
         VALUES (?, 'dft', NULL, ?, ?, ?, ?, ?, ?, '[]', 0, 1, ?, ?, ?)`,
      )
      .bind(
        id,
        row.id,
        name,
        await hashSecret(secret),
        keyPrefixOf(secret),
        displayKeyOf(secret),
        JSON.stringify(MOBILE_PERMISSIONS),
        expiresAt,
        now,
        now,
      ),
  );
  await db.batch(statements);
  const me = await meDto(db, {
    id: row.id,
    email: row.email,
    name: row.name,
    image: row.image,
    createdAt: row.created_at,
  });
  return success(c, {
    token: secret,
    tokenId: id,
    expiresAt: toIso(expiresAt),
    permissions: MOBILE_PERMISSIONS,
    ...me,
  });
});

/** The calling credential must be a mobile token minted by POST /api/v1/mobile/session. */
async function requireMobileToken(c: Context<AppEnv>) {
  const auth = getAuth(c);
  if (auth.kind !== "account_token") {
    throw new ApiError(403, "This endpoint is for the mobile app's token");
  }
  const row = await c.env.DB.prepare(
    "SELECT id, key_hash, is_mobile FROM api_keys WHERE id = ? AND user_id = ?",
  )
    .bind(auth.credentialId, auth.user.id)
    .first<{ id: string; key_hash: string; is_mobile: number }>();
  if (row?.is_mobile !== 1) {
    throw new ApiError(403, "This endpoint is for the mobile app's token");
  }
  return { auth, token: row };
}

mobileRoutes.delete(
  "/api/v1/mobile/session",
  requireAccountAccess("analytics:read", { allowSiteKey: false }),
  async (c) => {
    const { token } = await requireMobileToken(c);
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM mobile_devices WHERE token_id = ?").bind(token.id),
      c.env.DB.prepare("DELETE FROM api_keys WHERE id = ?").bind(token.id),
    ]);
    invalidateCredential(token.key_hash);
    return success(c, { message: "Signed out" });
  },
);

// ---------------------------------------------------------------------------
// Push devices
// ---------------------------------------------------------------------------

interface DeviceRow {
  id: string;
  user_id: string;
  token_id: string;
  platform: "ios" | "android";
  push_token: string;
  name: string | null;
  notify_sales: number;
  notify_alerts: number;
  muted_site_ids: string;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export function deviceDto(row: DeviceRow) {
  return {
    id: row.id,
    platform: row.platform,
    name: row.name,
    pushToken: row.push_token,
    notifySales: row.notify_sales === 1,
    notifyAlerts: row.notify_alerts === 1,
    mutedSiteIds: parseJsonColumn<string[]>(row.muted_site_ids, []),
    lastError: row.last_error,
    createdAt: toIso(row.created_at),
    updatedAt: toIsoOrNull(row.updated_at),
  };
}

/** Expo push tokens: `ExponentPushToken[...]` (or the newer `ExpoPushToken[...]`). */
export const EXPO_PUSH_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;

const DeviceBody = z
  .object({
    pushToken: z.string().regex(EXPO_PUSH_TOKEN_RE, "must be an Expo push token"),
    platform: z.enum(["ios", "android"]),
    name: z.string().trim().max(80).nullish(),
    notifySales: z.boolean().optional(),
    notifyAlerts: z.boolean().optional(),
    mutedSiteIds: z.array(z.string().min(1).max(64)).max(200).optional(),
  })
  .strict();

const readDevices = requireAccountAccess("analytics:read", { allowSiteKey: false });

mobileRoutes.get("/api/v1/mobile/devices", readDevices, async (c) => {
  const auth = getAuth(c);
  const res = await c.env.DB.prepare(
    "SELECT * FROM mobile_devices WHERE user_id = ? ORDER BY created_at DESC",
  )
    .bind(auth.user.id)
    .all<DeviceRow>();
  return success(c, (res.results ?? []).map(deviceDto));
});

mobileRoutes.post("/api/v1/mobile/devices", readDevices, async (c) => {
  const { auth, token } = await requireMobileToken(c);
  const body = await parseJsonBody(c, DeviceBody, { maxBytes: 16 * 1024 });
  const db = c.env.DB;
  const existing = await db
    .prepare("SELECT * FROM mobile_devices WHERE push_token = ?")
    .bind(body.pushToken)
    .first<DeviceRow>();
  if (!existing || existing.user_id !== auth.user.id) {
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM mobile_devices WHERE user_id = ?")
      .bind(auth.user.id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_DEVICES_PER_USER) {
      throw new ApiError(400, `Device limit reached (max ${MAX_DEVICES_PER_USER})`);
    }
  }
  const now = Date.now();
  // A push token moving to another account (shared phone) is re-owned, not duplicated.
  const row = await db
    .prepare(
      `INSERT INTO mobile_devices (id, user_id, token_id, platform, push_token, name, notify_sales,
         notify_alerts, muted_site_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (push_token) DO UPDATE SET
         user_id = excluded.user_id, token_id = excluded.token_id, platform = excluded.platform,
         name = COALESCE(excluded.name, mobile_devices.name),
         notify_sales = ?, notify_alerts = ?, muted_site_ids = ?, last_error = NULL,
         updated_at = excluded.updated_at
       RETURNING *`,
    )
    .bind(
      newId(now),
      auth.user.id,
      token.id,
      body.platform,
      body.pushToken,
      body.name ?? null,
      body.notifySales === false ? 0 : 1,
      body.notifyAlerts === false ? 0 : 1,
      JSON.stringify(body.mutedSiteIds ?? []),
      now,
      now,
      // Updates keep the stored preference unless the body sets it.
      body.notifySales === undefined ? (existing?.notify_sales ?? 1) : body.notifySales ? 1 : 0,
      body.notifyAlerts === undefined ? (existing?.notify_alerts ?? 1) : body.notifyAlerts ? 1 : 0,
      body.mutedSiteIds === undefined
        ? (existing?.muted_site_ids ?? "[]")
        : JSON.stringify(body.mutedSiteIds),
    )
    .first<DeviceRow>();
  if (!row) throw new ApiError(500, "Device not saved");
  return success(c, [deviceDto(row)], { status: existing ? 200 : 201 });
});

mobileRoutes.delete("/api/v1/mobile/devices/:deviceId", readDevices, async (c) => {
  const auth = getAuth(c);
  const row = await c.env.DB.prepare(
    "DELETE FROM mobile_devices WHERE id = ? AND user_id = ? RETURNING id",
  )
    .bind(c.req.param("deviceId"), auth.user.id)
    .first<{ id: string }>();
  if (!row) throw new ApiError(404, "Device not found");
  return success(c, [{ deleted: true, id: row.id }]);
});
