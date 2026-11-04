/**
 * Saved segments (DataFast "Save as segment"): per-website named filter sets, stored as
 * `{ "filter_country": "is:US", ... }` and validated with the filter compiler's parser.
 * Read with analytics:read, write with settings:write. At most 50 per website.
 */
import { Hono } from "hono";
import { z } from "zod";
import { getAccess, getAuth } from "../../../auth/context";
import { requireSiteAccess } from "../../../auth/middleware";
import { parseJsonColumn } from "../../../lib/d1";
import { ApiError } from "../../../lib/errors";
import { filtersToParams, parseFilters } from "../../../lib/filters";
import { isObjectIdLike, newId } from "../../../lib/ids";
import { success } from "../../../lib/response";
import { toIso } from "../../../lib/time";
import { parseJsonBody } from "../../../lib/validate";
import type { AppEnv } from "../../../types";

export const segmentRoutes = new Hono<AppEnv>();

const W = "/api/v1/admin/websites/:websiteId";
export const MAX_SEGMENTS = 50;

interface SegmentRow {
  id: string;
  site_id: string;
  name: string;
  filters: string;
  created_at: number;
  updated_at: number;
}

function segmentDto(r: SegmentRow) {
  return {
    id: r.id,
    websiteId: r.site_id,
    name: r.name,
    filters: parseJsonColumn<Record<string, string>>(r.filters, {}),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

const zFilters = z
  .record(z.string(), z.string())
  .refine((f) => Object.keys(f).length > 0, { message: "must contain at least one filter_* key" })
  .transform((f) => {
    if (Object.keys(f).some((k) => !k.startsWith("filter_"))) {
      throw new ApiError(400, "filters: keys must be filter_* parameters");
    }
    // Normalise to `operator:value,...` (validates keys, operators and values).
    return filtersToParams(parseFilters(f));
  });

const CreateBody = z.object({ name: z.string().trim().min(1).max(80), filters: zFilters }).strict();
const UpdateBody = z
  .object({ name: z.string().trim().min(1).max(80).optional(), filters: zFilters.optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.filters !== undefined, {
    message: "Provide name or filters",
  });

segmentRoutes.get(
  `${W}/segments`,
  requireSiteAccess("analytics:read", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const rows = await c.env.DB.prepare(
      "SELECT * FROM segments WHERE site_id = ? ORDER BY name, id",
    )
      .bind(site.id)
      .all<SegmentRow>();
    return success(c, (rows.results ?? []).map(segmentDto));
  },
);

segmentRoutes.post(
  `${W}/segments`,
  requireSiteAccess("settings:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const body = await parseJsonBody(c, CreateBody, { maxBytes: 16_384 });
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM segments WHERE site_id = ?")
      .bind(site.id)
      .first<number>("n");
    if ((count ?? 0) >= MAX_SEGMENTS)
      throw new ApiError(400, `A website can have at most ${MAX_SEGMENTS} segments`);
    const now = Date.now();
    const row = await c.env.DB.prepare(
      `INSERT INTO segments (id, site_id, name, filters, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
      .bind(
        newId(now),
        site.id,
        body.name,
        JSON.stringify(body.filters),
        getAuth(c).user.id,
        now,
        now,
      )
      .first<SegmentRow>();
    if (!row) throw new ApiError(500, "Could not create the segment");
    return success(c, [segmentDto(row)]);
  },
);

async function loadSegment(db: D1Database, siteId: string, id: string): Promise<SegmentRow> {
  if (!isObjectIdLike(id)) throw new ApiError(400, "Invalid segmentId");
  const row = await db
    .prepare("SELECT * FROM segments WHERE id = ? AND site_id = ?")
    .bind(id, siteId)
    .first<SegmentRow>();
  if (!row) throw new ApiError(404, "Segment not found");
  return row;
}

segmentRoutes.put(
  `${W}/segments/:segmentId`,
  requireSiteAccess("settings:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const row = await loadSegment(c.env.DB, site.id, c.req.param("segmentId"));
    const body = await parseJsonBody(c, UpdateBody, { maxBytes: 16_384 });
    const updated = await c.env.DB.prepare(
      "UPDATE segments SET name = ?, filters = ?, updated_at = ? WHERE id = ? RETURNING *",
    )
      .bind(
        body.name ?? row.name,
        body.filters ? JSON.stringify(body.filters) : row.filters,
        Date.now(),
        row.id,
      )
      .first<SegmentRow>();
    if (!updated) throw new ApiError(404, "Segment not found");
    return success(c, [segmentDto(updated)]);
  },
);

segmentRoutes.delete(
  `${W}/segments/:segmentId`,
  requireSiteAccess("settings:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const row = await loadSegment(c.env.DB, site.id, c.req.param("segmentId"));
    await c.env.DB.prepare("DELETE FROM segments WHERE id = ?").bind(row.id).run();
    return success(c, [{ deleted: true }]);
  },
);
