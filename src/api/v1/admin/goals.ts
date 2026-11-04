/**
 * Tracked goals and goal customizations (DataFast Account API):
 *   GET    /api/v1/admin/websites/:websiteId/goals                   settings:read
 *   GET    /api/v1/admin/websites/:websiteId/goals/customizations    goals:read
 *   PATCH  /api/v1/admin/websites/:websiteId/goals/customizations    goals:write
 *   DELETE /api/v1/admin/websites/:websiteId/goals/customizations    goals:write
 *
 * Tracked-goal counts cover the last 30 days (custom events through `events_activity`); goal
 * names seen earlier (rollups) or customized are listed with zero counts.
 */
import { Hono } from "hono";
import { z } from "zod";
import { getAccess } from "../../../auth/context";
import { requireSiteAccess } from "../../../auth/middleware";
import { ApiError } from "../../../lib/errors";
import { success } from "../../../lib/response";
import { lastNDays, toIso } from "../../../lib/time";
import { GOAL_NAME_RE, normaliseGoalName, parseJsonBody, zGoalName } from "../../../lib/validate";
import { PAYMENT_GOALS } from "../../../query/event-breakdowns";
import type { AppEnv } from "../../../types";

export const goalAdminRoutes = new Hono<AppEnv>();

const W = "/api/v1/admin/websites/:websiteId";

/** Allowed goal colours (DataGoat's own palette; one dark-mode-friendly tone per family). */
export const GOAL_COLORS = [
  { color: "#ef4444", label: "Red", family: "red" },
  { color: "#f97316", label: "Orange", family: "orange" },
  { color: "#f59e0b", label: "Amber", family: "amber" },
  { color: "#eab308", label: "Yellow", family: "yellow" },
  { color: "#84cc16", label: "Lime", family: "lime" },
  { color: "#22c55e", label: "Green", family: "green" },
  { color: "#10b981", label: "Emerald", family: "green" },
  { color: "#14b8a6", label: "Teal", family: "teal" },
  { color: "#06b6d4", label: "Cyan", family: "cyan" },
  { color: "#8dcdff", label: "Sky", family: "blue" },
  { color: "#3b82f6", label: "Blue", family: "blue" },
  { color: "#6366f1", label: "Indigo", family: "indigo" },
  { color: "#8b5cf6", label: "Violet", family: "purple" },
  { color: "#d946ef", label: "Fuchsia", family: "pink" },
  { color: "#ec4899", label: "Pink", family: "pink" },
  { color: "#94a3b8", label: "Slate", family: "gray" },
] as const;

const COLOR_SET = new Set<string>(GOAL_COLORS.map((c) => c.color));

interface CustomizationRow {
  name: string;
  display_name: string | null;
  color: string | null;
  description: string | null;
  hidden: number;
  updated_at: number;
}

function customizationDto(r: CustomizationRow) {
  return {
    goalName: r.name,
    displayName: r.display_name,
    color: r.color,
    description: r.description,
    hidden: r.hidden === 1,
    updatedAt: toIso(r.updated_at),
  };
}

