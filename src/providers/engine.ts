/**
 * The revenue ingest engine: attribution, currency conversion, lifecycle goals and storage for
 * every payment source (provider webhooks, polling, backfill, hint resolution, the Payments API).
 *
 * Attribution order (plan §10.1), recorded in `payments.attributed_via`:
 *   1. metadata  visitor id carried by the payment (checkout metadata, custom data, cart attributes)
 *   2. link      a success-page hint (`payment_hints`) referencing the checkout/order
 *   3. customer  the provider customer (or subscription) already mapped to a visitor
 *   4. email     the customer's email hash matches a visitor that sent identify/payment with it
 *   5. api       `datafast_visitor_id` sent to POST /api/v1/payments
 *   6. none      stored and shown as "Unattributed"
 * A candidate only counts when the visitor has at least one session on this website. Refunds
 * inherit the visitor and sessions of the payment they refund ("negative revenue against the
 * original visitor").
 *
 * Every attributed payment stores the visitor's first session (first touch), the last session
 * started before the payment (last touch; the checkout's own session when metadata carries it)
 * and the last non-Direct session (last non-direct), so the attribution model is a column choice.
 *
 * D1 cost per call: one batch of reads (existing payments, hints, customer map, subscriptions,
 * email matches, FX rates), one batch of session reads for candidate visitors, and the writes in
 * as few batches as possible (50 statements each). Nothing is written for duplicates.
 */
import { chunkForParams, placeholders, runBatch } from "../lib/d1";
import { newId } from "../lib/ids";
import { toMajor } from "../lib/money";
import type { Site } from "../lib/sites";
import { emailHash, normaliseEmail } from "./attribution";
import { convert, RateTable, rateStatements, rateTableFrom } from "./fx";
import { lifecycleGoals, type StoredSubscription, snapshotChanged } from "./lifecycle";
import type {
  AttributedVia,
  CustomerLink,
  IngestSource,
  LifecycleGoal,
  NormalizedBatch,
  NormalizedPayment,
  NormalizedSubscription,
  PaymentKind,
  PaymentSourceProvider,
} from "./types";

export interface IngestOptions {
  site: Site;
  provider: PaymentSourceProvider;
  source: IngestSource;
  now: number;
  /** Emit subscription lifecycle goals (default: not during backfill). */
  emitLifecycle?: boolean;
  /** Upgrades/downgrades from renewal amounts (providers without plan prices). */
  planChangesFromRenewals?: boolean;
  /** A hint being resolved: payments referencing `ref` attribute to this visitor ('link'). */
  hint?: { ref: string; visitorId: string; sessionId: string | null };
}

export type PaymentStatus = "inserted" | "attributed" | "updated" | "duplicate";

export interface PaymentOutcome {
  txnId: string;
  status: PaymentStatus;
  kind: PaymentKind;
  attributedVia: AttributedVia;
  visitorId: string | null;
  /** True when the visitor id the payment carried has no sessions on this website. */
  unknownVisitor: boolean;
}

export interface IngestResult {
  payments: PaymentOutcome[];
  goals: number;
  statements: number;
}

interface PaymentRow {
  id: string;
  provider_txn_id: string;
  provider_customer_id: string | null;
  kind: PaymentKind;
  amount_minor: number;
  currency: string;
  reporting_minor: number;
  visitor_id: string | null;
  first_session_id: string | null;
  last_session_id: string | null;
  last_non_direct_session_id: string | null;
  attributed_via: AttributedVia;
  occurred_at: number;
  subscription_id: string | null;
  lifecycle_goal: string | null;
}

interface SessionInfo {
  id: string;
  started_at: number;
  channel: string;
}

interface VisitorSessions {
  first: string | null;
  /** Newest first, at most SESSION_WINDOW. */
  recent: SessionInfo[];
}

interface Resolved {
  visitorId: string;
  via: AttributedVia;
  sessionId: string | null;
}

interface Attribution {
  visitorId: string | null;
  via: AttributedVia;
  first: string | null;
  last: string | null;
  lastNonDirect: string | null;
}

const SESSION_WINDOW = 200;
const NONE: Attribution = {
  visitorId: null,
  via: "none",
  first: null,
  last: null,
  lastNonDirect: null,
};

