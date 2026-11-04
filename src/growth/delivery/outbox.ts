/**
 * The outbox: every outbound notification (alert, digest, weekly report, attack-mode notice,
 * invite and password-reset email) is a row in `outbox`, delivered by the `outbox.deliver` minute
 * job with retries and exponential backoff. Any team may enqueue with `enqueueStatements()`; W6
 * delivers.
 *
 * - `dedupe_key` is UNIQUE, so evaluators can rescan overlapping windows and `INSERT OR IGNORE`
 *   the same notification any number of times: it is stored and sent once.
 * - Claiming moves `next_attempt_at` forward by a lease in the same statement that selects due
 *   rows, so overlapping cron invocations never send a row twice.
 * - Alert deliveries also write `alert_history` and bump the alert's counters, once, when the
 *   row reaches a final state (sent, or failed after the last attempt).
 *
 * Write budget: an idle outbox costs one indexed read per minute and no writes.
 */

import type { JobContext } from "../../jobs/registry";
import { decryptString } from "../../lib/crypto";
import { errorFields, log } from "../../lib/log";
import { errorMessage, type Fetcher, ProviderError } from "../shared/http";
import { sendTelegram, sendWebhook } from "./channels";
import { sendEmail } from "./email";

export interface AlertRef {
  id: string;
  name: string;
  triggerType: string;
  goalName?: string | null;
  visitorId?: string | null;
  summary: string;
}

export type OutboxPayload =
  | {
      channel: "email";
      to: string[];
      subject: string;
      text: string;
      html?: string;
      alert?: AlertRef;
    }
  | { channel: "telegram"; chatId: string; text: string; alert?: AlertRef }
  | { channel: "webhook"; url: string; body: unknown; alert?: AlertRef };

export interface OutboxItem {
  siteId: string | null;
  payload: OutboxPayload;
  dedupeKey: string;
  /** Earliest send time (default now). */
  notBefore?: number;
}

export const MAX_ATTEMPTS = 6;
/** Minutes to wait after attempt n (1-based) fails. */
const BACKOFF_MINUTES = [1, 5, 30, 120, 720];
const LEASE_MS = 5 * 60_000;
const BATCH = 10;

export function enqueueStatement(
  db: D1Database,
  item: OutboxItem,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO outbox (site_id, kind, payload, status, attempts, next_attempt_at, dedupe_key, created_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
    )
    .bind(
      item.siteId,
      item.payload.channel,
      JSON.stringify(item.payload),
      item.notBefore ?? now,
      item.dedupeKey.slice(0, 300),
      now,
    );
}

export function enqueueStatements(
  db: D1Database,
  items: readonly OutboxItem[],
  now: number,
): D1PreparedStatement[] {
  return items.map((item) => enqueueStatement(db, item, now));
}

interface ClaimedRow {
  id: number;
  site_id: string | null;
  kind: string;
  payload: string;
  attempts: number;
  dedupe_key: string | null;
}

export interface DeliveryDeps {
  env: Cloudflare.Env;
  fetch: Fetcher;
  now: number;
}

/** Send one payload. Telegram/webhook secrets are read from the alert row (`secrets`). */
export async function deliverPayload(
  deps: DeliveryDeps,
  payload: OutboxPayload,
  secret: string | null,
  dedupeKey?: string | null,
): Promise<void> {
  switch (payload.channel) {
    case "email":
      await sendEmail(deps.env, deps.fetch, {
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        idempotencyKey: dedupeKey ?? undefined,
      });
      return;
    case "telegram": {
      const token = secret ?? deps.env.TELEGRAM_BOT_TOKEN?.trim() ?? null;
      if (!token) throw new ProviderError("Telegram", 400, "Telegram: no bot token configured");
      await sendTelegram(deps.fetch, token, payload.chatId, payload.text);
      return;
    }
    case "webhook":
      await sendWebhook(deps.fetch, payload.url, secret, payload.body, deps.now);
      return;
  }
}

async function loadAlertSecrets(
  env: Cloudflare.Env,
  db: D1Database,
  rows: Array<{ payload: OutboxPayload; site: string | null }>,
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      rows
        .filter((r) => r.payload.channel !== "email" && r.payload.alert?.id)
        .map((r) => r.payload.alert?.id as string),
    ),
  ];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const res = await db
    .prepare(
      `SELECT id, site_id, secret_enc FROM alerts WHERE secret_enc IS NOT NULL AND id IN (${ids.map(() => "?").join(", ")})`,
    )
    .bind(...ids)
    .all<{ id: string; site_id: string; secret_enc: string }>();
  for (const row of res.results ?? []) {
    try {
      out.set(
        row.id,
        await decryptString(env.ENCRYPTION_KEY, row.secret_enc, `alert:${row.site_id}:${row.id}`),
      );
    } catch (err) {
      log.warn("outbox.secret_decrypt_failed", { alertId: row.id, ...errorFields(err) });
    }
  }
  return out;
}

const dayStart = (ms: number) => Math.floor(ms / 86_400_000) * 86_400_000;
const monthStart = (ms: number) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