goalAdminRoutes.get(
  `${W}/goals`,
  requireSiteAccess("settings:read", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const range = lastNDays(30, site.timezone);
    const db = c.env.DB;
    const [counts, visitors, older, custom] = await db.batch([
      db
        .prepare(
          `SELECT name, COUNT(*) AS total, COUNT(DISTINCT visitor_id) AS uv FROM events
         WHERE site_id = ? AND type <> 'pageview' AND type = 'custom' AND ts >= ? AND ts < ?
           AND name IS NOT NULL GROUP BY name`,
        )
        .bind(site.id, range.startMs, range.endMs),
      db
        .prepare(
          "SELECT COUNT(DISTINCT visitor_id) AS n FROM sessions WHERE site_id = ? AND started_at >= ? AND started_at < ?",
        )
        .bind(site.id, range.startMs, range.endMs),
      db.prepare("SELECT DISTINCT name FROM daily_goals WHERE site_id = ?").bind(site.id),
      db.prepare("SELECT * FROM goal_customizations WHERE site_id = ?").bind(site.id),
    ]);
    const total = Number((visitors?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
    const byName = new Map<string, { total: number; uv: number }>();
    for (const r of (counts?.results ?? []) as Array<{ name: string; total: number; uv: number }>) {
      byName.set(r.name, { total: Number(r.total), uv: Number(r.uv) });
    }
    for (const r of (older?.results ?? []) as Array<{ name: string }>) {
      if (!byName.has(r.name)) byName.set(r.name, { total: 0, uv: 0 });
    }
    const customs = new Map(
      ((custom?.results ?? []) as unknown as CustomizationRow[]).map((r) => [r.name, r]),
    );
    for (const name of customs.keys()) if (!byName.has(name)) byName.set(name, { total: 0, uv: 0 });
    const data = [...byName.entries()]
      .map(([name, n]) => {
        const cz = customs.get(name);
        return {
          name,
          displayName: cz?.display_name ?? null,
          color: cz?.color ?? null,
          description: cz?.description ?? null,
          ...(cz ? { hidden: cz.hidden === 1 } : {}),
          total: n.total,
          uv: n.uv,
          conversionRate: total > 0 ? Math.round((n.uv / total) * 10000) / 10000 : 0,
          eventType: PAYMENT_GOALS.has(name) ? "payment" : "custom",
        };
      })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    return success(c, data);
  },
);

goalAdminRoutes.get(
  `${W}/goals/customizations`,
  requireSiteAccess("goals:read", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const goalName = c.req.query("goalName");
    const stmt = goalName
      ? c.env.DB.prepare(
          "SELECT * FROM goal_customizations WHERE site_id = ? AND name = ? ORDER BY name",
        ).bind(site.id, normaliseGoalName(goalName))
      : c.env.DB.prepare("SELECT * FROM goal_customizations WHERE site_id = ? ORDER BY name").bind(
          site.id,
        );
    const rows = (await stmt.all<CustomizationRow>()).results ?? [];
    return success(c, rows.map(customizationDto), { extra: { colors: GOAL_COLORS } });
  },
);

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

const PatchBody = z
  .object({
    goalName: zGoalName,
    displayName: nullableText(80),
    color: z
      .string()
      .trim()
      .transform((v) => v.toLowerCase())
      .refine((v) => COLOR_SET.has(v), { message: "must be a colour from the allowed palette" })
      .nullable()
      .optional(),
    description: nullableText(300),
    hidden: z.boolean().optional(),
  })
  .strict();

goalAdminRoutes.patch(
  `${W}/goals/customizations`,
  requireSiteAccess("goals:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const body = await parseJsonBody(c, PatchBody, { maxBytes: 4096 });
    const changes = (["displayName", "color", "description", "hidden"] as const).filter(
      (k) => body[k] !== undefined,
    );
    if (!changes.length) {
      throw new ApiError(400, "Provide at least one of displayName, color, description, hidden");
    }
    const existing = await c.env.DB.prepare(
      "SELECT * FROM goal_customizations WHERE site_id = ? AND name = ?",
    )
      .bind(site.id, body.goalName)
      .first<CustomizationRow>();
    const next = {
      display_name:
        body.displayName !== undefined
          ? body.displayName || null
          : (existing?.display_name ?? null),
      color: body.color !== undefined ? body.color : (existing?.color ?? null),
      description:
        body.description !== undefined ? body.description || null : (existing?.description ?? null),
      hidden: body.hidden !== undefined ? (body.hidden ? 1 : 0) : (existing?.hidden ?? 0),
    };
    const now = Date.now();
    const row = await c.env.DB.prepare(
      `INSERT INTO goal_customizations (site_id, name, display_name, color, description, hidden, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (site_id, name) DO UPDATE SET display_name = excluded.display_name, color = excluded.color,
         description = excluded.description, hidden = excluded.hidden, updated_at = excluded.updated_at
       RETURNING *`,
    )
      .bind(
        site.id,
        body.goalName,
        next.display_name,
        next.color,
        next.description,
        next.hidden,
        now,
      )
      .first<CustomizationRow>();
    if (!row) throw new ApiError(500, "Could not save the goal customization");
    return success(c, [customizationDto(row)], { extra: { colors: GOAL_COLORS } });
  },
);

goalAdminRoutes.delete(
  `${W}/goals/customizations`,
  requireSiteAccess("goals:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const raw = c.req.query("goalName");
    if (!raw) throw new ApiError(400, "goalName query parameter is required");
    const goalName = normaliseGoalName(raw);
    if (!GOAL_NAME_RE.test(goalName)) throw new ApiError(400, "Invalid goalName");
    const res = await c.env.DB.prepare(
      "DELETE FROM goal_customizations WHERE site_id = ? AND name = ?",
    )
      .bind(site.id, goalName)
      .run();
    return success(c, [{ deleted: (res.meta.changes ?? 0) > 0, goalName }]);
  },
);
