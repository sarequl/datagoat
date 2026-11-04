-- DataGoat migration 0300 (W3, revenue).
--
-- 1. payments.subscription_id: the provider subscription a payment belongs to, so renewals,
--    trial conversions and refunds can be tied to the subscription that produced them.
-- 2. payments.reason: why a negative (or reversing) row exists: 'refund' (default for refunds),
--    'dispute' (chargeback opened/lost) or 'dispute_won' (chargeback reversed, positive amount).
-- 3. provider_subscriptions: the last known state of every subscription a provider reported. The
--    lifecycle engine (src/providers/lifecycle.ts) diffs each new snapshot against this row to emit
--    DataFast's reserved goals (trial_started, trial_converted, subscription_started,
--    subscription_upgraded, subscription_downgraded, subscription_cancel_scheduled,
--    subscription_reactivated, subscription_ended). One row per subscription, rewritten only when
--    a tracked field changes; no secondary index (lookups are by primary key).
--
-- No index is added to `payments`: lookups by subscription go through provider_subscriptions.

ALTER TABLE payments ADD COLUMN subscription_id TEXT;
ALTER TABLE payments ADD COLUMN reason TEXT;

CREATE TABLE provider_subscriptions (
  site_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  customer_id TEXT,
  visitor_id TEXT,                           -- attributed visitor (NULL until attributed)
  status TEXT NOT NULL,                      -- trialing | active | past_due | paused | incomplete | ended
  mrr_minor INTEGER,                         -- monthly recurring amount, original currency; NULL = unknown
  currency TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  had_trial INTEGER NOT NULL DEFAULT 0,      -- the subscription started with a trial
  first_paid_at INTEGER,                     -- first non-zero payment (trial conversion / first sale)
  last_paid_minor INTEGER,                   -- amount of the latest paid invoice (plan-change detection)
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, provider, subscription_id)
) WITHOUT ROWID;
