/**
 * Visitor identifiers carried by payments (plan §10.1, step 1 "metadata").
 *
 * Checkout metadata, custom data, cart attributes and order meta may carry the visitor id under
 * DataGoat's own key or DataFast's key, so a checkout integration written for DataFast keeps
 * working unchanged:
 *
 *   visitor: datagoat_visitor_id, datafast_visitor_id (also with a leading `_` or `__`, as order
 *            meta / hidden cart attributes are often written)
 *   session: datagoat_session_id, datafast_session_id
 *
 * Stripe's `client_reference_id` is accepted as a visitor id when it looks like one (Payment
 * Links and Pricing Tables pass it through the URL).
 */
import { sha256Hex } from "../lib/crypto";

export const VISITOR_KEYS = ["datagoat_visitor_id", "datafast_visitor_id"] as const;
export const SESSION_KEYS = ["datagoat_session_id", "datafast_session_id"] as const;

const ID_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

/** A plausible visitor/session id (UUIDs, `s`+UUID, cookieless hashes); rejects junk. */
export function cleanId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return ID_RE.test(v) ? v : undefined;
}

function lookup(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    for (const k of [key, `_${key}`, `__${key}`]) {
      const v = cleanId(record[k]);
      if (v) return v;
    }
  }
  return undefined;
}

export interface VisitorRef {
  visitorId?: string | undefined;
  sessionId?: string | undefined;
}

/** Read visitor and session ids from one or more metadata objects (first hit wins). */
export function visitorFromMetadata(...sources: unknown[]): VisitorRef {
  const out: VisitorRef = {};
  for (const source of sources) {
    const record = asRecord(source);
    if (!record) continue;
    out.visitorId ??= lookup(record, VISITOR_KEYS);
    out.sessionId ??= lookup(record, SESSION_KEYS);
  }
  return out;
}

/** Name/value pair lists (Shopify note_attributes, WooCommerce meta_data) to a record. */
export function pairsToRecord(
  pairs: unknown,
  nameKey = "name",
  valueKey = "value",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(pairs)) return out;
  for (const p of pairs) {
    const r = asRecord(p);
    if (!r) continue;
    const name = r[nameKey];
    if (typeof name === "string") out[name] = r[valueKey];
  }
  return out;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}

/** Epoch ms from epoch seconds, epoch ms or an ISO string. */
export function timeOf(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === "string" && value) {
    const n = Number(value);
    if (Number.isFinite(n) && value.trim() !== "") return n < 1e11 ? n * 1000 : n;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}

export function normaliseEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const v = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

/** SHA-256 hex of the lower-cased email (the same hash W1 stores in `visitors.email_hash`). */
export async function emailHash(email: string | null | undefined): Promise<string | null> {
  const v = normaliseEmail(email);
  return v ? sha256Hex(v) : null;
}

/** Upper-cased ISO 4217 code, or undefined. */
export function currencyOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(v) ? v : undefined;
}
