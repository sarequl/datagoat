/**
 * Manual chart notes (DataFast notes API): list/search (default last 30 days), create with an
 * optional idempotency key (201 new, 200 replay, 409 key reused with different input), update
 * and delete. The author is the authenticated user. Never exposed on share links.
 */
import { Hono } from "hono";
import { z } from "zod";
import { getAccess, getAuth } from "../../../auth/context";
import { requireSiteAccess } from "../../../auth/middleware";
import { ApiError } from "../../../lib/errors";
import { isObjectIdLike, newId } from "../../../lib/ids";
import { paginationOf, success } from "../../../lib/response";
import type { Site } from "../../../lib/sites";
import { escapeLike } from "../../../lib/sql";
import { isDateString, lastNDays, parseRange, startOfDate, toIso } from "../../../lib/time";
import { parseJsonBody, parsePagination } from "../../../lib/validate";
import type { AppEnv } from "../../../types";

export const noteRoutes = new Hono<AppEnv>();

const W = "/api/v1/admin/websites/:websiteId";

interface NoteRow {
  id: string;
  site_id: string;
  ts: number;
  text: string;
  author_id: string | null;
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
  author_name?: string | null;
  author_image?: string | null;
  author_exists?: string | null;
}

function noteDto(r: NoteRow) {
  return {
    id: r.id,
    websiteId: r.site_id,
    text: r.text,
    timestamp: toIso(r.ts),
    author: r.author_exists
      ? { id: r.author_exists, name: r.author_name ?? null, image: r.author_image ?? null }
      : null,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

const SELECT = `SELECT n.*, u.id AS author_exists, u.name AS author_name, u.image AS author_image
  FROM notes n LEFT JOIN users u ON u.id = n.author_id`;

/** ISO timestamp with Z/offset, or YYYY-MM-DD at local midnight in the website timezone. */
function parseTimestamp(value: string, site: Site): number {
  if (isDateString(value)) return startOfDate(value, site.timezone);
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  throw new ApiError(400, "timestamp: use an ISO timestamp with Z or an offset, or YYYY-MM-DD");
}

const zText = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .max(500, "must be at most 500 characters");
const zKey = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, "1-128 letters, digits, . _ : or -");
const CreateBody = z
  .object({ text: zText, timestamp: z.string(), idempotencyKey: zKey.optional() })
  .strict();
const UpdateBody = z
  .object({ text: zText.optional(), timestamp: z.string().optional() })
  .strict()
  .refine((b) => b.text !== undefined || b.timestamp !== undefined, {
    message: "Provide text or timestamp",
  });

const LIST_PARAMS = new Set([
  "websiteId",
  "startAt",
  "endAt",
  "timezone",
  "q",
  "limit",
  "offset",
  "order",
]);

noteRoutes.get(`${W}/notes`, requireSiteAccess("notes:read", { param: "websiteId" }), async (c) => {
  const { site } = getAccess(c);
  const params = new URL(c.req.url).searchParams;
  const seen = new Set<string>();
  for (const k of params.keys()) {
    if (seen.has(k)) throw new ApiError(400, `Duplicate query parameter: ${k}`);
    if (!LIST_PARAMS.has(k)) throw new ApiError(400, `Unsupported query parameter: ${k}`);
    seen.add(k);
  }
  const q = c.req.query();
  const range = parseRange(q, site.timezone, (tz, now) => lastNDays(30, tz, now));
  if (!range) throw new ApiError(400, "Invalid range");
  const order = q.order ?? "desc";
  if (order !== "asc" && order !== "desc") throw new ApiError(400, "order must be asc or desc");
  const search = q.q?.trim() ?? "";
  if (search.length > 200) throw new ApiError(400, "q must be at most 200 characters");
  const { limit, offset } = parsePagination(q, { max: 1000 });
  const like = `%${escapeLike(search)}%`;
  const where =
    "n.site_id = ?1 AND n.ts >= ?2 AND n.ts < ?3 AND (?4 = '' OR n.text LIKE ?5 ESCAPE '\\')";
  const [rows, count] = await c.env.DB.batch([
    c.env.DB.prepare(
      `${SELECT} WHERE ${where} ORDER BY n.ts ${order === "asc" ? "ASC" : "DESC"}, n.id LIMIT ?6 OFFSET ?7`,
    ).bind(site.id, range.startMs, range.endMs, search, like, limit, offset),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM notes n WHERE ${where}`).bind(
      site.id,
      range.startMs,
      range.endMs,
      search,
      like,
    ),
  ]);
  const total = Number((count?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  return success(c, ((rows?.results ?? []) as unknown as NoteRow[]).map(noteDto), {
    pagination: paginationOf(limit, offset, total),
  });
});

noteRoutes.post(
  `${W}/notes`,
  requireSiteAccess("notes:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const userId = getAuth(c).user.id;
    const body = await parseJsonBody(c, CreateBody, { maxBytes: 8192 });
    const ts = parseTimestamp(body.timestamp, site);
    if (body.idempotencyKey) {
      const existing = await c.env.DB.prepare(
        `${SELECT} WHERE n.site_id = ? AND n.author_id = ? AND n.idempotency_key = ?`,
      )
        .bind(site.id, userId, body.idempotencyKey)
        .first<NoteRow>();
      if (existing) {
        if (existing.text === body.text && existing.ts === ts)
          return success(c, [noteDto(existing)]);
        throw new ApiError(409, "idempotencyKey was already used with a different note");
      }
    }
    const now = Date.now();
    const id = newId(now);
    try {
      await c.env.DB.prepare(
        `INSERT INTO notes (id, site_id, ts, text, author_id, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, site.id, ts, body.text, userId, body.idempotencyKey ?? null, now, now)
        .run();
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        throw new ApiError(409, "idempotencyKey was already used with a different note");
      }
      throw err;
    }
    const row = await loadNote(c.env.DB, site.id, id);
    return success(c, [noteDto(row)], { status: 201 });
  },
);

async function loadNote(db: D1Database, siteId: string, noteId: string): Promise<NoteRow> {
  if (!isObjectIdLike(noteId)) throw new ApiError(400, "Invalid noteId");
  const row = await db
    .prepare(`${SELECT} WHERE n.id = ? AND n.site_id = ?`)
    .bind(noteId, siteId)
    .first<NoteRow>();
  if (!row) throw new ApiError(404, "Note not found");
  return row;
}

noteRoutes.put(
  `${W}/notes/:noteId`,
  requireSiteAccess("notes:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const row = await loadNote(c.env.DB, site.id, c.req.param("noteId"));
    const body = await parseJsonBody(c, UpdateBody, { maxBytes: 8192 });
    const ts = body.timestamp !== undefined ? parseTimestamp(body.timestamp, site) : row.ts;
    await c.env.DB.prepare("UPDATE notes SET text = ?, ts = ?, updated_at = ? WHERE id = ?")
      .bind(body.text ?? row.text, ts, Date.now(), row.id)
      .run();
    return success(c, [noteDto(await loadNote(c.env.DB, site.id, row.id))]);
  },
);

noteRoutes.delete(
  `${W}/notes/:noteId`,
  requireSiteAccess("notes:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const row = await loadNote(c.env.DB, site.id, c.req.param("noteId"));
    await c.env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(row.id).run();
    return success(c, [{ id: row.id, deleted: true }]);
  },
);
