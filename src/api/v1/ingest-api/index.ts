/**
 * W2 — Server-side events (DataFast `POST|DELETE /api/v1/goals`, `POST /api/v1/identify`).
 *
 * Write cost: a server-side goal is one event row (row + events_time + the two activity indexes
 * = 4 rows) after one indexed session lookup; identify updates one visitors row (plus its
 * user/email index entries) and writes nothing when the profile is unchanged.
 */
import { Hono } from "hono";
import { z } from "zod";
import { getAccess } from "../../../auth/context";
import { requireSiteAccess } from "../../../auth/middleware";
import { sha256Hex } from "../../../lib/crypto";
import { parseJsonColumn } from "../../../lib/d1";
import { ApiError } from "../../../lib/errors";
import { success } from "../../../lib/response";
import type { Site } from "../../../lib/sites";
import { addDays, localDate, parseRange } from "../../../lib/time";
import { GOAL_NAME_RE, normaliseGoalName, parseJsonBody, zGoalName } from "../../../lib/validate";
import { PAYMENT_GOALS } from "../../../query/event-breakdowns";
import { assertVisitorId } from "../../../query/visitors";
import type { AppEnv } from "../../../types";

export const ingestApiRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// POST /api/v1/goals
// ---------------------------------------------------------------------------

const zMetadata = z
  .record(
    z.string(),
    z.union([
      z.string().max(255, "metadata values must be at most 255 characters"),
      z.number(),
      z.boolean(),
    ]),
  )
  .refine((m) => Object.keys(m).every((k) => /^[a-z0-9_-]{1,64}$/.test(k)), {
    message: "metadata keys must match ^[a-z0-9_-]+$ (max 64)",
  })
  .refine((m) => Object.keys(m).length <= 10, { message: "metadata accepts at most 10 keys" });

const GoalBody = z.object({
  datafast_visitor_id: z.string().optional(),
  visitorId: z.string().optional(),
  name: zGoalName,
  description: z.string().max(1000).optional(),
  metadata: zMetadata.optional(),
});

function visitorIdOf(
  body: { datafast_visitor_id?: string; visitorId?: string },
  site: Site,
): string {
  const id = body.datafast_visitor_id ?? body.visitorId;
  if (!id) throw new ApiError(400, "datafast_visitor_id is required");
  try {
    assertVisitorId(id, site.privacyMode);
  } catch {
    throw new ApiError(400, "Invalid datafast_visitor_id: must be a UUID v4");
  }
  return id;
}

