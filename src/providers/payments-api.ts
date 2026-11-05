/**
 * DataFast's Payments API (`POST|DELETE /api/v1/payments`) plus DataGoat's payments list
 * (`GET /api/v1/payments`).
 *
 * POST (docs: api/website/payments/create): a plain JSON body, no envelope. `transaction_id` is
 * idempotent: a repeat answers 200 with a duplicate message and no `transaction_id` (DataFast's
 * "existing payment event" branch). Validation errors answer 400 with a plain `{error}` body.
 *
 *   amount 0 or is_free_trial → free trial; renewal → renewal; refunded → a refund row
 *   (`<transaction_id>:refund`, negative, against the original payment's visitor when it exists).
 *   Attribution: datafast_visitor_id / visitorId (`api`), then the customer map (`customer_id`),
 *   then the customer email (`email`). A visitor id with no pageviews on this website is stored
 *   unattributed (DataFast's "missing first visitor event" branch, also message-only).
 *
 * DELETE (docs: api/website/payments/delete): by transaction id first, then visitor (+ optional
 * range), then a bulk range (required). Deletes the payment goals emitted for those payments.
 */
import { Hono } from "hono";
import { z } from "zod";
import { getAccess } from "../auth/context";
import { requireSiteAccess } from "../auth/middleware";
import { ApiError } from "../lib/errors";
import { compileFilters, parseFilters } from "../lib/filters";
import { attributionColumn } from "../lib/metrics";
import { toMajor, toMinor } from "../lib/money";
import { paginationOf, success } from "../lib/response";
import { prepare, raw, type SqlFragment, sql } from "../lib/sql";
import { parseRange, toIso } from "../lib/time";
import { parsePagination, readBodyText } from "../lib/validate";
import type { AppEnv } from "../types";
import { cleanId, currencyOf, normaliseEmail } from "./attribution";
import { ingestBatch } from "./engine";
import type { NormalizedPayment } from "./types";

export const paymentsRoutes = new Hono<AppEnv>();

const MAX_TXN = 255;

