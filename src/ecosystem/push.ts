/**
 * `ecosystem.push`: sale and alert push notifications for the mobile app, through the Expo push
 * service (https://exp.host/--/api/v2/push/send). Runs every minute.
 *
 * Free-plan cost:
 * - Idle (no registered devices): one D1 query, no writes.
 * - With devices: one batch for devices + new payments + new alert history, bounded by indexes
 *   (`payments_time` on (site_id, occurred_at), alert_history's rowid), plus one Expo subrequest per
 *   100 messages. job_state is written only when a cursor moves, i.e. when something was sent.
 * - Only fresh sales are pushed: payments created after the cursor that occurred in the last two
 *   hours and did not come from a backfill or an import.
 *
 * Expo answers per message; devices whose token Expo reports as `DeviceNotRegistered` are deleted.
 * Push receipts are not polled (Expo's ticket answer covers the common failures).
 */
import type { JobContext, JobDefinition } from "../jobs/registry";
import { parseJsonColumn } from "../lib/d1";
import { log } from "../lib/log";
import { toMajor } from "../lib/money";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const FRESH_WINDOW_MS = 2 * 3_600_000;
const MAX_MESSAGES_PER_RUN = 500;
const EXPO_BATCH = 100;

export interface PushState {
  /** payments.created_at of the newest payment already considered. */
  paymentsAt: number;
  /** alert_history.id of the newest alert already considered. */
  alertId: number;
}

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  sound: "default";
  priority: "high";
  channelId: string;
  data: Record<string, string>;
}

interface DeviceSiteRow {
  device_id: string;
  push_token: string;
  notify_sales: number;
  notify_alerts: number;
  muted_site_ids: string;
  site_id: string;
}

interface PaymentRow {
  site_id: string;
  id: string;
  kind: string;
  reporting_minor: number;
  reporting_currency: string;
  created_at: number;
  domain: string;
  name: string | null;
}

interface AlertRow {
  id: number;
  site_id: string;
  alert_name: string;
  goal_name: string | null;
  domain: string;
}

export function formatMoney(minor: number, currency: string): string {
  const major = toMajor(minor, currency);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(major);
  } catch {
    return `${major} ${currency}`;
  }
}

export function saleMessage(to: string, p: PaymentRow): PushMessage {
  const label = p.kind === "renewal" ? "Renewal" : "New sale";
  return {
    to,
    title: p.name || p.domain,
    body: `${label}: ${formatMoney(p.reporting_minor, p.reporting_currency)}`,
    sound: "default",
    priority: "high",
    channelId: "sales",
    data: { type: "sale", websiteId: p.site_id, paymentId: p.id },
  };
}

export function alertMessage(to: string, a: AlertRow): PushMessage {
  return {
    to,
    title: a.alert_name,
    body: a.goal_name ? `Goal "${a.goal_name}" completed on ${a.domain}` : `Alert on ${a.domain}`,
    sound: "default",
    priority: "high",
    channelId: "alerts",
    data: { type: "alert", websiteId: a.site_id, alertHistoryId: String(a.id) },
  };
}

function isState(value: unknown): value is PushState {
  const v = value as PushState | null;
  return !!v && typeof v.paymentsAt === "number" && typeof v.alertId === "number";
}

const LIVE_DEVICES_SQL = `
  SELECT d.id AS device_id, d.push_token, d.notify_sales, d.notify_alerts, d.muted_site_ids,
         m.site_id
    FROM mobile_devices d
    JOIN api_keys k ON k.id = d.token_id AND k.revoked_at IS NULL
                   AND (k.expires_at IS NULL OR k.expires_at > ?1)
    JOIN memberships m ON m.user_id = d.user_id
    JOIN sites s ON s.id = m.site_id AND s.deleted_at IS NULL`;