ingestApiRoutes.post("/api/v1/goals", requireSiteAccess("goals:write"), async (c) => {
  const { site } = getAccess(c);
  const body = await parseJsonBody(c, GoalBody, { maxBytes: 16_384 });
  const visitorId = visitorIdOf(body, site);
  const session = await c.env.DB.prepare(
    `SELECT id, hostname, COALESCE(exit_path, entry_path) AS path FROM sessions
     WHERE site_id = ? AND visitor_id = ? ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(site.id, visitorId)
    .first<{ id: string; hostname: string | null; path: string }>();
  if (!session) throw new ApiError(404, "Visitor has no pageviews on this website");
  const props: Record<string, unknown> = { ...(body.metadata ?? {}) };
  if (body.description) props.$description = body.description;
  const row = await c.env.DB.prepare(
    `INSERT INTO events (site_id, ts, session_id, visitor_id, type, hostname, path, name, props)
     VALUES (?, ?, ?, ?, 'custom', ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      site.id,
      Date.now(),
      session.id,
      visitorId,
      session.hostname,
      session.path,
      body.name,
      Object.keys(props).length ? JSON.stringify(props) : null,
    )
    .first<{ id: number }>();
  return success(c, [
    { message: "Custom event created successfully", eventId: String(row?.id ?? "") },
  ]);
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/goals
// ---------------------------------------------------------------------------

const DELETE_CHUNK = 5000;
const DELETE_ROUNDS = 10;

function resolveDeleteRange(q: Record<string, string>, site: Site) {
  const canonical = q.startAt !== undefined || q.endAt !== undefined;
  const legacy = q.start !== undefined || q.end !== undefined;
  if (canonical && legacy && (q.startAt !== q.start || q.endAt !== q.end)) {
    throw new ApiError(400, "Conflicting ranges: use startAt and endAt");
  }
  const startAt = q.startAt ?? q.start;
  const endAt = q.endAt ?? q.end;
  if (!startAt !== !endAt) throw new ApiError(400, "startAt and endAt must be provided together");
  return parseRange({ startAt, endAt, timezone: q.timezone }, site.timezone);
}

ingestApiRoutes.delete("/api/v1/goals", requireSiteAccess("goals:write"), async (c) => {
  const { site } = getAccess(c);
  const q = c.req.query();
  const visitorRaw = q.datafast_visitor_id ?? q.visitorId;
  let visitorId: string | null = null;
  if (visitorRaw !== undefined) visitorId = visitorIdOf({ datafast_visitor_id: visitorRaw }, site);
  let name: string | null = null;
  if (q.name !== undefined) {
    name = normaliseGoalName(q.name);
    if (!GOAL_NAME_RE.test(name) || name === "identify")
      throw new ApiError(400, "Invalid goal name");
  }
  const range = resolveDeleteRange(q, site);
  if (!visitorId && !name && !range) {
    throw new ApiError(400, "Provide datafast_visitor_id, name, or startAt and endAt");
  }
  const where: string[] = ["site_id = ?", "type <> 'pageview'", "type = 'custom'"];
  const params: Array<string | number> = [site.id];
  if (visitorId) {
    where.push("visitor_id = ?");
    params.push(visitorId);
  }
  if (name) {
    where.push("name = ?");
    params.push(name);
  } else {
    // Payment-provider goals follow their payments (DELETE /api/v1/payments).
    where.push(
      `(name IS NULL OR name NOT IN (${[...PAYMENT_GOALS].map((g) => `'${g}'`).join(", ")}))`,
    );
  }
  if (range) {
    where.push("ts >= ?", "ts < ?");
    params.push(range.startMs, range.endMs);
  }
  const db = c.env.DB;
  const condition = where.join(" AND ");
  // Pin the partial indexes: by visitor, or by type and time (never the pageview time index).
  const source = visitorId
    ? "events INDEXED BY events_visitor_activity"
    : "events INDEXED BY events_activity";
  // Rollups of closed days that held these goals are rebuilt by the rollup job.
  const first = await db
    .prepare(`SELECT MIN(ts) AS t FROM ${source} WHERE ${condition}`)
    .bind(...params)
    .first<number | null>("t");
  let deleted = 0;
  let rounds = 0;
  for (; rounds < DELETE_ROUNDS; rounds++) {
    const res = await db
      .prepare(
        `DELETE FROM events WHERE id IN (SELECT id FROM ${source} WHERE ${condition} LIMIT ${DELETE_CHUNK})`,
      )
      .bind(...params)
      .run();
    const n = res.meta.changes ?? 0;
    deleted += n;
    if (n < DELETE_CHUNK) break;
  }
  if (first !== null && first !== undefined && deleted > 0) {
    const day = localDate(first, site.timezone);
    await db.batch([
      db
        .prepare(
          `DELETE FROM daily_goals WHERE site_id = ? AND day >= ?${name ? " AND name = ?" : ""}`,
        )
        .bind(...(name ? [site.id, day, name] : [site.id, day])),
      db
        .prepare(
          "UPDATE rollup_state SET through_day = ?, updated_at = ? WHERE site_id = ? AND through_day >= ?",
        )
        .bind(addDays(day, -1), Date.now(), site.id, day),
    ]);
  }
  if (rounds === DELETE_ROUNDS) {
    throw new ApiError(504, "Delete operation timed out. Retry with a smaller time range.");
  }
  const parts = ["Goal events deleted successfully"];
  if (visitorId) parts.push("for visitor");
  if (range) parts.push("within time range");
  return success(c, [
    {
      message: parts.join(" "),
      ...(visitorId ? { datafast_visitor_id: visitorId } : {}),
      ...(name ? { goal_name: name } : {}),
      ...(range
        ? {
            timeRange: {
              start: new Date(range.startMs).toISOString(),
              end: new Date(range.endMs - 1).toISOString(),
            },
          }
        : {}),
      deleted,
    },
  ]);
});

// ---------------------------------------------------------------------------
// POST /api/v1/identify
// ---------------------------------------------------------------------------

const IdentifyBody = z
  .object({
    user_id: z
      .union([z.string(), z.number()])
      .transform((v) => String(v).trim())
      .refine((v) => v.length >= 1, { message: "user_id is required" })
      .refine((v) => v.length <= 255, { message: "user_id must be at most 255 characters" }),
    datafast_visitor_id: z.string().optional(),
    visitorId: z.string().optional(),
  })
  .passthrough();

const PLACEHOLDER_NAMES = new Set(["undefined", "undefined undefined", "null", "null null", ""]);

interface VisitorRow {
  user_id: string | null;
  name: string | null;
  image: string | null;
  profile: string | null;
  email: string | null;
  email_hash: string | null;
}

ingestApiRoutes.post("/api/v1/identify", requireSiteAccess("identify:write"), async (c) => {
  const { site } = getAccess(c);
  const body = await parseJsonBody(c, IdentifyBody, { maxBytes: 16_384 });
  if (!body.datafast_visitor_id && !body.visitorId) {
    throw new ApiError(400, "datafast_visitor_id is required");
  }
  const visitorId = visitorIdOf(body, site);
  if (site.privacyMode === "cookieless") {
    return c.json({
      status: "success",
      data: { message: "Identify accepted; profiles are not stored on cookieless websites" },
    });
  }
  const visitor = await c.env.DB.prepare(
    "SELECT user_id, name, image, profile, email, email_hash FROM visitors WHERE site_id = ? AND id = ?",
  )
    .bind(site.id, visitorId)
    .first<VisitorRow>();
  if (!visitor) throw new ApiError(404, "Visitor has no pageviews on this website");

  const { user_id: userId, datafast_visitor_id: _a, visitorId: _b, ...extra } = body;
  const fields: Record<string, unknown> = { ...extra };
  let name = visitor.name;
  if (typeof fields.name === "string") {
    const n = fields.name.trim();
    if (PLACEHOLDER_NAMES.has(n.toLowerCase())) delete fields.name;
    else name = n.slice(0, 255);
  }
  let image = visitor.image;
  for (const key of ["image", "avatar"]) {
    if (typeof fields[key] === "string" && /^https?:\/\//.test(fields[key] as string)) {
      image = (fields[key] as string).slice(0, 2048);
    }
  }
  let email = visitor.email;
  let emailHash = visitor.email_hash;
  if (typeof fields.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.trim())) {
    const normalised = fields.email.trim().toLowerCase();
    emailHash = await sha256Hex(normalised);
    email = site.storeCustomerEmails ? normalised : null;
    if (!site.storeCustomerEmails) delete fields.email;
    else fields.email = normalised;
  }
  const previous = parseJsonColumn<Record<string, unknown>>(visitor.profile, {});
  const merged = { ...previous, ...fields };
  const profile = JSON.stringify(merged);
  const action =
    visitor.user_id === null
      ? "created"
      : visitor.user_id === userId &&
          JSON.stringify(previous) === profile &&
          name === visitor.name &&
          image === visitor.image &&
          email === visitor.email &&
          emailHash === visitor.email_hash
        ? "unchanged"
        : "updated";
  if (action !== "unchanged") {
    await c.env.DB.prepare(
      `UPDATE visitors SET user_id = ?, name = ?, image = ?, profile = ?, identified_at = ?, email = ?, email_hash = ?
       WHERE site_id = ? AND id = ?`,
    )
      .bind(userId, name, image, profile, Date.now(), email, emailHash, site.id, visitorId)
      .run();
  }
  const profileId = (await sha256Hex(`${site.id}:${visitorId}`)).slice(0, 24);
  const messages = {
    created: "User profile created successfully",
    updated: "User profile updated successfully",
    unchanged: "User profile unchanged",
  } as const;
  return c.json({ status: "success", data: { message: messages[action], profileId, action } });
});
