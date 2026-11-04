/**
 * Alert rules CRUD and history (DataFast Alerts API, extended with DataGoat triggers and
 * Telegram). W2 stores the rules; W6's jobs evaluate them, deliver through the outbox and write
 * `alert_history` and the counters.
 *
 *   GET    …/alerts                 alerts:read
 *   POST   …/alerts                 alerts:write   max 25 per website
 *   PUT    …/alerts/:alertId        alerts:write
 *   DELETE …/alerts/:alertId        alerts:write   history is kept
 *   GET    …/alerts/history         alerts:read    ?alertId, ?limit (default 50, max 100)
 *
 * Telegram bot tokens are encrypted with ENCRYPTION_KEY and AAD `alert:<siteId>:<alertId>` and
 * never returned.
 */
import { Hono } from "hono";
import { z } from "zod";
import { getAccess, getAuth } from "../../../auth/context";
import { requireSiteAccess } from "../../../auth/middleware";
import { encryptString } from "../../../lib/crypto";
import { parseJsonColumn } from "../../../lib/d1";
import { ApiError } from "../../../lib/errors";
import { isObjectIdLike, newId } from "../../../lib/ids";
import { success } from "../../../lib/response";
import { toIso } from "../../../lib/time";
import { parseJsonBody, zEmail, zGoalName } from "../../../lib/validate";
import type { AppEnv } from "../../../types";

export const alertRoutes = new Hono<AppEnv>();

const W = "/api/v1/admin/websites/:websiteId";
export const MAX_ALERTS = 25;

export function alertSecretAad(siteId: string, alertId: string): string {
  return `alert:${siteId}:${alertId}`;
}

interface AlertRow {
  id: string;
  site_id: string;
  name: string;
  trigger_type: "goal" | "new_sale" | "traffic_spike" | "weekly_digest";
  trigger: string;
  channel: "email" | "telegram";
  destination: string;
  secret_enc: string | null;
  template_subject: string | null;
  template_message: string | null;
  is_enabled: number;
  trigger_count: number;
  monthly_count: number;
  monthly_count_reset_at: number | null;
  daily_count: number;
  daily_count_reset_at: number | null;
  last_triggered_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface HistoryRow {
  alert_id: string;
  alert_name: string;
  goal_name: string | null;
  status: "sent" | "failed";
  error: string | null;
  visitor_id: string | null;
  triggered_at: number;
}

const startOfUtcMonth = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
const startOfUtcDay = (now: number) => Math.floor(now / 86_400_000) * 86_400_000;

function alertDto(r: AlertRow, logs: HistoryRow[], now = Date.now()) {
  const trigger = parseJsonColumn<Record<string, unknown>>(r.trigger, {});
  const destination = parseJsonColumn<Record<string, unknown>>(r.destination, {});
  return {
    id: r.id,
    websiteId: r.site_id,
    name: r.name,
    trigger: { type: r.trigger_type, ...trigger },
    destination: { type: r.channel, ...destination },
    template: {
      ...(r.template_subject ? { subject: r.template_subject } : {}),
      message: r.template_message ?? "",
    },
    isEnabled: r.is_enabled === 1,
    triggerCount: r.trigger_count,
    monthlyCount: r.monthly_count,
    monthlyCountResetAt: toIso(r.monthly_count_reset_at ?? startOfUtcMonth(now)),
    dailyCount: r.daily_count,
    dailyCountResetAt: toIso(r.daily_count_reset_at ?? startOfUtcDay(now)),
    ...(r.last_triggered_at !== null ? { lastTriggeredAt: toIso(r.last_triggered_at) } : {}),
    ...(r.last_error !== null ? { lastError: r.last_error } : {}),
    recentLogs: logs.map((l) => ({
      status: l.status,
      error: l.error,
      visitorId: l.visitor_id,
      at: toIso(l.triggered_at),
    })),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

const zTrigger = z.union([
  z.object({ type: z.literal("goal").optional(), goalName: zGoalName }).strict(),
  z.object({ type: z.literal("new_sale") }).strict(),
  z
    .object({
      type: z.literal("traffic_spike"),
      multiplier: z.number().min(1.5).max(100).optional(),
    })
    .strict(),
  z.object({ type: z.literal("weekly_digest") }).strict(),
]);

const zDestination = z.discriminatedUnion("type", [
  z.object({ type: z.literal("email"), email: zEmail.optional() }).strict(),
  z
    .object({
      type: z.literal("telegram"),
      chatId: z.string().trim().min(1).max(64),
      botToken: z
        .string()
        .trim()
        .regex(/^\d{3,20}:[A-Za-z0-9_-]{20,100}$/, "must be a Telegram bot token")
        .optional(),
    })
    .strict(),
]);

const zTemplate = z
  .object({
    message: z.string().trim().min(10).max(2000),
    subject: z.string().trim().max(200).optional(),
  })
  .strict();

const CreateBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    trigger: zTrigger,
    template: zTemplate,
    destination: zDestination.optional(),
    isEnabled: z.boolean().optional(),
  })
  .strict();

const UpdateBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    trigger: zTrigger.optional(),
    template: z
      .object({
        message: z.string().trim().min(10).max(2000).optional(),
        subject: z.string().trim().max(200).nullable().optional(),
      })
      .strict()
      .optional(),
    destination: zDestination.optional(),
    isEnabled: z.boolean().optional(),
  })
  .strict();