export async function runPush(ctx: JobContext): Promise<void> {
  const db = ctx.db;
  const now = ctx.now;
  if (!isState(ctx.state)) {
    // First run: start from now, never replay history.
    const max = await db
      .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM alert_history")
      .first<{ id: number }>();
    ctx.setState({ paymentsAt: now, alertId: max?.id ?? 0 } satisfies PushState);
    return;
  }
  const state = ctx.state;
  const devices = await db.prepare(LIVE_DEVICES_SQL).bind(now).all<DeviceSiteRow>();
  const rows = devices.results ?? [];
  if (rows.length === 0) return;

  const siteIds = [...new Set(rows.map((r) => r.site_id))];
  const sitesJson = JSON.stringify(siteIds);
  const [payRes, alertRes] = await db.batch([
    db
      .prepare(
        `SELECT p.site_id, p.id, p.kind, p.reporting_minor, p.reporting_currency, p.created_at,
                s.domain, s.name
           FROM payments p JOIN sites s ON s.id = p.site_id
          WHERE p.site_id IN (SELECT value FROM json_each(?1))
            AND p.occurred_at > ?2 AND p.created_at > ?3
            AND p.kind IN ('payment', 'renewal') AND p.reporting_minor > 0
            AND p.source NOT IN ('backfill', 'import')
          ORDER BY p.created_at ASC LIMIT 200`,
      )
      .bind(sitesJson, now - FRESH_WINDOW_MS, state.paymentsAt),
    db
      .prepare(
        `SELECT h.id, h.site_id, h.alert_name, h.goal_name, s.domain
           FROM alert_history h JOIN sites s ON s.id = h.site_id
          WHERE h.id > ?1 AND h.status = 'sent'
            AND h.site_id IN (SELECT value FROM json_each(?2))
          ORDER BY h.id ASC LIMIT 200`,
      )
      .bind(state.alertId, sitesJson),
  ]);
  const payments = (payRes?.results ?? []) as unknown as PaymentRow[];
  const alerts = (alertRes?.results ?? []) as unknown as AlertRow[];
  if (payments.length === 0 && alerts.length === 0) return;

  const bySite = new Map<string, DeviceSiteRow[]>();
  for (const r of rows) {
    if (parseJsonColumn<string[]>(r.muted_site_ids, []).includes(r.site_id)) continue;
    const list = bySite.get(r.site_id) ?? [];
    list.push(r);
    bySite.set(r.site_id, list);
  }
  const messages: Array<{ deviceId: string; message: PushMessage }> = [];
  for (const p of payments) {
    for (const d of bySite.get(p.site_id) ?? []) {
      if (d.notify_sales === 1)
        messages.push({ deviceId: d.device_id, message: saleMessage(d.push_token, p) });
    }
  }
  for (const a of alerts) {
    for (const d of bySite.get(a.site_id) ?? []) {
      if (d.notify_alerts === 1)
        messages.push({ deviceId: d.device_id, message: alertMessage(d.push_token, a) });
    }
  }

  const toSend = messages.slice(0, MAX_MESSAGES_PER_RUN);
  const gone = new Set<string>();
  const token = ctx.env.EXPO_ACCESS_TOKEN;
  for (let i = 0; i < toSend.length; i += EXPO_BATCH) {
    const chunk = toSend.slice(i, i + EXPO_BATCH);
    const res = await ctx.fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(chunk.map((m) => m.message)),
    });
    if (!res.ok) {
      // Leave the cursors where they are so the next run retries this batch.
      throw new Error(`Expo push failed with HTTP ${res.status}`);
    }
    const body = (await res.json().catch(() => null)) as {
      data?: Array<{ status: string; details?: { error?: string } }>;
    } | null;
    (body?.data ?? []).forEach((ticket, j) => {
      const item = chunk[j];
      if (item && ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
        gone.add(item.deviceId);
      }
    });
  }
  if (gone.size) {
    await db
      .prepare("DELETE FROM mobile_devices WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify([...gone]))
      .run();
  }
  if (messages.length > toSend.length) {
    log.warn("ecosystem.push.truncated", { messages: messages.length, sent: toSend.length });
  }
  const lastPayment = payments.at(-1);
  const lastAlert = alerts.at(-1);
  ctx.setState({
    paymentsAt: lastPayment ? lastPayment.created_at : state.paymentsAt,
    alertId: lastAlert ? lastAlert.id : state.alertId,
  } satisfies PushState);
}

export const pushJob: JobDefinition = {
  name: "ecosystem.push",
  schedule: { every: "minute" },
  description: "Sale and alert push notifications to the mobile app (Expo push service)",
  minQueries: 3,
  run: runPush,
};
