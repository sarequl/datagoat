/**
 * Import jobs (DG): Plausible CSV export → `imported_daily`.
 *
 * Dashboard flow (works on the Free plan): create a job, parse the ZIP in the browser with the
 * same parser the Worker uses, `POST …/rows` in chunks of ≤ 1000 rows, then `POST …/complete`.
 * API flow for small exports: create a job, `POST …/file` with the ZIP as the body.
 *
 * Write budget: one written row per imported row (the table's primary key is its only index), 10
 * rows per INSERT statement and up to 100 statements per D1 batch.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { ImportJob } from "../../../shared/api-types";
import { getAccess } from "../../auth/context";
import { requireSiteAccess } from "../../auth/middleware";
import { chunk } from "../../lib/d1";
import { ApiError } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { success } from "../../lib/response";
import { isDateString, toIso, toIsoOrNull } from "../../lib/time";
import { parseJsonBody } from "../../lib/validate";
import type { AppEnv } from "../../types";
import { errorMessage } from "../shared/http";
import { IMPORT_DIMENSIONS, type ImportRow, parsePlausibleZip } from "./plausible";

export const importRoutes = new Hono<AppEnv>();
const W = "/api/v1/admin/websites/:websiteId";
const P = { param: "websiteId" } as const;

export const MAX_ROWS_PER_REQUEST = 1000;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Server-side parsing is CPU heavy; bigger exports must use the dashboard (browser) import. */
export const MAX_FILE_ROWS = 20_000;

interface ImportRowDb {
  id: string;
  site_id: string;
  source: "plausible" | "datafast";
  status: ImportJob["status"];
  file_name: string | null;
  range_start: string | null;
  range_end: string | null;
  rows_total: number | null;
  rows_imported: number;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

function dto(r: ImportRowDb): ImportJob {
  return {
    id: r.id,
    websiteId: r.site_id,
    source: r.source,
    status: r.status,
    fileName: r.file_name,
    rangeStart: r.range_start,
    rangeEnd: r.range_end,
    rowsTotal: r.rows_total,
    rowsImported: r.rows_imported,
    error: r.error,
    createdAt: toIso(r.created_at),
    finishedAt: toIsoOrNull(r.finished_at),
  };
}

async function load(db: D1Database, siteId: string, id: string): Promise<ImportRowDb> {
  const row = await db
    .prepare("SELECT * FROM imports WHERE id = ? AND site_id = ?")
    .bind(id, siteId)
    .first<ImportRowDb>();
  if (!row) throw new ApiError(404, "Import not found");
  return row;
}

export function insertStatements(
  db: D1Database,
  siteId: string,
  importId: string,
  rows: readonly ImportRow[],
) {
  return chunk(rows, 10).map((part) =>
    db
      .prepare(
        `INSERT INTO imported_daily (site_id, import_id, day, dimension, value, visitors, visits, pageviews, bounces, duration_sum)
         VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
         ON CONFLICT (site_id, day, dimension, value, import_id) DO UPDATE SET
           visitors = visitors + excluded.visitors, visits = visits + excluded.visits,
           pageviews = pageviews + excluded.pageviews, bounces = bounces + excluded.bounces,
           duration_sum = duration_sum + excluded.duration_sum`,
      )
      .bind(
        ...part.flatMap((r) => [
          siteId,
          importId,
          r.day,
          r.dimension,
          r.value,
          r.visitors,
          r.visits,
          r.pageviews,
          r.bounces,
          r.durationSum,
        ]),
      ),
  );
}

function progressStatement(
  db: D1Database,
  job: ImportRowDb,
  rows: readonly ImportRow[],
  now: number,
) {
  const days = rows.map((r) => r.day).sort();
  return db
    .prepare(
      `UPDATE imports SET status = 'processing', started_at = COALESCE(started_at, ?1),
         rows_imported = rows_imported + ?2,
         range_start = CASE WHEN range_start IS NULL OR range_start > ?3 THEN ?3 ELSE range_start END,
         range_end = CASE WHEN range_end IS NULL OR range_end < ?4 THEN ?4 ELSE range_end END
       WHERE id = ?5`,
    )
    .bind(now, rows.length, days[0] ?? null, days[days.length - 1] ?? null, job.id);
}

async function writeRows(
  db: D1Database,
  job: ImportRowDb,
  rows: readonly ImportRow[],
  now: number,
) {
  const stmts = insertStatements(db, job.site_id, job.id, rows);
  const groups = chunk(stmts, 100);
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i] ?? [];
    // The progress update rides along in the last batch.
    if (i === groups.length - 1) group.push(progressStatement(db, job, rows, now));
    await db.batch(group);
  }
  if (groups.length === 0) await progressStatement(db, job, rows, now).run();
}

const CreateBody = z
  .object({
    source: z.literal("plausible").default("plausible"),
    fileName: z.string().trim().max(200).optional(),
  })
  .strict();