type Trigger = z.output<typeof zTrigger>;
type Destination = z.output<typeof zDestination>;

function triggerColumns(t: Trigger): { type: AlertRow["trigger_type"]; json: string } {
  if ("goalName" in t) return { type: "goal", json: JSON.stringify({ goalName: t.goalName }) };
  if (t.type === "traffic_spike") {
    return { type: t.type, json: JSON.stringify({ multiplier: t.multiplier ?? 4 }) };
  }
  return { type: t.type as AlertRow["trigger_type"], json: "{}" };
}

function destinationJson(d: Destination): string {
  if (d.type === "email") return JSON.stringify(d.email ? { email: d.email } : {});
  return JSON.stringify({ chatId: d.chatId });
}

async function recentLogs(db: D1Database, siteId: string, alertIds: string[]) {
  const out = new Map<string, HistoryRow[]>(alertIds.map((id) => [id, []]));
  if (!alertIds.length) return out;
  const rows = await db
    .prepare(
      `SELECT * FROM (SELECT h.*, ROW_NUMBER() OVER (PARTITION BY alert_id ORDER BY triggered_at DESC) AS rn
         FROM alert_history h WHERE site_id = ? AND triggered_at >= ?) WHERE rn <= 5 ORDER BY triggered_at DESC`,
    )
    .bind(siteId, Date.now() - 90 * 86_400_000)
    .all<HistoryRow>();
  for (const r of rows.results ?? []) out.get(r.alert_id)?.push(r);
  return out;
}

async function loadAlert(db: D1Database, siteId: string, alertId: string): Promise<AlertRow> {
  if (!isObjectIdLike(alertId)) throw new ApiError(400, "Invalid alertId");
  const row = await db
    .prepare("SELECT * FROM alerts WHERE id = ? AND site_id = ?")
    .bind(alertId, siteId)
    .first<AlertRow>();
  if (!row) throw new ApiError(404, "Alert not found");
  return row;
}

