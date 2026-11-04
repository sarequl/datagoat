/**
 * Funnels CRUD (DataFast Account API): list active funnels, create (2-8 steps), update
 * (2-10 steps, rename, reactivate) and soft delete. Names are unique among active funnels (409).
 * Results come from `GET /api/v1/analytics/funnels/:funnelId`.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { FunnelStep } from "../../../../shared/api-types";
import { getAccess, getAuth } from "../../../auth/context";
import { requireSiteAccess } from "../../../auth/middleware";
import { parseJsonColumn } from "../../../lib/d1";
import { ApiError } from "../../../lib/errors";
import { isObjectIdLike, newId } from "../../../lib/ids";
import { success } from "../../../lib/response";
import { toIso } from "../../../lib/time";
import { parseJsonBody } from "../../../lib/validate";
import { assertStepCount, normaliseSteps, slugify, zFunnelStepInput } from "../../../query/funnels";
import type { AppEnv } from "../../../types";

export const funnelAdminRoutes = new Hono<AppEnv>();

const W = "/api/v1/admin/websites/:websiteId";

interface FunnelRow {
  id: string;
  site_id: string;
  name: string;
  slug: string;
  steps: string;
  is_active: number;
  created_at: number;
  updated_at: number;
}

export function funnelDto(r: FunnelRow) {
  return {
    id: r.id,
    websiteId: r.site_id,
    name: r.name,
    slug: r.slug,
    steps: parseJsonColumn<FunnelStep[]>(r.steps, []),
    isActive: r.is_active === 1,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

const zName = z.string().trim().min(1).max(100);
const CreateBody = z.object({ name: zName, steps: z.array(zFunnelStepInput) });
const UpdateBody = z
  .object({
    name: zName.optional(),
    steps: z.array(zFunnelStepInput).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((b) => b.name !== undefined || b.steps !== undefined || b.isActive !== undefined, {
    message: "Provide name, steps or isActive",
  });

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

async function nameTaken(db: D1Database, siteId: string, name: string, exceptId?: string) {
  const row = await db
    .prepare(
      "SELECT id FROM funnels WHERE site_id = ? AND name = ? AND is_active = 1 AND id <> ? LIMIT 1",
    )
    .bind(siteId, name, exceptId ?? "")
    .first();
  return row !== null;
}

funnelAdminRoutes.get(
  `${W}/funnels`,
  requireSiteAccess("funnels:read", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const rows = await c.env.DB.prepare(
      "SELECT * FROM funnels WHERE site_id = ? AND is_active = 1 ORDER BY created_at, id",
    )
      .bind(site.id)
      .all<FunnelRow>();
    return success(c, (rows.results ?? []).map(funnelDto));
  },
);

funnelAdminRoutes.post(
  `${W}/funnels`,
  requireSiteAccess("funnels:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const body = await parseJsonBody(c, CreateBody);
    assertStepCount(body.steps, 2, 8);
    if (await nameTaken(c.env.DB, site.id, body.name)) {
      throw new ApiError(409, "A funnel with this name already exists");
    }
    const now = Date.now();
    const id = newId(now);
    try {
      const row = await c.env.DB.prepare(
        `INSERT INTO funnels (id, site_id, name, slug, steps, is_active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?) RETURNING *`,
      )
        .bind(
          id,
          site.id,
          body.name,
          slugify(body.name),
          JSON.stringify(normaliseSteps(body.steps)),
          getAuth(c).user.id,
          now,
          now,
        )
        .first<FunnelRow>();
      if (!row) throw new ApiError(500, "Could not create the funnel");
      return success(c, [funnelDto(row)]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError(409, "A funnel with this name already exists");
      throw err;
    }
  },
);

async function loadFunnel(db: D1Database, siteId: string, funnelId: string): Promise<FunnelRow> {
  if (!isObjectIdLike(funnelId)) throw new ApiError(400, "Invalid funnelId");
  const row = await db
    .prepare("SELECT * FROM funnels WHERE id = ? AND site_id = ?")
    .bind(funnelId, siteId)
    .first<FunnelRow>();
  if (!row) throw new ApiError(404, "Funnel not found");
  return row;
}

funnelAdminRoutes.put(
  `${W}/funnels/:funnelId`,
  requireSiteAccess("funnels:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const row = await loadFunnel(c.env.DB, site.id, c.req.param("funnelId"));
    const body = await parseJsonBody(c, UpdateBody);
    if (body.steps) assertStepCount(body.steps, 2, 10);
    const name = body.name ?? row.name;
    const active = body.isActive ?? row.is_active === 1;
    if (active && (await nameTaken(c.env.DB, site.id, name, row.id))) {
      throw new ApiError(409, "A funnel with this name already exists");
    }
    try {
      const updated = await c.env.DB.prepare(
        `UPDATE funnels SET name = ?, slug = ?, steps = ?, is_active = ?, updated_at = ?
         WHERE id = ? AND site_id = ? RETURNING *`,
      )
        .bind(
          name,
          slugify(name),
          body.steps ? JSON.stringify(normaliseSteps(body.steps)) : row.steps,
          active ? 1 : 0,
          Date.now(),
          row.id,
          site.id,
        )
        .first<FunnelRow>();
      if (!updated) throw new ApiError(404, "Funnel not found");
      return success(c, [funnelDto(updated)]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError(409, "A funnel with this name already exists");
      throw err;
    }
  },
);

funnelAdminRoutes.delete(
  `${W}/funnels/:funnelId`,
  requireSiteAccess("funnels:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const row = await loadFunnel(c.env.DB, site.id, c.req.param("funnelId"));
    if (row.is_active === 1) {
      await c.env.DB.prepare("UPDATE funnels SET is_active = 0, updated_at = ? WHERE id = ?")
        .bind(Date.now(), row.id)
        .run();
    }
    return success(c, [{ message: "Funnel deleted successfully" }]);
  },
);
