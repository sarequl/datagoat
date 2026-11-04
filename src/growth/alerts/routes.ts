/**
 * Alert rule CRUD and history (DataFast: /api/v1/admin/websites/:id/alerts…) plus DataGoat's
 * test send and channel discovery.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AlertChannels, AlertHistoryEntry } from "../../../shared/api-types";
import { getAccess } from "../../auth/context";
import { requireSiteAccess } from "../../auth/middleware";
import { decryptString } from "../../lib/crypto";
import { ApiError } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { success } from "../../lib/response";
import { toIso } from "../../lib/time";
import { parseJsonBody, parseQuery } from "../../lib/validate";
import type { AppEnv } from "../../types";
import { emailConfigured, emailProvider } from "../delivery/email";
import { deliverPayload } from "../delivery/outbox";
import { TEMPLATE_VARIABLES } from "../delivery/templates";
import { errorMessage } from "../shared/http";
import { ownerEmails, publicUrl } from "../shared/site-info";
import {
  type AlertRow,
  alertDto,
  CreateAlertBody,
  destinationOf,
  MAX_ALERTS_PER_SITE,
  type RecentLog,
  resolveDestination,
  resolveTrigger,
  triggerOf,
  UpdateAlertBody,
} from "./model";
import { alertLimit, buildPayload, sampleVars } from "./notify";

export const alertRoutes = new Hono<AppEnv>();

const W = "/api/v1/admin/websites/:websiteId";
const P = { param: "websiteId" } as const;

async function recentLogs(db: D1Database, siteId: string): Promise<Map<string, RecentLog[]>> {
  const res = await db
    .prepare(
      `SELECT alert_id, status, error, visitor_id, triggered_at FROM alert_history
       WHERE site_id = ? ORDER BY triggered_at DESC LIMIT 250`,
    )
    .bind(siteId)
    .all<RecentLog>();
  const map = new Map<string, RecentLog[]>();
  for (const row of res.results ?? []) {
    const list = map.get(row.alert_id) ?? [];
    if (list.length < 5) list.push(row);
    map.set(row.alert_id, list);
  }
  return map;
}

async function loadAlert(db: D1Database, siteId: string, alertId: string): Promise<AlertRow> {
  const row = await db
    .prepare("SELECT * FROM alerts WHERE id = ? AND site_id = ?")
    .bind(alertId, siteId)
    .first<AlertRow>();
  if (!row) throw new ApiError(404, "Alert not found");
  return row;
}

function assertEmailUsable(env: Cloudflare.Env, channel: string) {
  if (channel === "email" && !emailConfigured(env)) {
    throw new ApiError(
      400,
      "Email delivery is not configured on this server: set EMAIL_FROM and RESEND_API_KEY or POSTMARK_SERVER_TOKEN, or use a Telegram or webhook destination",
    );
  }
}

alertRoutes.get(`${W}/alerts`, requireSiteAccess("alerts:read", P), async (c) => {
  const { site } = getAccess(c);
  const [rows, logs] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM alerts WHERE site_id = ? ORDER BY created_at")
      .bind(site.id)
      .all<AlertRow>(),
    recentLogs(c.env.DB, site.id),
  ]);
  const now = Date.now();
  return success(
    c,
    (rows.results ?? []).map((r) => alertDto(r, logs.get(r.id) ?? [], now)),
  );
});

alertRoutes.post(`${W}/alerts`, requireSiteAccess("alerts:write", P), async (c) => {
  const { site, user } = getAccess(c);
  const body = await parseJsonBody(c, CreateAlertBody, { maxBytes: 16 * 1024 });
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE site_id = ?")
    .bind(site.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ALERTS_PER_SITE) {
    throw new ApiError(400, `Alert limit reached (max ${MAX_ALERTS_PER_SITE} per website)`);
  }
  const trigger = resolveTrigger(body.trigger);
  if (trigger.type === "goal" && !body.template?.message) {
    throw new ApiError(400, "template.message: must be 10-2000 characters");
  }
  const id = newId();
  const dest = await resolveDestination(c.env, site.id, id, body.destination);
  assertEmailUsable(c.env, dest.channel);
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO alerts (id, site_id, name, trigger_type, "trigger", channel, destination, secret_enc,
       template_subject, template_message, is_enabled, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      site.id,
      body.name,
      trigger.type,
      JSON.stringify(trigger.config),
      dest.channel,
      JSON.stringify(dest.config),
      dest.secretEnc ?? null,
      body.template?.subject || null,
      body.template?.message ?? null,
      body.isEnabled === false ? 0 : 1,
      user.id,
      now,
      now,
    )
    .run();
  const row = await loadAlert(c.env.DB, site.id, id);
  return success(c, [alertDto(row, [], now, { signingSecret: dest.signingSecret })]);
});

const HistoryQuery = z.object({
  websiteId: z.string().optional(),
  alertId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

alertRoutes.get(`${W}/alerts/history`, requireSiteAccess("alerts:read", P), async (c) => {
  const { site } = getAccess(c);
  const q = parseQuery(c, HistoryQuery);
  const where = q.alertId ? "site_id = ?1 AND alert_id = ?2" : "site_id = ?1";
  const binds = q.alertId ? [site.id, q.alertId] : [site.id];
  const [rows, counts] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT * FROM alert_history WHERE ${where} ORDER BY triggered_at DESC, id DESC LIMIT ${q.limit}`,
    ).bind(...binds),
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(status = 'sent'), 0) AS sent, COALESCE(SUM(status = 'failed'), 0) AS failed, COUNT(*) AS total
       FROM alert_history WHERE ${where}`,
    ).bind(...binds),
  ]);
  const data: AlertHistoryEntry[] = ((rows?.results ?? []) as Record<string, unknown>[]).map(
    (r) => ({
      alertId: String(r.alert_id),
      alertName: String(r.alert_name),
      goalName: (r.goal_name as string | null) ?? null,
      status: r.status as "sent" | "failed",
      error: (r.error as string | null) ?? null,
      visitorId: (r.visitor_id as string | null) ?? null,
      triggeredAt: toIso(Number(r.triggered_at)),
      channel: (r.channel as AlertHistoryEntry["channel"]) ?? null,
      triggerType: (r.trigger_type as AlertHistoryEntry["triggerType"]) ?? null,
      summary: (r.summary as string | null) ?? null,
    }),
  );
  const cnt = (counts?.results?.[0] ?? { sent: 0, failed: 0, total: 0 }) as Record<string, number>;
  return success(c, data, {
    extra: {
      counts: { sent: Number(cnt.sent), failed: Number(cnt.failed), total: Number(cnt.total) },
    },
  });
});

alertRoutes.get(`${W}/alerts/channels`, requireSiteAccess("alerts:read", P), async (c) => {
  const { site } = getAccess(c);
  const data: AlertChannels = {
    email: {
      configured: emailConfigured(c.env),
      provider: emailProvider(c.env),
      defaultRecipients: await ownerEmails(c.env.DB, site.id),
    },
    telegram: { configured: true, hasDefaultBotToken: Boolean(c.env.TELEGRAM_BOT_TOKEN?.trim()) },
    webhook: { configured: true },
    dailyLimit: alertLimit(c.env),
    variables: [...TEMPLATE_VARIABLES],
  };
  return success(c, data);
});

alertRoutes.get(`${W}/alerts/:alertId`, requireSiteAccess("alerts:read", P), async (c) => {
  const { site } = getAccess(c);
  const row = await loadAlert(c.env.DB, site.id, c.req.param("alertId"));
  const logs = await recentLogs(c.env.DB, site.id);
  return success(c, [alertDto(row, logs.get(row.id) ?? [])]);
});

alertRoutes.put(`${W}/alerts/:alertId`, requireSiteAccess("alerts:write", P), async (c) => {
  const { site } = getAccess(c);
  const row = await loadAlert(c.env.DB, site.id, c.req.param("alertId"));
  const body = await parseJsonBody(c, UpdateAlertBody, { maxBytes: 16 * 1024 });
  const trigger = body.trigger
    ? resolveTrigger(body.trigger, { type: row.trigger_type, config: triggerOf(row) })
    : { type: row.trigger_type, config: triggerOf(row) };
  const dest = await resolveDestination(c.env, site.id, row.id, body.destination, {
    channel: row.channel,
    config: destinationOf(row),
    hasSecret: row.secret_enc !== null,
  });
  if (body.destination) assertEmailUsable(c.env, dest.channel);
  const message =
    body.template?.message !== undefined ? body.template.message : row.template_message;
  if (trigger.type === "goal" && !message) {
    throw new ApiError(400, "template.message: must be 10-2000 characters");
  }
  const subject =
    body.template && "subject" in body.template
      ? body.template.subject || null
      : row.template_subject;
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE alerts SET name = ?, trigger_type = ?, "trigger" = ?, channel = ?, destination = ?,
       secret_enc = CASE WHEN ? = 1 THEN secret_enc ELSE ? END, template_subject = ?, template_message = ?,
       is_enabled = ?, updated_at = ? WHERE id = ? AND site_id = ?`,
  )
    .bind(
      body.name ?? row.name,
      trigger.type,
      JSON.stringify(trigger.config),
      dest.channel,
      JSON.stringify(dest.config),
      dest.secretEnc === undefined ? 1 : 0,
      dest.secretEnc ?? null,
      subject,
      message,
      body.isEnabled === undefined ? row.is_enabled : body.isEnabled ? 1 : 0,
      now,
      row.id,
      site.id,
    )
    .run();
  const updated = await loadAlert(c.env.DB, site.id, row.id);
  const logs = await recentLogs(c.env.DB, site.id);
  return success(c, [
    alertDto(updated, logs.get(row.id) ?? [], now, { signingSecret: dest.signingSecret }),
  ]);
});

alertRoutes.delete(`${W}/alerts/:alertId`, requireSiteAccess("alerts:write", P), async (c) => {
  const { site } = getAccess(c);
  const alertId = c.req.param("alertId");
  const res = await c.env.DB.prepare("DELETE FROM alerts WHERE id = ? AND site_id = ?")
    .bind(alertId, site.id)
    .run();
  if (!res.meta.changes) throw new ApiError(404, "Alert not found");
  return success(c, [{ message: "Alert deleted successfully" }]);
});

/** DG: send a sample notification right now through the alert's destination. */
alertRoutes.post(`${W}/alerts/:alertId/test`, requireSiteAccess("alerts:write", P), async (c) => {
  const { site } = getAccess(c);
  const row = await loadAlert(c.env.DB, site.id, c.req.param("alertId"));
  const now = Date.now();
  const base = await publicUrl(c.env.DB);
  const recipients = await ownerEmails(c.env.DB, site.id);
  const payload = buildPayload(row, site, sampleVars(row, site, base), recipients, {
    test: true,
    summary: "Test notification",
    visitorId: null,
    goalName: triggerOf(row).goalName ?? null,
  });
  if (!payload) throw new ApiError(400, "This alert has no recipient");
  let secret: string | null = null;
  if (row.secret_enc) {
    secret = await decryptString(
      c.env.ENCRYPTION_KEY,
      row.secret_enc,
      `alert:${site.id}:${row.id}`,
    );
  }
  let error: string | null = null;
  try {
    await deliverPayload({ env: c.env, fetch: (i, init) => fetch(i, init), now }, payload, secret);
  } catch (err) {
    error = errorMessage(err);
  }
  await c.env.DB.prepare(
    `INSERT INTO alert_history (site_id, alert_id, alert_name, goal_name, status, error, visitor_id, triggered_at,
       channel, trigger_type, summary) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'Test notification')`,
  )
    .bind(
      site.id,
      row.id,
      row.name,
      triggerOf(row).goalName ?? null,
      error ? "failed" : "sent",
      error,
      now,
      row.channel,
      row.trigger_type,
    )
    .run();
  if (error) throw new ApiError(502, `Test alert failed: ${error}`);
  return success(c, [{ message: "Test alert sent" }]);
});