function plainError(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function plain(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const boolish = z
  .union([z.boolean(), z.enum(["true", "false"]), z.literal(1), z.literal(0)])
  .transform((v) => v === true || v === "true" || v === 1);

const CreateBody = z.object({
  amount: z.union([
    z.number(),
    z
      .string()
      .regex(/^-?\d+(\.\d+)?$/)
      .transform(Number),
  ]),
  currency: z.string(),
  transaction_id: z.union([z.string(), z.number().transform(String)]),
  datafast_visitor_id: z.string().nullish(),
  /** DataGoat's name for the same field; either is accepted. */
  datagoat_visitor_id: z.string().nullish(),
  visitorId: z.string().nullish(),
  email: z.string().nullish(),
  customer_email: z.string().nullish(),
  name: z.string().nullish(),
  customer_name: z.string().nullish(),
  customer_id: z.union([z.string(), z.number().transform(String)]).nullish(),
  renewal: boolish.optional(),
  refunded: boolish.optional(),
  is_free_trial: boolish.optional(),
  timestamp: z.string().nullish(),
});

paymentsRoutes.post("/api/v1/payments", requireSiteAccess("payments:write"), async (c) => {
  const { site } = getAccess(c);
  const text = await readBodyText(c, 16 * 1024);
  let json: unknown;
  try {
    json = text.trim() ? JSON.parse(text) : {};
  } catch {
    return plainError("Invalid JSON body");
  }
  const record = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  for (const field of ["amount", "currency", "transaction_id"]) {
    if (record[field] === undefined || record[field] === null || record[field] === "")
      return plainError(`Missing required field: ${field}`);
  }
  const parsed = CreateBody.safeParse(record);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return plainError(
      `Invalid ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
    );
  }
  const body = parsed.data;
  if (!Number.isFinite(body.amount) || body.amount < 0)
    return plainError("Invalid amount: must be a number greater than or equal to 0");
  const currency = currencyOf(body.currency);
  if (!currency) return plainError("Invalid currency: use a 3-letter ISO 4217 code such as USD");
  const txn = body.transaction_id.trim();
  if (!txn || txn.length > MAX_TXN)
    return plainError(`Invalid transaction_id: 1-${MAX_TXN} characters`);
  const rawVisitor =
    body.datagoat_visitor_id ?? body.datafast_visitor_id ?? body.visitorId ?? undefined;
  const visitorId = rawVisitor ? cleanId(rawVisitor) : undefined;
  if (rawVisitor && !visitorId) return plainError("Invalid datafast_visitor_id");
  const rawEmail = body.email ?? body.customer_email ?? undefined;
  const email = rawEmail ? normaliseEmail(rawEmail) : null;
  if (rawEmail && !email) return plainError("Invalid email");
  let occurredAt = Date.now();
  if (body.timestamp) {
    const t = Date.parse(body.timestamp);
    if (!Number.isFinite(t)) return plainError("Invalid timestamp: use ISO 8601");
    if (t > Date.now() + 86_400_000) return plainError("Invalid timestamp: in the future");
    occurredAt = t;
  }
  if (body.refunded && (body.renewal || body.is_free_trial))
    return plainError(
      "Invalid field combination: refunded cannot be combined with renewal or is_free_trial",
    );
  const freeTrial = !body.refunded && (body.is_free_trial === true || body.amount === 0);
  const amountMinor = toMinor(body.amount, currency);

  const payment: NormalizedPayment = body.refunded
    ? {
        providerTxnId: `${txn}:refund`,
        kind: "refund",
        amountMinor: -amountMinor,
        currency,
        occurredAt,
        refundOf: [txn],
        visitorId,
        visitorVia: "api",
        providerCustomerId: body.customer_id ?? undefined,
        email: email ?? undefined,
        name: body.name ?? body.customer_name ?? undefined,
      }
    : {
        providerTxnId: txn,
        kind: freeTrial ? "free_trial" : body.renewal ? "renewal" : "payment",
        amountMinor: freeTrial ? 0 : amountMinor,
        currency,
        occurredAt,
        visitorId,
        visitorVia: "api",
        providerCustomerId: body.customer_id ?? undefined,
        email: email ?? undefined,
        name: body.name ?? body.customer_name ?? undefined,
      };
  const result = await ingestBatch(
    c.env.DB,
    { payments: [payment], subscriptions: [], customers: [] },
    { site, provider: "api", source: "api", now: Date.now() },
  );
  const outcome = result.payments[0];
  if (!outcome || outcome.status === "duplicate" || outcome.status === "updated") {
    return plain({
      message: body.refunded
        ? "Refund already recorded for this transaction_id"
        : "Payment already recorded for this transaction_id (duplicate ignored)",
    });
  }
  if (outcome.unknownVisitor && outcome.attributedVia === "none") {
    return plain({
      message:
        "Payment recorded, but no pageview was found for this visitor, so it is unattributed",
    });
  }
  const attributed = outcome.visitorId !== null;
  const noun = body.refunded ? "Refund" : freeTrial ? "Free trial" : "Payment";
  return plain({
    message: attributed
      ? `${noun} recorded and attributed successfully`
      : `${noun} recorded successfully`,
    transaction_id: txn,
  });
});

// ---------------------------------------------------------------------------------------------
// DELETE /api/v1/payments
// ---------------------------------------------------------------------------------------------

function rangeOf(q: Record<string, string>, timezone: string) {
  const hasCanonical = q.startAt !== undefined || q.endAt !== undefined;
  const hasLegacy = q.start !== undefined || q.end !== undefined;
  if (hasCanonical && hasLegacy && (q.startAt !== q.start || q.endAt !== q.end)) {
    throw new ApiError(
      400,
      "Conflicting date ranges: use startAt/endAt (start/end are deprecated)",
    );
  }
  const startAt = q.startAt ?? q.start;
  const endAt = q.endAt ?? q.end;
  if (!startAt && !endAt) return null;
  if (!startAt || !endAt) throw new ApiError(400, "startAt and endAt must be provided together");
  return parseRange({ startAt, endAt, timezone: q.timezone }, timezone);
}

paymentsRoutes.delete("/api/v1/payments", requireSiteAccess("payments:write"), async (c) => {
  const { site } = getAccess(c);
  const q = Object.fromEntries(new URL(c.req.url).searchParams) as Record<string, string>;
  const db = c.env.DB;
  const txn = (q.transaction_id ?? q.tx_id)?.trim();

  const deleteWhere = async (where: SqlFragment) => {
    const res = await db.batch([
      prepare(
        db,
        sql`DELETE FROM events WHERE site_id = ${site.id} AND type = 'custom'
          AND ts IN (SELECT occurred_at FROM payments p WHERE ${where})
          AND json_extract(props, '$.origin') = 'payment_provider'
          AND json_extract(props, '$.transaction_id') IN (SELECT provider_txn_id FROM payments p WHERE ${where})`,
      ),
      prepare(
        db,
        sql`DELETE FROM payments WHERE site_id = ${site.id} AND id IN (SELECT p.id FROM payments p WHERE ${where})`,
      ),
    ]);
    return res[1]?.meta.changes ?? 0;
  };

  if (txn) {
    const where = sql`p.site_id = ${site.id} AND (p.provider_txn_id = ${txn} OR p.refund_of = ${txn} OR p.provider_txn_id = ${`${txn}:refund`})`;
    const n = await deleteWhere(where);
    if (!n) throw new ApiError(404, "Transaction not found");
    return success(c, [{ message: "Payment deleted successfully", transaction_id: txn }]);
  }
  const visitorRaw = q.datagoat_visitor_id ?? q.datafast_visitor_id ?? q.visitorId;
  const range = rangeOf(q, site.timezone);
  if (visitorRaw !== undefined) {
    const visitor = cleanId(visitorRaw);
    if (!visitor) throw new ApiError(400, "Invalid datafast_visitor_id");
    const where = range
      ? sql`p.site_id = ${site.id} AND p.visitor_id = ${visitor} AND p.occurred_at >= ${range.startMs} AND p.occurred_at < ${range.endMs}`
      : sql`p.site_id = ${site.id} AND p.visitor_id = ${visitor}`;
    const n = await deleteWhere(where);
    return success(c, [
      {
        message: `${n} payment${n === 1 ? "" : "s"} deleted successfully`,
        datafast_visitor_id: visitor,
        ...(range
          ? { timeRange: { start: toIso(range.startMs), end: toIso(range.endMs - 1) } }
          : {}),
      },
    ]);
  }
  if (!range)
    throw new ApiError(
      400,
      "Provide transaction_id, datafast_visitor_id, or startAt and endAt for a bulk delete",
    );
  const n = await deleteWhere(
    sql`p.site_id = ${site.id} AND p.occurred_at >= ${range.startMs} AND p.occurred_at < ${range.endMs}`,
  );
  return success(c, [
    {
      message: `${n} payment${n === 1 ? "" : "s"} deleted successfully`,
      timeRange: { start: toIso(range.startMs), end: toIso(range.endMs - 1) },
    },
  ]);
});

// ---------------------------------------------------------------------------------------------
// GET /api/v1/payments (DataGoat): the payments list behind the revenue page
// ---------------------------------------------------------------------------------------------

const KINDS = new Set(["payment", "renewal", "refund", "free_trial"]);

paymentsRoutes.get("/api/v1/payments", requireSiteAccess("payments:read"), async (c) => {
  const { site, auth } = getAccess(c);
  const url = new URL(c.req.url);
  const q = Object.fromEntries(url.searchParams) as Record<string, string>;
  const { limit, offset } = parsePagination(q, { max: 1000 });
  const range = parseRange(q, site.timezone);
  const filters = parseFilters(url.searchParams);
  const col = attributionColumn(site.attributionModel);
  const parts: SqlFragment[] = [sql`p.site_id = ${site.id}`];
  if (range) parts.push(sql`p.occurred_at >= ${range.startMs} AND p.occurred_at < ${range.endMs}`);
  if (q.attributed !== undefined) {
    if (!["true", "false"].includes(q.attributed))
      throw new ApiError(400, "attributed must be true or false");
    parts.push(q.attributed === "true" ? sql`p.visitor_id IS NOT NULL` : sql`p.visitor_id IS NULL`);
  }
  if (q.kind !== undefined) {
    const kinds = q.kind.split(",").map((k) => k.trim());
    if (!kinds.every((k) => KINDS.has(k)))
      throw new ApiError(400, "kind must be payment, renewal, refund or free_trial");
    parts.push(sql`p.kind IN (${raw(kinds.map((k) => `'${k}'`).join(", "))})`);
  }
  if (q.provider !== undefined) parts.push(sql`p.provider = ${q.provider}`);
  const join = filters.length
    ? sql`JOIN sessions s ON s.site_id = p.site_id AND s.id = p.${raw(col)}`
    : sql`LEFT JOIN sessions s ON s.site_id = p.site_id AND s.id = p.${raw(col)}`;
  if (filters.length) {
    parts.push(compileFilters(filters, { siteId: site.id, range, sessionAlias: "s" }));
  }
  const where = parts.reduce((acc, f, i) => (i === 0 ? f : sql`${acc} AND ${f}`));
  const db = c.env.DB;
  const [rows, count] = await db.batch([
    prepare(
      db,
      sql`SELECT p.id, p.provider, p.provider_txn_id, p.kind, p.amount_minor, p.currency, p.reporting_minor,
          p.reporting_currency, p.visitor_id, p.attributed_via, p.customer_email, p.customer_name, p.occurred_at,
          s.channel
        FROM payments p ${join} WHERE ${where}
        ORDER BY p.occurred_at DESC, p.id DESC LIMIT ${limit} OFFSET ${offset}`,
    ),
    prepare(db, sql`SELECT COUNT(*) AS n FROM payments p ${join} WHERE ${where}`),
  ]);
  const total = Number((count?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  const data = ((rows?.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    provider: String(r.provider),
    transactionId: String(r.provider_txn_id),
    kind: r.kind,
    amount: toMajor(Number(r.reporting_minor), String(r.reporting_currency)),
    currency: String(r.reporting_currency),
    originalAmount: toMajor(Number(r.amount_minor), String(r.currency)),
    originalCurrency: String(r.currency),
    visitorId: (r.visitor_id as string | null) ?? null,
    attributedVia: r.attributed_via,
    channel: (r.channel as string | null) ?? null,
    customerEmail: auth.includePii ? ((r.customer_email as string | null) ?? null) : null,
    customerName: auth.includePii ? ((r.customer_name as string | null) ?? null) : null,
    timestamp: toIso(Number(r.occurred_at)),
  }));
  return success(c, data, { pagination: paginationOf(limit, offset, total) });
});