alertRoutes.get(
  `${W}/alerts/history`,
  requireSiteAccess("alerts:read", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const alertId = c.req.query("alertId");
    if (alertId !== undefined && !isObjectIdLike(alertId))
      throw new ApiError(400, "Invalid alertId");
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError(400, "limit must be an integer between 1 and 100");
    }
    const where = alertId ? "site_id = ?1 AND alert_id = ?2" : "site_id = ?1 AND ?2 IS NULL";
    const [rows, counts] = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT * FROM alert_history WHERE ${where} ORDER BY triggered_at DESC, id DESC LIMIT ?3`,
      ).bind(site.id, alertId ?? null, limit),
      c.env.DB.prepare(
        `SELECT COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS sent,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed, COUNT(*) AS total
       FROM alert_history WHERE ${where}`,
      ).bind(site.id, alertId ?? null),
    ]);
    const ct = (counts?.results?.[0] ?? {}) as { sent?: number; failed?: number; total?: number };
    return success(
      c,
      ((rows?.results ?? []) as unknown as HistoryRow[]).map((r) => ({
        alertId: r.alert_id,
        alertName: r.alert_name,
        goalName: r.goal_name,
        status: r.status,
        error: r.error,
        visitorId: r.visitor_id,
        triggeredAt: toIso(r.triggered_at),
      })),
      {
        extra: {
          counts: {
            sent: Number(ct.sent ?? 0),
            failed: Number(ct.failed ?? 0),
            total: Number(ct.total ?? 0),
          },
        },
      },
    );
  },
);

alertRoutes.get(
  `${W}/alerts`,
  requireSiteAccess("alerts:read", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const rows =
      (
        await c.env.DB.prepare("SELECT * FROM alerts WHERE site_id = ? ORDER BY created_at, id")
          .bind(site.id)
          .all<AlertRow>()
      ).results ?? [];
    const logs = await recentLogs(
      c.env.DB,
      site.id,
      rows.map((r) => r.id),
    );
    return success(
      c,
      rows.map((r) => alertDto(r, logs.get(r.id) ?? [])),
    );
  },
);

alertRoutes.post(
  `${W}/alerts`,
  requireSiteAccess("alerts:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const body = await parseJsonBody(c, CreateBody, { maxBytes: 16_384 });
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE site_id = ?")
      .bind(site.id)
      .first<number>("n");
    if ((count ?? 0) >= MAX_ALERTS) {
      throw new ApiError(400, `Alert limit reached (max ${MAX_ALERTS} per website)`);
    }
    const destination: Destination = body.destination ?? { type: "email" };
    if (destination.type === "telegram" && !destination.botToken) {
      throw new ApiError(400, "destination.botToken is required for Telegram alerts");
    }
    const now = Date.now();
    const id = newId(now);
    const trigger = triggerColumns(body.trigger);
    const secret =
      destination.type === "telegram" && destination.botToken
        ? await encryptString(
            c.env.ENCRYPTION_KEY,
            destination.botToken,
            alertSecretAad(site.id, id),
          )
        : null;
    const row = await c.env.DB.prepare(
      `INSERT INTO alerts (id, site_id, name, trigger_type, trigger, channel, destination, secret_enc,
       template_subject, template_message, is_enabled, monthly_count_reset_at, daily_count_reset_at,
       created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
      .bind(
        id,
        site.id,
        body.name,
        trigger.type,
        trigger.json,
        destination.type,
        destinationJson(destination),
        secret,
        body.template.subject || null,
        body.template.message,
        body.isEnabled === false ? 0 : 1,
        startOfUtcMonth(now),
        startOfUtcDay(now),
        getAuth(c).user.id,
        now,
        now,
      )
      .first<AlertRow>();
    if (!row) throw new ApiError(500, "Could not create the alert");
    return success(c, [alertDto(row, [])]);
  },
);

alertRoutes.put(
  `${W}/alerts/:alertId`,
  requireSiteAccess("alerts:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const row = await loadAlert(c.env.DB, site.id, c.req.param("alertId"));
    const body = await parseJsonBody(c, UpdateBody, { maxBytes: 16_384 });
    const trigger = body.trigger
      ? triggerColumns(body.trigger)
      : { type: row.trigger_type, json: row.trigger };
    let channel = row.channel;
    let destination = row.destination;
    let secret = row.secret_enc;
    if (body.destination) {
      channel = body.destination.type;
      destination = destinationJson(body.destination);
      if (body.destination.type === "telegram") {
        if (body.destination.botToken) {
          secret = await encryptString(
            c.env.ENCRYPTION_KEY,
            body.destination.botToken,
            alertSecretAad(site.id, row.id),
          );
        } else if (row.channel !== "telegram" || !row.secret_enc) {
          throw new ApiError(400, "destination.botToken is required for Telegram alerts");
        }
      } else {
        secret = null;
      }
    }
    const subject =
      body.template?.subject !== undefined ? body.template.subject || null : row.template_subject;
    const updated = await c.env.DB.prepare(
      `UPDATE alerts SET name = ?, trigger_type = ?, trigger = ?, channel = ?, destination = ?, secret_enc = ?,
       template_subject = ?, template_message = ?, is_enabled = ?, updated_at = ? WHERE id = ? RETURNING *`,
    )
      .bind(
        body.name ?? row.name,
        trigger.type,
        trigger.json,
        channel,
        destination,
        secret,
        subject,
        body.template?.message ?? row.template_message,
        body.isEnabled === undefined ? row.is_enabled : body.isEnabled ? 1 : 0,
        Date.now(),
        row.id,
      )
      .first<AlertRow>();
    if (!updated) throw new ApiError(404, "Alert not found");
    const logs = await recentLogs(c.env.DB, site.id, [row.id]);
    return success(c, [alertDto(updated, logs.get(row.id) ?? [])]);
  },
);

alertRoutes.delete(
  `${W}/alerts/:alertId`,
  requireSiteAccess("alerts:write", { param: "websiteId" }),
  async (c) => {
    const { site } = getAccess(c);
    const row = await loadAlert(c.env.DB, site.id, c.req.param("alertId"));
    await c.env.DB.prepare("DELETE FROM alerts WHERE id = ?").bind(row.id).run();
    return success(c, [{ message: "Alert deleted successfully" }]);
  },
);
