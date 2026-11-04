/**
 * Subscription lifecycle goals (DataFast's reserved goal names, docs: custom-goals.md).
 *
 * Providers report subscriptions in different shapes and with different event vocabularies, so
 * every adapter normalises a subscription into a snapshot (types.ts `NormalizedSubscription`) and
 * this module diffs it against the last stored snapshot (`provider_subscriptions`):
 *
 * | previous → next                                   | goal                           |
 * |---------------------------------------------------|--------------------------------|
 * | none → trialing                                   | trial_started                  |
 * | none / incomplete → active (or past_due)          | subscription_started           |
 * | trialing → active                                 | trial_converted                |
 * | live → ended (or none → ended after a live state) | subscription_ended             |
 * | ended → live                                      | subscription_reactivated       |
 * | cancel_at_period_end false → true (still live)    | subscription_cancel_scheduled  |
 * | cancel_at_period_end true → false (still live)    | subscription_reactivated       |
 * | MRR up / down, same currency, both live, paid     | subscription_upgraded / _downgraded |
 *
 * Renewals (`subscription_renewed`), payments (`payment`) and trials (`free_trial`) are emitted
 * from payment rows by the engine, not from snapshots.
 */
import type { LifecycleGoal, NormalizedSubscription, SubscriptionStatus } from "./types";

export interface StoredSubscription {
  status: SubscriptionStatus;
  mrrMinor: number | null;
  currency: string | null;
  cancelAtPeriodEnd: boolean;
  hadTrial: boolean;
  firstPaidAt: number | null;
  lastPaidMinor: number | null;
  customerId: string | null;
  visitorId: string | null;
  startedAt: number | null;
}

const LIVE: ReadonlySet<SubscriptionStatus> = new Set(["trialing", "active", "past_due", "paused"]);
const PAID: ReadonlySet<SubscriptionStatus> = new Set(["active", "past_due"]);

export function isLive(status: SubscriptionStatus): boolean {
  return LIVE.has(status);
}

export function lifecycleGoals(
  prev: StoredSubscription | null,
  next: NormalizedSubscription,
): LifecycleGoal[] {
  const goals: LifecycleGoal[] = [];
  if (!prev || prev.status === "incomplete") {
    if (next.status === "trialing") goals.push("trial_started");
    else if (PAID.has(next.status)) goals.push("subscription_started");
    if (next.cancelAtPeriodEnd && isLive(next.status)) goals.push("subscription_cancel_scheduled");
    return goals;
  }
  if (prev.status === "ended") {
    if (isLive(next.status)) goals.push("subscription_reactivated");
    return goals;
  }
  // prev is live
  if (next.status === "ended") return ["subscription_ended"];
  if (prev.status === "trialing" && PAID.has(next.status)) goals.push("trial_converted");
  if (!prev.cancelAtPeriodEnd && next.cancelAtPeriodEnd)
    goals.push("subscription_cancel_scheduled");
  if (prev.cancelAtPeriodEnd && !next.cancelAtPeriodEnd) goals.push("subscription_reactivated");
  if (
    PAID.has(prev.status) &&
    PAID.has(next.status) &&
    prev.mrrMinor !== null &&
    next.mrrMinor !== undefined &&
    prev.currency === (next.currency ?? prev.currency)
  ) {
    if (next.mrrMinor > prev.mrrMinor) goals.push("subscription_upgraded");
    else if (next.mrrMinor < prev.mrrMinor) goals.push("subscription_downgraded");
  }
  return goals;
}

/** True when the snapshot differs from what is stored in a field the table tracks. */
export function snapshotChanged(
  prev: StoredSubscription | null,
  next: StoredSubscription,
): boolean {
  if (!prev) return true;
  return (
    prev.status !== next.status ||
    prev.mrrMinor !== next.mrrMinor ||
    prev.currency !== next.currency ||
    prev.cancelAtPeriodEnd !== next.cancelAtPeriodEnd ||
    prev.hadTrial !== next.hadTrial ||
    prev.firstPaidAt !== next.firstPaidAt ||
    prev.lastPaidMinor !== next.lastPaidMinor ||
    prev.customerId !== next.customerId ||
    prev.visitorId !== next.visitorId ||
    prev.startedAt !== next.startedAt
  );
}

/** Normalise a recurring price to a monthly amount (minor units). */
export function monthlyAmount(
  amountMinor: number,
  interval: string | null | undefined,
  count = 1,
): number {
  const n = Math.max(1, count || 1);
  switch ((interval ?? "month").toLowerCase()) {
    case "day":
      return Math.round((amountMinor * 30) / n);
    case "week":
      return Math.round((amountMinor * 52) / 12 / n);
    case "year":
      return Math.round(amountMinor / 12 / n);
    default:
      return Math.round(amountMinor / n);
  }
}