function finalStatements(
  db: D1Database,
  row: ClaimedRow,
  payload: OutboxPayload,
  status: "sent" | "failed",
  error: string | null,
  now: number,
): D1PreparedStatement[] {
  const alert = payload.alert;
  if (!alert || !row.site_id) return [];
  const stmts = [
    db
      .prepare(
        `INSERT INTO alert_history (site_id, alert_id, alert_name, goal_name, status, error, visitor_id, triggered_at,
           channel, trigger_type, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.site_id,
        alert.id,
        alert.name,
        alert.goalName ?? null,
        status,
        error,
        alert.visitorId ?? null,
        now,
        payload.channel,
        alert.triggerType,
        alert.summary.slice(0, 300),
      ),
  ];
  if (alert.id.startsWith("test:")) return stmts;
  stmts.push(
    status === "sent"
      ? db
          .prepare(
            `UPDATE alerts SET trigger_count = trigger_count + 1,
               daily_count = CASE WHEN daily_count_reset_at = ?2 THEN daily_count + 1 ELSE 1 END,
               daily_count_reset_at = ?2,
               monthly_count = CASE WHEN monthly_count_reset_at = ?3 THEN monthly_count + 1 ELSE 1 END,
               monthly_count_reset_at = ?3, last_triggered_at = ?4
             WHERE id = ?1`,
          )
          .bind(alert.id, dayStart(now), monthStart(now), now)
      : db.prepare("UPDATE alerts SET last_error = ?2 WHERE id = ?1").bind(alert.id, error),
  );
  return stmts;
}

/** The `outbox.deliver` job body (also used by tests). Returns how many rows it settled. */
export async function deliverOutbox(ctx: Pick<JobContext, "db" | "env" | "now" | "fetch">) {
  const { db, now } = ctx;
  const claimed = await db
    .prepare(
      `UPDATE outbox SET next_attempt_at = ?1
       WHERE id IN (SELECT id FROM outbox WHERE status = 'pending' AND next_attempt_at <= ?2
                    ORDER BY next_attempt_at LIMIT ?3)
       RETURNING id, site_id, kind, payload, attempts, dedupe_key`,
    )
    .bind(now + LEASE_MS, now, BATCH)
    .all<ClaimedRow>();
  const rows = claimed.results ?? [];
  if (rows.length === 0) return { sent: 0, failed: 0, retrying: 0 };

  const parsed = rows.map((row) => {
    let payload: OutboxPayload | null = null;
    try {
      payload = JSON.parse(row.payload) as OutboxPayload;
    } catch {
      payload = null;
    }
    return { row, payload, site: row.site_id };
  });
  const secrets = await loadAlertSecrets(
    ctx.env,
    db,
    parsed.filter((p): p is typeof p & { payload: OutboxPayload } => p.payload !== null),
  );

  const results = await Promise.all(
    parsed.map(async ({ row, payload }) => {
      if (!payload) return { row, payload, error: "Malformed payload", permanent: true };
      try {
        await deliverPayload(
          { env: ctx.env, fetch: ctx.fetch, now },
          payload,
          payload.alert ? (secrets.get(payload.alert.id) ?? null) : null,
          row.dedupe_key,
        );
        return { row, payload, error: null, permanent: false };
      } catch (err) {
        return {
          row,
          payload,
          error: errorMessage(err),
          permanent: err instanceof ProviderError && err.permanent,
          retryAfter: err instanceof ProviderError ? err.retryAfter : null,
        };
      }
    }),
  );

  const writes: D1PreparedStatement[] = [];
  let sent = 0;
  let failed = 0;
  let retrying = 0;
  for (const r of results) {
    const attempts = r.row.attempts + 1;
    if (r.error === null) {
      sent += 1;
      writes.push(
        db
          .prepare(
            "UPDATE outbox SET status = 'sent', attempts = ?2, sent_at = ?3, last_error = NULL WHERE id = ?1",
          )
          .bind(r.row.id, attempts, now),
      );
      if (r.payload) writes.push(...finalStatements(db, r.row, r.payload, "sent", null, now));
    } else if (r.permanent || attempts >= MAX_ATTEMPTS) {
      failed += 1;
      writes.push(
        db
          .prepare(
            "UPDATE outbox SET status = 'failed', attempts = ?2, last_error = ?3 WHERE id = ?1",
          )
          .bind(r.row.id, attempts, r.error),
      );
      if (r.payload) writes.push(...finalStatements(db, r.row, r.payload, "failed", r.error, now));
    } else {
      retrying += 1;
      const waitMs = Math.max(
        (BACKOFF_MINUTES[attempts - 1] ?? 720) * 60_000,
        ("retryAfter" in r && r.retryAfter ? r.retryAfter : 0) * 1000,
      );
      writes.push(
        db
          .prepare(
            "UPDATE outbox SET attempts = ?2, last_error = ?3, next_attempt_at = ?4 WHERE id = ?1",
          )
          .bind(r.row.id, attempts, r.error, now + waitMs),
      );
    }
  }
  await db.batch(writes);
  if (failed) log.warn("outbox.failed", { failed });
  return { sent, failed, retrying };
}

/** Daily: drop settled outbox rows after 30 days and alert history after 180 days. */
export async function cleanupOutbox(ctx: Pick<JobContext, "db" | "now">) {
  await ctx.db.batch([
    ctx.db
      .prepare("DELETE FROM outbox WHERE status != 'pending' AND created_at < ?")
      .bind(ctx.now - 30 * 86_400_000),
    ctx.db
      .prepare("DELETE FROM alert_history WHERE triggered_at < ?")
      .bind(ctx.now - 180 * 86_400_000),
  ]);
}
