/**
 * WooCommerce orders.
 *
 * Connections are created by W8's WordPress plugin connect flow (`saveConnection` with
 * `{storeUrl}` and the webhook secret the plugin registers), or manually with
 * POST …/integrations/woocommerce `{storeUrl, webhookSecret, consumerKey?, consumerSecret?}`.
 *
 * - Webhooks (topics `order.created`, `order.updated`) at `/webhooks/woocommerce/<websiteId>` are
 *   verified with `X-WC-Webhook-Signature` (base64 HMAC-SHA256 of the raw body). WooCommerce's
 *   creation ping (`webhook_id=…`, form-encoded) is acknowledged.
 * - The visitor id is the order meta `_datagoat_visitor_id` (written by DataGoat's WordPress
 *   plugin from the visitor cookie at checkout), also `_datafast_visitor_id`/`datafast_visitor_id`.
 * - Orders count once paid (`processing`/`completed` with `date_paid`); `order.refunds` become
 *   refund rows. WooCommerce Subscriptions renewals (`_subscription_renewal` meta) are renewals.
 * - With REST API keys, paid orders are backfilled from `/wp-json/wc/v3/orders`.
 */

import { toBase64, utf8 } from "../../lib/encoding";
import { toMinor } from "../../lib/money";
import {
  asRecord,
  currencyOf,
  num,
  pairsToRecord,
  str,
  timeOf,
  visitorFromMetadata,
} from "../attribution";
import { describeError, ProviderHttpError, requestJson } from "../http";
import { verifyBodyHmacBase64 } from "../signatures";
import {
  emptyBatch,
  type NormalizedBatch,
  type ProviderAdapter,
  type ValidationResult,
} from "../types";

type Obj = Record<string, unknown>;
const PAGE = 50;
const PAID = new Set(["processing", "completed", "refunded"]);

export function normaliseStoreUrl(value: string): string | null {
  let v = value.trim();
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.hostname !== "localhost") return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function auth(conn: { credentials: Record<string, string> }): Record<string, string> | null {
  const { consumerKey, consumerSecret } = conn.credentials;
  if (!consumerKey || !consumerSecret) return null;
  return { authorization: `Basic ${toBase64(utf8(`${consumerKey}:${consumerSecret}`))}` };
}

/** WooCommerce `*_gmt` dates are ISO without a zone. */
function gmt(value: unknown): string | undefined {
  return typeof value === "string" && value ? `${value.replace(/Z$/, "")}Z` : undefined;
}

export function normalizeOrder(o: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  const status = str(o.status) ?? "";
  if (!PAID.has(status) || (!o.date_paid_gmt && !o.date_paid && status !== "refunded")) return out;
  const meta = pairsToRecord(o.meta_data, "key", "value");
  const currency = currencyOf(o.currency) ?? "USD";
  const billing = asRecord(o.billing);
  const total = toMinor(num(o.total) ?? 0, currency);
  const id = String(o.id);
  const occurredAt = timeOf(gmt(o.date_paid_gmt) ?? gmt(o.date_created_gmt), at);
  const ref = visitorFromMetadata(meta);
  const customerId = num(o.customer_id) ? String(o.customer_id) : undefined;
  const renewalOf = meta._subscription_renewal;
  const subscriptionId =
    typeof renewalOf === "string" || typeof renewalOf === "number" ? String(renewalOf) : undefined;
  if (total > 0) {
    out.payments.push({
      providerTxnId: id,
      providerCustomerId: customerId,
      kind: subscriptionId ? "renewal" : "payment",
      amountMinor: total,
      currency,
      occurredAt,
      ...ref,
      email: str(billing?.email),
      name:
        [str(billing?.first_name), str(billing?.last_name)].filter(Boolean).join(" ") || undefined,
      subscriptionId,
      hintRefs: [id, str(o.order_key)].filter((x): x is string => !!x),
    });
  }
  for (const r of Array.isArray(o.refunds) ? o.refunds : []) {
    const rr = asRecord(r);
    const amount = Math.abs(num(rr?.total) ?? 0);
    if (!rr || amount <= 0) continue;
    out.payments.push({
      providerTxnId: `refund:${String(rr.id)}`,
      providerCustomerId: customerId,
      kind: "refund",
      amountMinor: -toMinor(amount, currency),
      currency,
      occurredAt: timeOf(gmt(o.date_modified_gmt), at),
      refundOf: [id],
    });
  }
  return out;
}

