/**
 * First-run setup (plan §12 step 1, §13). The operator opens `/setup?token=<SETUP_TOKEN>`; the
 * dashboard posts the token with the first owner's email and password (and optionally the first
 * website). Setup works exactly once: the `setup_completed_at` instance setting is inserted in the
 * same D1 batch (transaction) as the user, so two concurrent setups cannot both succeed.
 *
 *   GET  /api/setup   → { needsSetup, configErrors }
 *   POST /api/setup   { token, email, password, name?, website?: { domain, timezone?, name? } }
 */
import { Hono } from "hono";
import { z } from "zod";
import { CreateWebsiteBody, prepareCreateWebsite } from "../api/v1/account/websites-service";
import { meDto, passwordIterations, zPassword } from "../auth/routes";
import { startSession } from "../auth/sessions";
import { hashPassword, MIN_SECRET_LENGTH, timingSafeEqual } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { newId } from "../lib/ids";
import { success } from "../lib/response";
import { parseJsonBody, zEmail } from "../lib/validate";
import type { AppEnv } from "../types";

export const SETUP_COMPLETED_KEY = "setup_completed_at";
export const PUBLIC_URL_KEY = "public_url";
const MIN_SETUP_TOKEN_LENGTH = 16;

/** Problems with the Worker's secrets that make setup unsafe. Empty when all is well. */
export function configErrors(env: Cloudflare.Env): string[] {
  const errors: string[] = [];
  const check = (name: "SETUP_TOKEN" | "SESSION_SECRET" | "ENCRYPTION_KEY", min: number) => {
    const value = env[name];
    if (!value) errors.push(`${name} is not set`);
    else if (value.startsWith("replace-with"))
      errors.push(`${name} still has the example placeholder value`);
    else if (value.length < min) errors.push(`${name} must be at least ${min} characters`);
  };
  check("SETUP_TOKEN", MIN_SETUP_TOKEN_LENGTH);
  check("SESSION_SECRET", MIN_SECRET_LENGTH);
  check("ENCRYPTION_KEY", MIN_SECRET_LENGTH);
  return errors;
}

export async function isSetupComplete(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT value FROM instance_settings WHERE key = ?) AS done",
    )
    .bind(SETUP_COMPLETED_KEY)
    .first<{ users: number; done: string | null }>();
  return Boolean(row && (row.users > 0 || row.done));
}

export const setupRoutes = new Hono<AppEnv>();

setupRoutes.get("/", async (c) => {
  const done = await isSetupComplete(c.env.DB);
  return success(c, { needsSetup: !done, configErrors: done ? [] : configErrors(c.env) });
});

const SetupBody = z
  .object({
    token: z.string().min(1).max(512),
    email: zEmail,
    password: zPassword,
    name: z.string().trim().max(100).nullish(),
    website: CreateWebsiteBody.optional(),
  })
  .strict();

setupRoutes.post("/", async (c) => {
  if (await isSetupComplete(c.env.DB)) throw new ApiError(409, "Setup has already been completed");
  const errors = configErrors(c.env);
  if (errors.length)
    throw new ApiError(503, `Fix the Worker configuration first: ${errors.join("; ")}`);
  const body = await parseJsonBody(c, SetupBody, { maxBytes: 8192 });
  if (!timingSafeEqual(body.token, c.env.SETUP_TOKEN))
    throw new ApiError(403, "Invalid setup token");

  const db = c.env.DB;
  const now = Date.now();
  const userId = newId(now);
  const statements: D1PreparedStatement[] = [
    // Plain INSERT: a second concurrent setup fails here and its whole batch rolls back.
    db
      .prepare("INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(SETUP_COMPLETED_KEY, String(now), now),
    db
      .prepare(
        `INSERT INTO instance_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(PUBLIC_URL_KEY, new URL(c.req.url).origin, now),
    db
      .prepare(
        `INSERT INTO users (id, email, password_hash, name, created_at, updated_at, password_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        userId,
        body.email,
        await hashPassword(body.password, passwordIterations(c.env)),
        body.name ?? null,
        now,
        now,
        now,
      ),
  ];
  let website: { websiteId: string; domain: string; trackingId: string } | null = null;
  if (body.website) {
    const created = await prepareCreateWebsite(db, body.website, userId, now);
    statements.push(...created.statements);
    website = { websiteId: created.id, domain: body.website.domain, trackingId: created.publicId };
  }
  try {
    await db.batch(statements);
  } catch (err) {
    if (String(err).includes("UNIQUE") || String(err).includes("PRIMARY KEY")) {
      throw new ApiError(409, "Setup has already been completed");
    }
    // Setup runs before anyone can read logs in a dashboard: say what failed.
    throw new ApiError(500, `Setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  await startSession(c, userId, now);
  const me = await meDto(db, {
    id: userId,
    email: body.email,
    name: body.name ?? null,
    image: null,
    createdAt: now,
  });
  return success(c, { ...me, website });
});
