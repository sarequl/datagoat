/**
 * Attribution-aware revenue joins (plan §9, §10). Revenue counts payments that occurred in the
 * range. Without filters every payment counts (unattributed ones too); with filters, or when a
 * breakdown needs a session dimension, payments join the session chosen by the website's
 * attribution model (`first_touch` → first_session_id, `last_touch` → last_session_id,
 * `last_non_direct` → last_non_direct_session_id) and the filters apply to that session.
 */
import { paymentAggregatesSql, paymentSessionJoinSql } from "../lib/metrics";
import { toMajor } from "../lib/money";
import { raw, type SqlFragment, sql } from "../lib/sql";
import { filterSql, hasFilters, type QueryContext, rangeOn } from "./context";

export interface PaymentScope {
  /** `payments p` plus the attribution join when needed. */
  from: SqlFragment;
  where: SqlFragment;
  joined: boolean;
}

/**
 * FROM/WHERE for payments in the context. `joinSessions` forces the join to the attributed
 * session (alias `s`) even without filters, for dimension breakdowns.
 */
export function paymentScope(qc: QueryContext, joinSessions = false): PaymentScope {
  const joined = joinSessions || hasFilters(qc);
  const from = joined
    ? raw(`payments p ${paymentSessionJoinSql(qc.site.attributionModel, "p", "s")}`)
    : raw("payments p");
  const base = sql`p.site_id = ${qc.site.id} AND ${rangeOn("p.occurred_at", qc.range)}`;
  const where = joined ? sql`${base} AND ${filterSql(qc, "s")}` : base;
  return { from, where, joined };
}

/** SELECT list producing revenue_minor, payments, paying_visitors, new/renewal/refund minor. */
export function paymentAggregates(qc: QueryContext): string {
  return paymentAggregatesSql(qc.site.includeRenewalRevenue, "p");
}

export interface RevenueTotals {
  revenueMinor: number;
  payments: number;
  payingVisitors: number;
  newRevenueMinor: number;
  renewalRevenueMinor: number;
  refundMinor: number;
}

export function revenueFromRow(row: Record<string, unknown> | null | undefined): RevenueTotals {
  return {
    revenueMinor: Number(row?.revenue_minor ?? 0),
    payments: Number(row?.payments ?? 0),
    payingVisitors: Number(row?.paying_visitors ?? 0),
    newRevenueMinor: Number(row?.new_revenue_minor ?? 0),
    renewalRevenueMinor: Number(row?.renewal_revenue_minor ?? 0),
    refundMinor: Number(row?.refund_minor ?? 0),
  };
}

/** `{new, renewal, refunds}` in major units (refunds reported as a positive amount). */
export function revenueBreakdown(t: RevenueTotals, currency: string) {
  return {
    new: toMajor(t.newRevenueMinor, currency),
    renewal: toMajor(t.renewalRevenueMinor, currency),
    refunds: toMajor(Math.abs(t.refundMinor), currency),
  };
}

/** Payment kinds that count as "paying" (for customers / conversion). */
export function payingKindsSql(qc: QueryContext): string {
  return qc.site.includeRenewalRevenue ? "('payment', 'renewal')" : "('payment')";
}

/** Kinds that count toward revenue. */
export function revenueKindsSql(qc: QueryContext): string {
  return qc.site.includeRenewalRevenue
    ? "('payment', 'renewal', 'refund')"
    : "('payment', 'refund')";
}
