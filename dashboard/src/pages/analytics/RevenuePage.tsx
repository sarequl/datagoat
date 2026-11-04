/**
 * Revenue: totals (new, renewal, refunds), attribution coverage by method, revenue by channel and
 * by source (click to filter), lifetime value by first channel, path to purchase, and the payments
 * list with each payment's attribution source, including Unattributed and refunds.
 */
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { PaymentRow, RevenueSummary } from "../../../../shared/api-types";
import { sourceTabs } from "../../analytics/cards";
import { BreakdownCard } from "../../analytics/components/BreakdownCard";
import {
  Badge,
  EmptyState,
  ErrorState,
  Skeleton,
  Tabs,
} from "../../analytics/components/primitives";
import { usePayments, useRevenueSummary } from "../../analytics/hooks";
import {
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
} from "../../analytics/lib/format";
import { visitorName } from "../../analytics/lib/names";
import { AnalyticsHeader } from "../../analytics/OverviewDashboard";
import { SiteAnalytics } from "../../analytics/SiteAnalytics";
import { type DashboardState, useDashboardState } from "../../analytics/state";
import { cx } from "../../components/ui";

export const ATTRIBUTION_LABELS: Record<PaymentRow["attributedVia"], string> = {
  metadata: "Checkout metadata",
  link: "Payment link",
  customer: "Returning customer",
  email: "Email match",
  api: "Payment API",
  none: "Unattributed",
};

const CHART = ["var(--dg-secondary)", "var(--dg-revenue)", "var(--dg-accent)", "var(--dg-info)"];

const KIND_LABELS: Record<PaymentRow["kind"], string> = {
  payment: "Payment",
  renewal: "Renewal",
  refund: "Refund",
  free_trial: "Free trial",
};