const RowSchema = z
  .object({
    day: z.string().refine(isDateString, { message: "must be YYYY-MM-DD" }),
    dimension: z.enum(IMPORT_DIMENSIONS as unknown as [string, ...string[]]),
    value: z.string().max(500),
    visitors: z.number().int().min(0).max(1e12),
    visits: z.number().int().min(0).max(1e12).default(0),
    pageviews: z.number().int().min(0).max(1e12).default(0),
    bounces: z.number().int().min(0).max(1e12).default(0),
    durationSum: z.number().int().min(0).max(1e15).default(0),
  })
  .strict()
  .refine((r) => (r.dimension === "" ? r.value === "" : r.value !== ""), {
    message: "value must be empty for totals (dimension '') and non-empty otherwise",
  });

const RowsBody = z.object({ rows: z.array(RowSchema).min(1).max(MAX_ROWS_PER_REQUEST) }).strict();

importRoutes.get(`${W}/imports`, requireSiteAccess("settings:read", P), async (c) => {
  const { site } = getAccess(c);
  const res = await c.env.DB.prepare(
    "SELECT * FROM imports WHERE site_id = ? ORDER BY created_at DESC LIMIT 50",
  )
    .bind(site.id)
    .all<ImportRowDb>();
  return success(c, (res.results ?? []).map(dto));
});

importRoutes.post(`${W}/imports`, requireSiteAccess("settings:write", P), async (c) => {
  const { site, user } = getAccess(c);
  const body = await parseJsonBody(c, CreateBody, { maxBytes: 2048 });
  const now = Date.now();
  const id = newId(now);
  await c.env.DB.prepare(
    "INSERT INTO imports (id, site_id, source, status, file_name, created_by, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
  )
    .bind(id, site.id, body.source, body.fileName ?? null, user.id, now)
    .run();
  return success(c, [dto(await load(c.env.DB, site.id, id))]);
});

importRoutes.get(`${W}/imports/:importId`, requireSiteAccess("settings:read", P), async (c) => {
  const { site } = getAccess(c);
  return success(c, [dto(await load(c.env.DB, site.id, c.req.param("importId")))]);
});

importRoutes.delete(`${W}/imports/:importId`, requireSiteAccess("settings:write", P), async (c) => {
  const { site } = getAccess(c);
  const job = await load(c.env.DB, site.id, c.req.param("importId"));
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM imported_daily WHERE site_id = ? AND import_id = ?").bind(
      site.id,
      job.id,
    ),
    c.env.DB.prepare(
      "UPDATE imports SET status = 'cancelled', rows_imported = 0, finished_at = COALESCE(finished_at, ?) WHERE id = ?",
    ).bind(now, job.id),
  ]);
  return success(c, [dto(await load(c.env.DB, site.id, job.id))]);
});

function assertOpen(job: ImportRowDb) {
  if (job.status !== "pending" && job.status !== "processing") {
    throw new ApiError(409, `Import is ${job.status}; create a new import`);
  }
}

importRoutes.post(
  `${W}/imports/:importId/rows`,
  requireSiteAccess("settings:write", P),
  async (c) => {
    const { site } = getAccess(c);
    const job = await load(c.env.DB, site.id, c.req.param("importId"));
    assertOpen(job);
    const { rows } = await parseJsonBody(c, RowsBody, { maxBytes: 512 * 1024 });
    await writeRows(c.env.DB, job, rows as ImportRow[], Date.now());
    return success(c, [{ accepted: rows.length }]);
  },
);

importRoutes.post(
  `${W}/imports/:importId/complete`,
  requireSiteAccess("settings:write", P),
  async (c) => {
    const { site } = getAccess(c);
    const job = await load(c.env.DB, site.id, c.req.param("importId"));
    assertOpen(job);
    await c.env.DB.prepare(
      "UPDATE imports SET status = 'completed', rows_total = rows_imported, finished_at = ? WHERE id = ?",
    )
      .bind(Date.now(), job.id)
      .run();
    return success(c, [dto(await load(c.env.DB, site.id, job.id))]);
  },
);

/** DG: upload the Plausible ZIP itself and import it on the server. */
importRoutes.post(
  `${W}/imports/:importId/file`,
  requireSiteAccess("settings:write", P),
  async (c) => {
    const { site } = getAccess(c);
    const job = await load(c.env.DB, site.id, c.req.param("importId"));
    assertOpen(job);
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > MAX_FILE_BYTES)
      throw new ApiError(413, `The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES)
      throw new ApiError(413, `The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    const now = Date.now();
    let parsed: Awaited<ReturnType<typeof parsePlausibleZip>>;
    try {
      parsed = await parsePlausibleZip(bytes);
    } catch (err) {
      const message = errorMessage(err);
      await c.env.DB.prepare(
        "UPDATE imports SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
      )
        .bind(message, now, job.id)
        .run();
      throw new ApiError(400, message);
    }
    if (parsed.rows.length > MAX_FILE_ROWS) {
      throw new ApiError(
        413,
        `This export has ${parsed.rows.length} rows; import it from the dashboard, which uploads it in chunks`,
      );
    }
    await writeRows(c.env.DB, job, parsed.rows, now);
    await c.env.DB.prepare(
      "UPDATE imports SET status = 'completed', rows_total = rows_imported, finished_at = ? WHERE id = ?",
    )
      .bind(now, job.id)
      .run();
    return success(c, [dto(await load(c.env.DB, site.id, job.id))], {
      extra: { tables: parsed.tables, skipped: parsed.skipped },
    });
  },
);