/** The reserved goal a payment row emits. */
export function paymentGoal(kind: PaymentKind): LifecycleGoal | null {
  switch (kind) {
    case "payment":
      return "payment";
    case "renewal":
      return "subscription_renewed";
    case "free_trial":
      return "free_trial";
    default:
      return null;
  }
}

function subFromRow(row: Record<string, unknown>): StoredSubscription {
  return {
    status: row.status as StoredSubscription["status"],
    mrrMinor: row.mrr_minor === null ? null : Number(row.mrr_minor),
    currency: (row.currency as string | null) ?? null,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    hadTrial: row.had_trial === 1,
    firstPaidAt: row.first_paid_at === null ? null : Number(row.first_paid_at),
    lastPaidMinor: row.last_paid_minor === null ? null : Number(row.last_paid_minor),
    customerId: (row.customer_id as string | null) ?? null,
    visitorId: (row.visitor_id as string | null) ?? null,
    startedAt: row.started_at === null ? null : Number(row.started_at),
  };
}

/** Expand subscriptions in trial into free-trial payment rows (`<subscription>:trial`). */
function withTrialPayments(batch: NormalizedBatch, siteCurrency: string): NormalizedPayment[] {
  const trials: NormalizedPayment[] = batch.subscriptions
    .filter((s) => s.status === "trialing")
    .map((s) => ({
      providerTxnId: `${s.id}:trial`,
      providerCustomerId: s.customerId,
      kind: "free_trial" as const,
      amountMinor: 0,
      currency: s.currency ?? siteCurrency,
      occurredAt: s.trialStartAt ?? s.startedAt ?? s.occurredAt,
      visitorId: s.visitorId,
      sessionId: s.sessionId,
      email: s.email,
      subscriptionId: s.id,
      hintRefs: s.hintRefs,
    }));
  return [...batch.payments, ...trials];
}