function Summary({ s }: { s: RevenueSummary }) {
  const tiles: Array<[string, string, string?]> = [
    ["Revenue", formatMoney(s.revenue, s.currency)],
    ["New revenue", formatMoney(s.newRevenue, s.currency)],
    ["Renewals", formatMoney(s.renewalRevenue, s.currency)],
    ["Refunds", formatMoney(s.refunds, s.currency), "error"],
    ["Payments", formatNumber(s.payments)],
    ["Customers", formatNumber(s.customers)],
  ];
  return (
    <dl
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
      data-testid="revenue-summary"
    >
      {tiles.map(([k, v, tone]) => (
        <div key={k} className="rounded-lg border border-line bg-surface p-3">
          <dt className="text-xs text-muted">{k}</dt>
          <dd
            className={cx(
              "text-xl font-semibold tabular-nums",
              tone === "error" && "text-error-text",
            )}
          >
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Attribution({ s }: { s: RevenueSummary }) {
  const methods = (Object.keys(ATTRIBUTION_LABELS) as Array<PaymentRow["attributedVia"]>).map(
    (k) => [k, s.attribution.byMethod[k] ?? 0] as const,
  );
  const total = Math.max(
    1,
    methods.reduce((a, [, v]) => a + v, 0),
  );
  return (
    <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="attr-title">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="attr-title" className="text-sm font-semibold">
          Attribution coverage
        </h2>
        <span className="text-sm">
          <span className="font-semibold tabular-nums">
            {formatPercent(s.attribution.coveragePercentage)}
          </span>{" "}
          <span className="text-muted">of revenue linked to a visitor</span>
        </span>
      </div>
      <div className="flex h-3 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        {methods.map(([k, v], i) => (
          <span
            key={k}
            style={{
              width: `${(v / total) * 100}%`,
              background: k === "none" ? "var(--dg-neutral)" : CHART[i % 4],
            }}
          />
        ))}
      </div>
      <ul className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
        {methods.map(([k, v], i) => (
          <li key={k} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="size-2.5 rounded-sm"
                style={{ background: k === "none" ? "var(--dg-neutral)" : CHART[i % 4] }}
              />
              {ATTRIBUTION_LABELS[k]}
            </span>
            <span className="tabular-nums text-muted">{formatMoney(v, s.currency)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Ltv({ s }: { s: RevenueSummary }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="ltv-title">
      <h2 id="ltv-title" className="mb-3 text-sm font-semibold">
        Lifetime value by first channel
      </h2>
      {s.lifetimeValueByChannel.length ? (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th scope="col" className="pb-1 font-medium">
                First channel
              </th>
              <th scope="col" className="pb-1 text-right font-medium">
                Customers
              </th>
              <th scope="col" className="pb-1 text-right font-medium">
                Revenue
              </th>
              <th scope="col" className="pb-1 text-right font-medium">
                Avg LTV
              </th>
            </tr>
          </thead>
          <tbody>
            {s.lifetimeValueByChannel.map((r) => (
              <tr key={r.channel} className="border-t border-line">
                <th scope="row" className="py-1.5 text-left font-normal">
                  {r.channel}
                </th>
                <td className="py-1.5 text-right tabular-nums">{formatNumber(r.customers)}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatMoney(r.revenue, s.currency)}
                </td>
                <td className="py-1.5 text-right font-medium tabular-nums text-primary-text">
                  {formatMoney(r.averageValue, s.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState>No customers yet.</EmptyState>
      )}
    </section>
  );
}

function PathToPurchase({ s }: { s: RevenueSummary }) {
  const p = s.pathToPurchase;
  return (
    <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="path-title">
      <h2 id="path-title" className="mb-3 text-sm font-semibold">
        Path to purchase
      </h2>
      {!p ? (
        <EmptyState>Path to purchase is not available from this server yet.</EmptyState>
      ) : (
        <>
          <dl className="mb-3 grid grid-cols-3 gap-2 text-center">
            {(
              [
                ["Days to buy", p.averageDaysToPurchase.toFixed(1)],
                ["Sessions", p.averageSessionsToPurchase.toFixed(1)],
                ["Pageviews", p.averagePageviewsToPurchase.toFixed(1)],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="rounded-md bg-surface-2 p-2">
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="text-lg font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          <ol className="space-y-1.5 text-sm" aria-label="Most common paths">
            {p.topPaths.map((t) => (
              <li
                key={t.channels.join(">")}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span className="flex flex-wrap items-center gap-1">
                  {t.channels.map((c, i) => (
                    <span
                      key={t.channels.slice(0, i + 1).join(">")}
                      className="flex items-center gap-1"
                    >
                      {i ? (
                        <span aria-hidden="true" className="text-muted">
                          →
                        </span>
                      ) : null}
                      <span className="rounded border border-line px-1.5 py-0.5 text-xs">{c}</span>
                    </span>
                  ))}
                  <span className="text-xs text-muted">→ 💰</span>
                </span>
                <span className="text-xs tabular-nums text-muted">
                  {formatNumber(t.customers)} customers · {formatMoney(t.revenue, s.currency)}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

const PAYMENT_TABS = [
  { id: "all", label: "All" },
  { id: "unattributed", label: "Unattributed" },
  { id: "refunds", label: "Refunds" },
  { id: "renewals", label: "Renewals" },
];

function Payments({
  siteId,
  state,
  timezone,
}: {
  siteId: string;
  state: DashboardState;
  timezone: string;
}) {
  const [tab, setTab] = useState("all");
  const [offset, setOffset] = useState(0);
  const extra =
    tab === "unattributed"
      ? { attributed: "false" }
      : tab === "refunds"
        ? { kind: "refund" }
        : tab === "renewals"
          ? { kind: "renewal" }
          : {};
  const q = usePayments(siteId, {
    ...state.rangeParams,
    ...state.filterParams,
    ...extra,
    limit: 25,
    offset,
  });
  const rows = q.data?.data ?? [];
  return (
    <section className="rounded-lg border border-line bg-surface" aria-labelledby="payments-title">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
        <h2 id="payments-title" className="text-sm font-semibold">
          Payments
        </h2>
        <Tabs
          tabs={PAYMENT_TABS}
          value={tab}
          onChange={(t) => {
            setTab(t);
            setOffset(0);
          }}
          label="Payment type"
          idPrefix="payments"
        />
      </div>
      <div
        id="payments-panel"
        role="tabpanel"
        aria-labelledby={`payments-tab-${tab}`}
        className="mt-2"
      >
        {q.isPending ? (
          <Skeleton className="m-4 h-40" />
        ) : q.error ? (
          <div className="p-4">
            <ErrorState error={q.error} />
          </div>
        ) : !rows.length ? (
          <EmptyState>No payments here for this period.</EmptyState>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Date
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Customer
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Type
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Amount
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Attribution
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Channel
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Visitor
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-t border-line">
                    <td className="whitespace-nowrap px-4 py-2 text-muted">
                      {formatDateTime(p.timestamp, timezone)}
                    </td>
                    <td className="max-w-48 px-2 py-2">
                      <div className="truncate">{p.customerName ?? p.customerEmail ?? "–"}</div>
                      {p.customerName && p.customerEmail ? (
                        <div className="truncate text-xs text-muted">{p.customerEmail}</div>
                      ) : null}
                    </td>
                    <td className="px-2 py-2">
                      <span className="whitespace-nowrap">{KIND_LABELS[p.kind]}</span>
                      <div className="text-xs text-muted">{p.provider}</div>
                    </td>
                    <td
                      className={cx(
                        "whitespace-nowrap px-2 py-2 text-right tabular-nums",
                        p.amount < 0 ? "text-error-text" : "",
                      )}
                    >
                      {formatMoney(p.amount, p.currency, { cents: true })}
                      {p.originalCurrency !== p.currency ? (
                        <div className="text-xs text-muted">
                          {formatMoney(p.originalAmount, p.originalCurrency, { cents: true })}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-2 py-2">
                      <Badge tone={p.attributedVia === "none" ? "warning" : "neutral"}>
                        {ATTRIBUTION_LABELS[p.attributedVia]}
                      </Badge>
                    </td>
                    <td className="px-2 py-2">{p.channel ?? "–"}</td>
                    <td className="px-4 py-2">
                      {p.visitorId ? (
                        <Link
                          to="/app/$siteId/visitors/$visitorId"
                          params={{ siteId, visitorId: p.visitorId }}
                          className="text-primary-text hover:underline"
                        >
                          {visitorName(p.visitorId)}
                        </Link>
                      ) : (
                        <span className="text-muted">–</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <nav aria-label="Payments pagination" className="flex justify-end gap-2 p-4 text-sm">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => setOffset((o) => Math.max(0, o - 25))}
          className="rounded-md border border-line px-3 py-1.5 hover:bg-surface-2 disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!q.data?.pagination?.hasMore}
          onClick={() => setOffset((o) => o + 25)}
          className="rounded-md border border-line px-3 py-1.5 hover:bg-surface-2 disabled:opacity-40"
        >
          Next
        </button>
      </nav>
    </section>
  );
}

function Revenue({ siteId, timezone }: { siteId: string; timezone: string }) {
  const state = useDashboardState();
  const summary = useRevenueSummary(siteId, { ...state.rangeParams, ...state.filterParams });
  const s = summary.data;
  const tabs = sourceTabs();
  return (
    <div className="space-y-4">
      <AnalyticsHeader title="Revenue" state={state} />
      {summary.isPending ? (
        <Skeleton className="h-24" />
      ) : summary.error ? (
        <ErrorState error={summary.error} />
      ) : s ? (
        <Summary s={s} />
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <BreakdownCard
          id="revenue-channel"
          title="Revenue by channel"
          tabs={tabs.filter((t) => t.id === "channel")}
          state={state}
        />
        <BreakdownCard
          id="revenue-source"
          title="Revenue by source"
          tabs={tabs.filter((t) => t.id !== "channel")}
          state={state}
        />
        {s ? <Attribution s={s} /> : null}
        {s ? <PathToPurchase s={s} /> : null}
        {s ? <Ltv s={s} /> : null}
      </div>
      <Payments siteId={siteId} state={state} timezone={timezone} />
      <p className="text-xs text-muted">
        Connect Stripe, Lemon Squeezy, Polar and more in{" "}
        <Link
          to="/app/$siteId/integrations"
          params={{ siteId }}
          className="text-primary-text hover:underline"
        >
          Integrations
        </Link>
        , or send payments with <code>POST /api/v1/payments</code>.
      </p>
    </div>
  );
}

export default function RevenuePage() {
  return (
    <SiteAnalytics>
      {(site) => <Revenue siteId={site._id} timezone={site.timezone} />}
    </SiteAnalytics>
  );
}