export const wooCommerceAdapter: ProviderAdapter = {
  id: "woocommerce",
  displayName: "WooCommerce",
  pollEveryMinutes: 60,

  async validateCredentials(input, ctx): Promise<ValidationResult> {
    const storeUrl = typeof input.storeUrl === "string" ? normaliseStoreUrl(input.storeUrl) : null;
    if (!storeUrl) return { ok: false, error: "storeUrl must be your store's https URL" };
    const secret = typeof input.webhookSecret === "string" ? input.webhookSecret.trim() : "";
    if (!secret) return { ok: false, error: "webhookSecret is required" };
    const consumerKey = typeof input.consumerKey === "string" ? input.consumerKey.trim() : "";
    const consumerSecret =
      typeof input.consumerSecret === "string" ? input.consumerSecret.trim() : "";
    const host = new URL(storeUrl).hostname;
    if (!consumerKey || !consumerSecret)
      return {
        ok: true,
        credentials: {},
        accountId: host,
        accountName: host,
        currency: null,
        settings: { storeUrl },
      };
    const credentials = { consumerKey, consumerSecret };
    try {
      const res = await requestJson<Obj>(
        ctx,
        `${storeUrl}/wp-json/wc/v3/settings/general/woocommerce_currency`,
        { headers: auth({ credentials }) ?? {} },
      );
      return {
        ok: true,
        credentials,
        accountId: host,
        accountName: host,
        currency: currencyOf(res.data.value) ?? null,
        settings: { storeUrl },
      };
    } catch (err) {
      if (err instanceof ProviderHttpError && (err.isAuth || err.isPermission))
        return {
          ok: false,
          error: "WooCommerce rejected the REST API keys (they need read access)",
        };
      return { ok: false, error: `Could not reach the WooCommerce store: ${describeError(err)}` };
    }
  },

  async backfill(conn, page, ctx) {
    const headers = auth(conn);
    const storeUrl = str(conn.settings.storeUrl);
    if (!headers || !storeUrl) return { batch: emptyBatch(), next: null };
    const n = page ? Number(page) : 1;
    const res = await requestJson<Obj[]>(
      ctx,
      `${storeUrl}/wp-json/wc/v3/orders?per_page=${PAGE}&page=${n}&status=processing,completed,refunded&orderby=date&order=asc`,
      { headers },
    );
    const batch = emptyBatch();
    for (const o of res.data ?? []) batch.payments.push(...normalizeOrder(o, ctx.now).payments);
    const totalPages = Number(res.headers.get("x-wp-totalpages") ?? n);
    return { batch, next: n < totalPages && (res.data ?? []).length ? String(n + 1) : null };
  },

  async verifyWebhook(rawBody, hdrs, secret) {
    const signature = hdrs.get("x-wc-webhook-signature");
    if (!signature && /^webhook_id=\d+$/.test(rawBody.trim())) {
      // WooCommerce's unsigned creation ping: acknowledge, ingest nothing.
      return { eventId: `ping:${rawBody.trim()}`, payload: null, headers: { topic: "ping" } };
    }
    if (!(await verifyBodyHmacBase64(rawBody, signature, secret))) return null;
    const payload = JSON.parse(rawBody) as Obj;
    return {
      eventId:
        hdrs.get("x-wc-webhook-delivery-id") ??
        `${String(payload.id)}:${String(payload.date_modified_gmt ?? "")}`,
      payload,
      headers: { topic: hdrs.get("x-wc-webhook-topic") ?? "" },
    };
  },

  normalizeWebhook(webhook) {
    if (webhook.headers.topic === "ping" || !webhook.payload) return emptyBatch();
    if (webhook.headers.topic && !webhook.headers.topic.startsWith("order.")) return emptyBatch();
    return normalizeOrder(webhook.payload as Obj, Date.now());
  },
};
