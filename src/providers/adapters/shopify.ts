/**
 * Shopify orders.
 *
 * Connections are created by W8's Shopify app install flow (`saveConnection` with
 * `{shopDomain}`, the app's client secret as the webhook secret and the Admin API token), or
 * manually with POST …/integrations/shopify `{shopDomain, webhookSecret, accessToken?}` for a
 * custom app.
 *
 * - Webhooks (`orders/paid`, `orders/create`, `refunds/create`) at `/webhooks/shopify/<websiteId>`
 *   are verified with `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 of the raw body) and must come
 *   from the connected shop (`X-Shopify-Shop-Domain`).
 * - The visitor id comes from the cart attributes the storefront snippet sets
 *   (docs/revenue/shopify.md), which Shopify copies to the order's `note_attributes`:
 *   `datagoat_visitor_id` / `datafast_visitor_id` (+ `_session_id`).
 * - With an Admin API token, paid orders are backfilled (REST, `page_info` pagination).
 * - Orders created by a subscription contract (`source_name: subscription_contract`) are renewals.
 */

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

export const SHOPIFY_API_VERSION = "2025-10";
const PAGE = 50;

export function normaliseShopDomain(value: string): string | null {
  const v = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(v) ? v : null;
}

function adminUrl(shop: string, path: string) {
  return `https://${shop}/admin/api/${SHOPIFY_API_VERSION}${path}`;
}

export function normalizeOrder(o: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  const financial = str(o.financial_status);
  if (
    financial &&
    !["paid", "partially_refunded", "refunded", "partially_paid"].includes(financial)
  )
    return out;
  const currency = currencyOf(o.currency) ?? "USD";
  const amount = toMinor(num(o.total_price) ?? 0, currency);
  const attrs = pairsToRecord(o.note_attributes);
  const customer = asRecord(o.customer);
  const ref = visitorFromMetadata(attrs, pairsToRecord(o.attributes));
  if (amount > 0) {
    out.payments.push({
      providerTxnId: String(o.id),
      providerCustomerId: customer?.id !== undefined ? String(customer.id) : undefined,
      kind: o.source_name === "subscription_contract" ? "renewal" : "payment",
      amountMinor: amount,
      currency,
      occurredAt: timeOf(o.processed_at ?? o.created_at, at),
      ...ref,
      email: str(o.email) ?? str(customer?.email),
      name:
        [str(customer?.first_name), str(customer?.last_name)].filter(Boolean).join(" ") ||
        undefined,
      hintRefs: [String(o.id), str(o.checkout_token), str(o.cart_token)].filter(
        (x): x is string => !!x,
      ),
      metadata: { order: str(o.name) },
    });
  }
  for (const r of Array.isArray(o.refunds) ? o.refunds : []) {
    const rr = asRecord(r);
    if (rr) out.payments.push(...normalizeRefund({ ...rr, order_id: o.id, currency }, at).payments);
  }
  return out;
}

export function normalizeRefund(r: Obj, at: number): NormalizedBatch {
  const out = emptyBatch();
  let total = 0;
  let currency = currencyOf(r.currency);
  for (const t of Array.isArray(r.transactions) ? r.transactions : []) {
    const tt = asRecord(t);
    if (tt?.kind !== "refund" || (tt.status && tt.status !== "success")) continue;
    currency ??= currencyOf(tt.currency);
    total += num(tt.amount) ?? 0;
  }
  if (total <= 0) return out;
  const c = currency ?? "USD";
  out.payments.push({
    providerTxnId: `refund:${String(r.id)}`,
    kind: "refund",
    amountMinor: -toMinor(total, c),
    currency: c,
    occurredAt: timeOf(r.processed_at ?? r.created_at, at),
    refundOf: [String(r.order_id)],
  });
  return out;
}

export const shopifyAdapter: ProviderAdapter = {
  id: "shopify",
  displayName: "Shopify",
  pollEveryMinutes: 60,

  async validateCredentials(input, ctx): Promise<ValidationResult> {
    const shop =
      typeof input.shopDomain === "string" ? normaliseShopDomain(input.shopDomain) : null;
    if (!shop)
      return { ok: false, error: "shopDomain must be your store's *.myshopify.com domain" };
    const secret = typeof input.webhookSecret === "string" ? input.webhookSecret.trim() : "";
    if (!secret) return { ok: false, error: "webhookSecret (the app's client secret) is required" };
    const token = typeof input.accessToken === "string" ? input.accessToken.trim() : "";
    if (!token)
      return {
        ok: true,
        credentials: {},
        accountId: shop,
        accountName: shop,
        currency: null,
        settings: { shopDomain: shop },
      };
    try {
      const res = await requestJson<{ shop: Obj }>(ctx, adminUrl(shop, "/shop.json"), {
        headers: { "x-shopify-access-token": token },
      });
      return {
        ok: true,
        credentials: { accessToken: token },
        accountId: shop,
        accountName: str(res.data.shop?.name) ?? shop,
        currency: currencyOf(res.data.shop?.currency) ?? null,
        settings: { shopDomain: shop },
      };
    } catch (err) {
      if (err instanceof ProviderHttpError && (err.isAuth || err.isPermission))
        return { ok: false, error: "Shopify rejected the Admin API access token" };
      return { ok: false, error: `Could not reach Shopify: ${describeError(err)}` };
    }
  },

  async backfill(conn, page, ctx) {
    const token = conn.credentials.accessToken;
    const shop = String(conn.settings.shopDomain ?? conn.accountId ?? "");
    if (!token || !shop) return { batch: emptyBatch(), next: null };
    const url = page
      ? adminUrl(shop, `/orders.json?limit=${PAGE}&page_info=${encodeURIComponent(page)}`)
      : adminUrl(
          shop,
          `/orders.json?limit=${PAGE}&status=any&financial_status=paid,partially_refunded,refunded`,
        );
    const res = await requestJson<{ orders: Obj[] }>(ctx, url, {
      headers: { "x-shopify-access-token": token },
    });
    const batch = emptyBatch();
    for (const o of res.data.orders ?? []) {
      const b = normalizeOrder(o, ctx.now);
      batch.payments.push(...b.payments);
    }
    const link = res.headers.get("link") ?? "";
    const next = /<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/.exec(link)?.[1] ?? null;
    return { batch, next: next ? decodeURIComponent(next) : null };
  },

  async verifyWebhook(rawBody, hdrs, secret) {
    if (!(await verifyBodyHmacBase64(rawBody, hdrs.get("x-shopify-hmac-sha256"), secret)))
      return null;
    const topic = hdrs.get("x-shopify-topic") ?? "";
    const id = hdrs.get("x-shopify-event-id") ?? hdrs.get("x-shopify-webhook-id") ?? "";
    const payload = JSON.parse(rawBody) as Obj;
    return {
      eventId: id || `${topic}:${String(payload.id ?? "")}:${String(payload.updated_at ?? "")}`,
      payload,
      headers: { topic, shop: (hdrs.get("x-shopify-shop-domain") ?? "").toLowerCase() },
    };
  },

  normalizeWebhook(webhook, conn) {
    const shop = String(conn.settings.shopDomain ?? conn.accountId ?? "");
    if (webhook.headers.shop && shop && webhook.headers.shop !== shop) return emptyBatch();
    const payload = webhook.payload as Obj;
    const topic = webhook.headers.topic ?? "";
    if (topic === "refunds/create") return normalizeRefund(payload, Date.now());
    if (topic.startsWith("orders/")) return normalizeOrder(payload, Date.now());
    return emptyBatch();
  },
};