export async function ingestBatch(
  db: D1Database,
  batch: NormalizedBatch,
  options: IngestOptions,
): Promise<IngestResult> {
  const { site, provider, now } = options;
  const emitLifecycle = options.emitLifecycle ?? options.source !== "backfill";
  const siteCurrency = site.currency;
  const payments = withTrialPayments(batch, siteCurrency);
  const subscriptions = [...batch.subscriptions].sort((a, b) => a.occurredAt - b.occurredAt);
  const customers = [...batch.customers].sort((a, b) => a.occurredAt - b.occurredAt);

  // ---- Phase 1: everything keyed by provider ids ------------------------------------------
  const txnIds = new Set<string>();
  const hintRefs = new Set<string>();
  const customerIds = new Set<string>();
  const subIds = new Set<string>();
  const emails = new Set<string>();
  for (const p of payments) {
    txnIds.add(p.providerTxnId);
    for (const r of p.refundOf ?? []) txnIds.add(r);
    for (const r of p.hintRefs ?? []) hintRefs.add(r);
    if (p.providerCustomerId) customerIds.add(p.providerCustomerId);
    if (p.subscriptionId) subIds.add(p.subscriptionId);
    if (p.email) emails.add(p.email);
  }
  for (const s of subscriptions) {
    subIds.add(s.id);
    if (s.customerId) customerIds.add(s.customerId);
    for (const r of s.hintRefs ?? []) hintRefs.add(r);
    if (s.email) emails.add(s.email);
  }
  for (const c of customers) {
    if (c.customerId) customerIds.add(c.customerId);
    if (c.subscriptionId) subIds.add(c.subscriptionId);
    for (const t of c.attachTxnIds ?? []) txnIds.add(t);
    for (const r of c.hintRefs ?? []) hintRefs.add(r);
    if (c.email) emails.add(c.email);
  }
  if (options.hint) hintRefs.delete(options.hint.ref);

  const hashByEmail = new Map<string, string>();
  for (const e of emails) {
    const h = await emailHash(e);
    if (h) hashByEmail.set(e, h);
  }
  const hashes = [...new Set(hashByEmail.values())];

  const reads: Array<{ kind: string; stmt: D1PreparedStatement }> = [];
  const inList = (
    kind: string,
    values: Iterable<string>,
    reserved: number,
    build: (ph: string, chunk: string[]) => D1PreparedStatement,
  ) => {
    for (const chunk of chunkForParams([...values], reserved)) {
      if (chunk.length) reads.push({ kind, stmt: build(placeholders(chunk.length), chunk) });
    }
  };
  inList("payments", txnIds, 2, (ph, c) =>
    db
      .prepare(
        `SELECT id, provider_txn_id, provider_customer_id, kind, amount_minor, currency, reporting_minor, visitor_id,
           first_session_id, last_session_id, last_non_direct_session_id, attributed_via, occurred_at,
           subscription_id, lifecycle_goal
         FROM payments WHERE site_id = ? AND provider = ? AND provider_txn_id IN (${ph})`,
      )
      .bind(site.id, provider, ...c),
  );
  inList("hints", hintRefs, 2, (ph, c) =>
    db
      .prepare(
        `SELECT ref, visitor_id, session_id FROM payment_hints WHERE site_id = ? AND provider = ? AND ref IN (${ph})`,
      )
      .bind(site.id, provider, ...c),
  );
  inList("customers", customerIds, 2, (ph, c) =>
    db
      .prepare(
        `SELECT customer_id, visitor_id FROM provider_customers WHERE site_id = ? AND provider = ? AND customer_id IN (${ph})`,
      )
      .bind(site.id, provider, ...c),
  );
  inList("subs", subIds, 2, (ph, c) =>
    db
      .prepare(
        `SELECT * FROM provider_subscriptions WHERE site_id = ? AND provider = ? AND subscription_id IN (${ph})`,
      )
      .bind(site.id, provider, ...c),
  );
  inList("emails", hashes, 1, (ph, c) =>
    db
      .prepare(
        `SELECT id, email_hash FROM visitors WHERE site_id = ? AND email_hash IN (${ph}) ORDER BY first_seen_at DESC`,
      )
      .bind(site.id, ...c),
  );
  const currencies = [...new Set([...payments.map((p) => p.currency), siteCurrency])];
  if (currencies.some((c) => c !== siteCurrency) && payments.length) {
    const times = payments.map((p) => p.occurredAt);
    for (const stmt of rateStatements(db, currencies, Math.min(...times), Math.max(...times))) {
      reads.push({ kind: "rates", stmt });
    }
  }

  const existing = new Map<string, PaymentRow>();
  const hints = new Map<string, { visitorId: string; sessionId: string | null }>();
  const customerMap = new Map<string, string>();
  const subMap = new Map<string, StoredSubscription>();
  const emailVisitors = new Map<string, string>();
  const rateResults: D1Result[] = [];
  if (reads.length) {
    const results = await runBatch(
      db,
      reads.map((r) => r.stmt),
    );
    results.forEach((res, i) => {
      const kind = reads[i]?.kind;
      const rows = (res.results ?? []) as Array<Record<string, unknown>>;
      for (const row of rows) {
        if (kind === "payments")
          existing.set(String(row.provider_txn_id), row as unknown as PaymentRow);
        else if (kind === "hints")
          hints.set(String(row.ref), {
            visitorId: String(row.visitor_id),
            sessionId: (row.session_id as string | null) ?? null,
          });
        else if (kind === "customers")
          customerMap.set(String(row.customer_id), String(row.visitor_id));
        else if (kind === "subs") subMap.set(String(row.subscription_id), subFromRow(row));
        else if (kind === "emails" && !emailVisitors.has(String(row.email_hash)))
          emailVisitors.set(String(row.email_hash), String(row.id));
      }
      if (kind === "rates") rateResults.push(res);
    });
  }
  const rates = rateResults.length ? rateTableFrom(rateResults) : new RateTable();
  if (options.hint) {
    hints.set(options.hint.ref, {
      visitorId: options.hint.visitorId,
      sessionId: options.hint.sessionId,
    });
  }

  // ---- Phase 2: sessions of every candidate visitor ----------------------------------------
  const candidates = new Set<string>();
  const metaSessions = new Set<string>();
  const addItem = (i: { visitorId?: string | undefined; sessionId?: string | undefined }) => {
    if (i.visitorId) candidates.add(i.visitorId);
    if (i.sessionId) metaSessions.add(i.sessionId);
  };
  payments.forEach(addItem);
  subscriptions.forEach(addItem);
  customers.forEach(addItem);
  for (const h of hints.values()) candidates.add(h.visitorId);
  for (const v of customerMap.values()) candidates.add(v);
  for (const s of subMap.values()) if (s.visitorId) candidates.add(s.visitorId);
  for (const v of emailVisitors.values()) candidates.add(v);

  const visitorSessions = new Map<string, VisitorSessions>();
  const sessionOwner = new Map<string, string>();
  if (candidates.size) {
    const stmts: D1PreparedStatement[] = [];
    const order: string[] = [];
    for (const v of candidates) {
      order.push(v);
      stmts.push(
        db
          .prepare(
            `SELECT id, started_at, channel, 0 AS is_first FROM (SELECT id, started_at, channel FROM sessions
               WHERE site_id = ?1 AND visitor_id = ?2 ORDER BY started_at DESC LIMIT ${SESSION_WINDOW})
             UNION ALL
             SELECT id, started_at, channel, 1 AS is_first FROM (SELECT id, started_at, channel FROM sessions
               WHERE site_id = ?1 AND visitor_id = ?2 ORDER BY started_at ASC LIMIT 1)`,
          )
          .bind(site.id, v),
      );
    }
    for (const chunk of chunkForParams([...metaSessions], 1)) {
      if (!chunk.length) continue;
      order.push("\u0000meta");
      stmts.push(
        db
          .prepare(
            `SELECT id, visitor_id FROM sessions WHERE site_id = ? AND id IN (${placeholders(chunk.length)})`,
          )
          .bind(site.id, ...chunk),
      );
    }
    const results = await runBatch(db, stmts);
    results.forEach((res, i) => {
      const key = order[i] ?? "";
      const rows = (res.results ?? []) as Array<Record<string, unknown>>;
      if (key === "\u0000meta") {
        for (const r of rows) sessionOwner.set(String(r.id), String(r.visitor_id));
        return;
      }
      const recent: SessionInfo[] = [];
      let first: string | null = null;
      for (const r of rows) {
        if (r.is_first === 1) first = String(r.id);
        else
          recent.push({
            id: String(r.id),
            started_at: Number(r.started_at),
            channel: String(r.channel),
          });
      }
      if (first || recent.length) visitorSessions.set(key, { first, recent });
    });
  }

  const hasSessions = (v: string | undefined | null): v is string => !!v && visitorSessions.has(v);

  const attributionFor = (r: Resolved, at: number): Attribution => {
    const vs = visitorSessions.get(r.visitorId);
    if (!vs) return NONE;
    const before = vs.recent.filter((s) => s.started_at <= at);
    const lastDefault = before[0]?.id ?? vs.recent[0]?.id ?? vs.first;
    const preferred =
      r.sessionId && sessionOwner.get(r.sessionId) === r.visitorId ? r.sessionId : null;
    const last = preferred ?? lastDefault ?? null;
    const nonDirect = before.find((s) => s.channel !== "Direct")?.id;
    return {
      visitorId: r.visitorId,
      via: r.via,
      first: vs.first ?? vs.recent[vs.recent.length - 1]?.id ?? last,
      last,
      lastNonDirect: preferred ?? nonDirect ?? last,
    };
  };

  const hashOf = (email: string | undefined) => (email ? hashByEmail.get(email) : undefined);

  interface Candidate {
    visitorId?: string | undefined;
    visitorVia?: AttributedVia | undefined;
    sessionId?: string | undefined;
    hintRefs?: string[] | undefined;
    customerId?: string | undefined;
    providerCustomerId?: string | undefined;
    subscriptionId?: string | undefined;
    email?: string | undefined;
  }

  const usedHints = new Set<string>();
  const resolve = (item: Candidate): Resolved | null => {
    // Payments API visitor ids rank after the customer map and email (plan §10.1 step 5), so a
    // renewal posted from a different browser still credits the customer's original visitor.
    const own: Resolved | null = hasSessions(item.visitorId)
      ? {
          visitorId: item.visitorId,
          via: item.visitorVia ?? "metadata",
          sessionId: item.sessionId ?? null,
        }
      : null;
    if (own && own.via !== "api") return own;
    for (const ref of item.hintRefs ?? []) {
      const h = hints.get(ref);
      if (h && hasSessions(h.visitorId)) {
        usedHints.add(ref);
        return { visitorId: h.visitorId, via: "link", sessionId: h.sessionId };
      }
    }
    const customerKey = item.customerId ?? item.providerCustomerId;
    const byCustomer = customerKey ? customerMap.get(customerKey) : undefined;
    if (hasSessions(byCustomer)) return { visitorId: byCustomer, via: "customer", sessionId: null };
    const bySub = item.subscriptionId ? subMap.get(item.subscriptionId)?.visitorId : undefined;
    if (hasSessions(bySub)) return { visitorId: bySub, via: "customer", sessionId: null };
    const h = hashOf(item.email);
    const byEmail = h ? emailVisitors.get(h) : undefined;
    if (hasSessions(byEmail)) return { visitorId: byEmail, via: "email", sessionId: null };
    return own;
  };

  // ---- Phase 3: decide and write -----------------------------------------------------------
  const writes: D1PreparedStatement[] = [];
  let goals = 0;
  const outcomes: PaymentOutcome[] = [];
  const dirtySubs = new Map<string, StoredSubscription>();
  const goalSessionFor = (a: Attribution) => a.last ?? a.first;

  const emitGoal = (
    a: Attribution,
    goal: LifecycleGoal,
    at: number,
    props: Record<string, unknown>,
  ) => {
    const session = goalSessionFor(a);
    if (!a.visitorId || !session) return;
    goals += 1;
    writes.push(
      db
        .prepare(
          `INSERT INTO events (site_id, ts, session_id, visitor_id, type, hostname, path, name, props)
           VALUES (?, ?, ?, ?, 'custom', NULL, NULL, ?, ?)`,
        )
        .bind(
          site.id,
          at,
          session,
          a.visitorId,
          goal,
          JSON.stringify({ origin: "payment_provider", provider, ...props }),
        ),
    );
  };

  const mapCustomer = (customerId: string | undefined | null, visitorId: string | null) => {
    if (!customerId || !visitorId || customerMap.has(customerId)) return;
    customerMap.set(customerId, visitorId);
    writes.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO provider_customers (site_id, provider, customer_id, visitor_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(site.id, provider, customerId, visitorId, now),
    );
  };

  const paymentProps = (row: {
    provider_txn_id: string;
    amount: number;
    currency: string;
    subscription_id: string | null;
    kind: PaymentKind;
  }) => ({
    type: row.kind === "renewal" ? "subscription_lifecycle" : "payment",
    transaction_id: row.provider_txn_id,
    amount: toMajor(row.amount, row.currency),
    currency: row.currency,
    ...(row.subscription_id ? { subscription_id: row.subscription_id } : {}),
  });

  /** Attribute a stored, unattributed payment (late attribution: customer link, hint, email). */
  const attributeExisting = (row: PaymentRow, r: Resolved): boolean => {
    if (row.visitor_id) return false;
    const a = attributionFor(r, row.occurred_at);
    if (!a.visitorId) return false;
    writes.push(
      db
        .prepare(
          `UPDATE payments SET visitor_id = ?, first_session_id = ?, last_session_id = ?, last_non_direct_session_id = ?,
             attributed_via = ?, updated_at = ? WHERE site_id = ? AND id = ? AND visitor_id IS NULL`,
        )
        .bind(a.visitorId, a.first, a.last, a.lastNonDirect, a.via, now, site.id, row.id),
    );
    row.visitor_id = a.visitorId;
    row.first_session_id = a.first;
    row.last_session_id = a.last;
    row.last_non_direct_session_id = a.lastNonDirect;
    row.attributed_via = a.via;
    const goal = paymentGoal(row.kind);
    if (goal) {
      emitGoal(
        a,
        goal,
        row.occurred_at,
        paymentProps({
          provider_txn_id: row.provider_txn_id,
          amount: row.amount_minor,
          currency: row.currency,
          subscription_id: row.subscription_id,
          kind: row.kind,
        }),
      );
    }
    mapCustomer(row.provider_customer_id, a.visitorId);
    return true;
  };

  const storeSub = (id: string, next: StoredSubscription) => {
    const prev = subMap.get(id) ?? null;
    subMap.set(id, next);
    if (snapshotChanged(prev, next)) dirtySubs.set(id, next);
  };

  // Customer links first: they create the mappings later items use.
  for (const link of customers) {
    const r = resolve(link);
    if (!r) continue;
    const a = attributionFor(r, link.occurredAt);
    mapCustomer(link.customerId, r.visitorId);
    for (const ref of link.hintRefs ?? []) if (hints.has(ref)) usedHints.add(ref);
    if (link.subscriptionId) {
      const sub = subMap.get(link.subscriptionId);
      if (sub && !sub.visitorId) {
        storeSub(link.subscriptionId, { ...sub, visitorId: r.visitorId });
        // The subscription was seen before its checkout: emit the goal its state implies now.
        if (emitLifecycle) {
          const late = lifecycleGoals(null, {
            id: link.subscriptionId,
            status: sub.status,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            occurredAt: link.occurredAt,
          });
          for (const g of late)
            emitGoal(a, g, link.occurredAt, {
              type: "subscription_lifecycle",
              subscription_id: link.subscriptionId,
            });
        }
      } else if (!sub) {
        storeSub(link.subscriptionId, {
          status: "incomplete",
          mrrMinor: null,
          currency: null,
          cancelAtPeriodEnd: false,
          hadTrial: false,
          firstPaidAt: null,
          lastPaidMinor: null,
          customerId: link.customerId ?? null,
          visitorId: r.visitorId,
          startedAt: null,
        });
      }
    }
    for (const txn of link.attachTxnIds ?? []) {
      const row = existing.get(txn);
      if (row) attributeExisting(row, r);
    }
  }

  // Subscriptions: lifecycle goals from snapshot diffs.
  for (const s of subscriptions) {
    const prev = subMap.get(s.id) ?? null;
    const r = resolve({ ...s, subscriptionId: s.id });
    const visitorId = r?.visitorId ?? prev?.visitorId ?? null;
    if (emitLifecycle && r) {
      const a = attributionFor(r, s.occurredAt);
      for (const g of lifecycleGoals(prev, s)) {
        emitGoal(a, g, s.occurredAt, {
          type: "subscription_lifecycle",
          subscription_id: s.id,
          ...(s.mrrMinor !== undefined ? { mrr: s.mrrMinor, currency: s.currency } : {}),
        });
      }
    }
    if (r) mapCustomer(s.customerId, r.visitorId);
    storeSub(s.id, {
      status: s.status,
      mrrMinor: s.mrrMinor ?? prev?.mrrMinor ?? null,
      currency: s.currency ?? prev?.currency ?? null,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      hadTrial: (prev?.hadTrial ?? false) || s.status === "trialing" || s.trialEndAt !== undefined,
      firstPaidAt: prev?.firstPaidAt ?? null,
      lastPaidMinor: prev?.lastPaidMinor ?? null,
      customerId: s.customerId ?? prev?.customerId ?? null,
      visitorId,
      startedAt: prev?.startedAt ?? s.startedAt ?? s.occurredAt,
    });
  }

  // Payments, in time order.
  const ordered = [...payments].sort((a, b) => a.occurredAt - b.occurredAt);
  const outcomeByTxn = new Map<string, PaymentOutcome>();
  for (const p of ordered) {
    const prior = existing.get(p.providerTxnId);
    if (prior) {
      let status: PaymentStatus = "duplicate";
      if (!prior.visitor_id) {
        const r = resolve({ ...p, subscriptionId: p.subscriptionId ?? undefined });
        if (r && attributeExisting(prior, r)) status = "attributed";
      }
      if (p.updateAmount && prior.amount_minor !== p.amountMinor) {
        const conv = convert(rates, p.amountMinor, p.currency, siteCurrency, prior.occurred_at);
        writes.push(
          db
            .prepare(
              "UPDATE payments SET amount_minor = ?, reporting_minor = ?, fx_rate = ?, updated_at = ? WHERE site_id = ? AND id = ?",
            )
            .bind(p.amountMinor, conv.reportingMinor, conv.fxRate, now, site.id, prior.id),
        );
        prior.amount_minor = p.amountMinor;
        if (status === "duplicate") status = "updated";
      }
      for (const ref of p.hintRefs ?? [])
        if (hints.has(ref) && prior.visitor_id) usedHints.add(ref);
      outcomeByTxn.set(p.providerTxnId, {
        txnId: p.providerTxnId,
        status,
        kind: prior.kind,
        attributedVia: prior.attributed_via,
        visitorId: prior.visitor_id,
        unknownVisitor: false,
      });
      continue;
    }

    // Kind: first paid charge of a subscription is a sale, later ones are renewals.
    let kind: PaymentKind;
    const sub = p.subscriptionId ? subMap.get(p.subscriptionId) : undefined;
    if (p.kind === "auto") kind = sub?.firstPaidAt ? "renewal" : "payment";
    else if (p.kind === "renewal" && sub && sub.firstPaidAt === null && sub.hadTrial)
      kind = "payment";
    else kind = p.kind;

    // Attribution.
    let a: Attribution = NONE;
    let original: PaymentRow | undefined;
    if (kind === "refund") {
      for (const ref of p.refundOf ?? []) {
        original = existing.get(ref);
        if (original) break;
      }
    }
    if (original?.visitor_id) {
      a = {
        visitorId: original.visitor_id,
        via: original.attributed_via,
        first: original.first_session_id,
        last: original.last_session_id,
        lastNonDirect: original.last_non_direct_session_id,
      };
    } else {
      const r = resolve(p);
      if (r) a = attributionFor(r, p.occurredAt);
    }
    const unknownVisitor = !!p.visitorId && !hasSessions(p.visitorId);

    const conv = convert(rates, p.amountMinor, p.currency, siteCurrency, p.occurredAt);
    const email = normaliseEmail(p.email);
    const hash = hashOf(p.email) ?? null;
    const goal = paymentGoal(kind);
    const metadata = {
      ...(p.metadata ?? {}),
      ...(unknownVisitor ? { unknownVisitorId: p.visitorId } : {}),
    };
    const id = newId(now);
    writes.push(
      db
        .prepare(
          `INSERT INTO payments (site_id, id, provider, provider_txn_id, provider_customer_id, provider_event_id, kind,
             amount_minor, currency, reporting_minor, reporting_currency, fx_rate, visitor_id, first_session_id,
             last_session_id, last_non_direct_session_id, attributed_via, customer_email, customer_name, email_hash,
             refund_of, lifecycle_goal, metadata, source, occurred_at, created_at, updated_at, subscription_id, reason)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
             ?23, ?24, ?25, ?26, ?26, ?27, ?28)
           ON CONFLICT (site_id, provider, provider_txn_id) DO NOTHING`,
        )
        .bind(
          site.id,
          id,
          provider,
          p.providerTxnId,
          p.providerCustomerId ?? null,
          p.eventId ?? null,
          kind,
          p.amountMinor,
          p.currency,
          conv.reportingMinor,
          siteCurrency,
          conv.fxRate,
          a.visitorId,
          a.first,
          a.last,
          a.lastNonDirect,
          a.via,
          site.storeCustomerEmails ? email : null,
          site.storeCustomerEmails ? (p.name ?? null) : null,
          hash,
          kind === "refund" ? (original?.provider_txn_id ?? p.refundOf?.[0] ?? null) : null,
          goal,
          Object.keys(metadata).length ? JSON.stringify(metadata) : null,
          options.source,
          p.occurredAt,
          now,
          p.subscriptionId ?? null,
          kind === "refund" ? (p.reason ?? "refund") : null,
        ),
    );
    const row: PaymentRow = {
      id,
      provider_txn_id: p.providerTxnId,
      provider_customer_id: p.providerCustomerId ?? null,
      kind,
      amount_minor: p.amountMinor,
      currency: p.currency,
      reporting_minor: conv.reportingMinor,
      visitor_id: a.visitorId,
      first_session_id: a.first,
      last_session_id: a.last,
      last_non_direct_session_id: a.lastNonDirect,
      attributed_via: a.via,
      occurred_at: p.occurredAt,
      subscription_id: p.subscriptionId ?? null,
      lifecycle_goal: goal,
    };
    existing.set(p.providerTxnId, row);
    if (goal && a.visitorId) {
      emitGoal(
        a,
        goal,
        p.occurredAt,
        paymentProps({
          provider_txn_id: p.providerTxnId,
          amount: p.amountMinor,
          currency: p.currency,
          subscription_id: p.subscriptionId ?? null,
          kind,
        }),
      );
    }
    if (a.visitorId) mapCustomer(p.providerCustomerId, a.visitorId);

    // Subscription bookkeeping for paid charges.
    if (p.subscriptionId && p.amountMinor > 0 && (kind === "payment" || kind === "renewal")) {
      const base: StoredSubscription = sub ?? {
        status: "incomplete",
        mrrMinor: null,
        currency: p.currency,
        cancelAtPeriodEnd: false,
        hadTrial: false,
        firstPaidAt: null,
        lastPaidMinor: null,
        customerId: p.providerCustomerId ?? null,
        visitorId: a.visitorId,
        startedAt: p.occurredAt,
      };
      if (
        options.planChangesFromRenewals &&
        emitLifecycle &&
        kind === "renewal" &&
        base.lastPaidMinor !== null &&
        base.lastPaidMinor !== p.amountMinor &&
        a.visitorId
      ) {
        emitGoal(
          a,
          p.amountMinor > base.lastPaidMinor ? "subscription_upgraded" : "subscription_downgraded",
          p.occurredAt,
          { type: "subscription_lifecycle", subscription_id: p.subscriptionId },
        );
      }
      storeSub(p.subscriptionId, {
        ...base,
        firstPaidAt: base.firstPaidAt ?? p.occurredAt,
        lastPaidMinor: p.amountMinor,
        visitorId: base.visitorId ?? a.visitorId,
      });
    }
    outcomeByTxn.set(p.providerTxnId, {
      txnId: p.providerTxnId,
      status: "inserted",
      kind,
      attributedVia: a.via,
      visitorId: a.visitorId,
      unknownVisitor,
    });
  }

  for (const [id, s] of dirtySubs) {
    writes.push(
      db
        .prepare(
          `INSERT INTO provider_subscriptions (site_id, provider, subscription_id, customer_id, visitor_id, status, mrr_minor,
             currency, cancel_at_period_end, had_trial, first_paid_at, last_paid_minor, started_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
           ON CONFLICT (site_id, provider, subscription_id) DO UPDATE SET customer_id = excluded.customer_id,
             visitor_id = excluded.visitor_id, status = excluded.status, mrr_minor = excluded.mrr_minor,
             currency = excluded.currency, cancel_at_period_end = excluded.cancel_at_period_end,
             had_trial = excluded.had_trial, first_paid_at = excluded.first_paid_at,
             last_paid_minor = excluded.last_paid_minor, started_at = excluded.started_at,
             updated_at = excluded.updated_at`,
        )
        .bind(
          site.id,
          provider,
          id,
          s.customerId,
          s.visitorId,
          s.status,
          s.mrrMinor,
          s.currency,
          s.cancelAtPeriodEnd ? 1 : 0,
          s.hadTrial ? 1 : 0,
          s.firstPaidAt,
          s.lastPaidMinor,
          s.startedAt,
          now,
        ),
    );
  }

  for (const ref of usedHints) {
    if (options.hint && ref === options.hint.ref) continue; // the resolver marks its own hint
    writes.push(
      db
        .prepare(
          "UPDATE payment_hints SET resolved_at = ?, last_error = NULL WHERE site_id = ? AND provider = ? AND ref = ? AND resolved_at IS NULL",
        )
        .bind(now, site.id, provider, ref),
    );
  }

  if (writes.length) await runBatch(db, writes);

  for (const p of payments) {
    const o = outcomeByTxn.get(p.providerTxnId);
    if (o && !outcomes.includes(o)) outcomes.push(o);
  }
  return { payments: outcomes, goals, statements: writes.length };
}

/** Narrowing helpers re-exported for adapters. */
export type { CustomerLink, NormalizedSubscription };
