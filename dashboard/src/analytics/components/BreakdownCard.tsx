/**
 * Breakdown card with tabs (Source, Pages, Location, System, Goals). Every row shows visitors,
 * revenue and payments (exit links: visitors and clicks) and adds a filter when clicked. With a
 * goal as #1 KPI, the card can show that goal's converting visitors per row instead of revenue.
 */
import { lazy, type ReactNode, Suspense, useMemo, useState } from "react";
import type { CountryRow } from "../../../../shared/api-types";
import { cx } from "../../components/ui";
import { type ActiveFilter, upsertFilter } from "../lib/filters";
import { formatMoney, formatNumber } from "../lib/format";
import { readPref, writePref } from "../lib/storage";
import { showRevenue, useAnalytics, useSource } from "../source";
import type { DashboardState } from "../state";
import { Dialog, EmptyState, ErrorState, Segmented, Skeleton, Tabs } from "./primitives";

const WorldMap = lazy(() => import("./WorldMap"));

export type Row = Record<string, unknown> & {
  visitors?: number;
  revenue?: number;
  payments?: number;
  clicks?: number;
};

export interface TabVariant {
  id: string;
  label: string;
}

export interface BreakdownTab {
  id: string;
  label: string;
  endpoint: string;
  /** Filter dimension added on click (none: rows are not filterable). */
  filterKey?: string | ((variant: string) => string);
  /** The row's value: its label and the filter value. */
  value: (row: Row, variant: string) => string;
  icon?: (row: Row) => ReactNode;
  /** External link for the row (pages, exit links). */
  href?: (row: Row) => string | null;
  /** Exit links: clicks instead of revenue/payments. */
  clicks?: boolean;
  variants?: readonly TabVariant[];
  extraParams?: (variant: string) => Record<string, string>;
  /** Render a map instead of the list (Location → Map). */
  map?: boolean;
  /** Rows with an empty value are dropped and identical values merged (campaign dimensions). */
  group?: boolean;
  /** Show a share-of-visitors donut above the list (channels). */
  donut?: boolean;
  /** After filtering on a row, switch the card to this tab (channel → its referrers). */
  drillTo?: string;
}

const DONUT_COLORS = [
  "var(--dg-secondary)",
  "var(--dg-revenue)",
  "var(--dg-accent)",
  "var(--dg-info)",
  "var(--dg-warning)",
  "var(--dg-success)",
  "var(--dg-muted)",
];

/** Share of visitors per row as a donut (DataFast's channel pie); a click filters like the row. */
export function ShareDonut({
  rows,
  label,
  value,
  onPick,
}: {
  rows: Row[];
  label: string;
  value: (row: Row) => string;
  onPick?: (value: string) => void;
}) {
  const total = rows.reduce((s, r) => s + (r.visitors ?? 0), 0);
  if (!total) return null;
  const R = 42;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const slices = rows.slice(0, DONUT_COLORS.length).map((r, i) => {
    const share = (r.visitors ?? 0) / total;
    const slice = { v: value(r), share, offset, color: DONUT_COLORS[i] as string };
    offset += share;
    return slice;
  });
  return (
    <figure className="mb-3 flex items-center gap-4" aria-label={`${label} share of visitors`}>
      <svg viewBox="0 0 100 100" className="size-24 shrink-0 -rotate-90" aria-hidden="true">
        {slices.map((s) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: pointer shortcut; the list below is the accessible control
          <circle
            key={s.v}
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke={s.color}
            strokeWidth="14"
            strokeDasharray={`${Math.max(0, s.share * C - 1)} ${C}`}
            strokeDashoffset={-s.offset * C}
            onClick={onPick ? () => onPick(s.v) : undefined}
            style={onPick ? { cursor: "pointer" } : undefined}
          >
            <title>{`${s.v}: ${Math.round(s.share * 100)}%`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="grid min-w-0 flex-1 grid-cols-1 gap-0.5 text-xs sm:grid-cols-2">
        {slices.map((s) => (
          <span key={s.v} className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full"
              style={{ background: s.color }}
            />
            <span className="truncate">{s.v || "(none)"}</span>
            <span className="ml-auto text-muted tabular-nums">{Math.round(s.share * 100)}%</span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

function groupRows(rows: Row[], tab: BreakdownTab, variant: string): Row[] {
  if (!tab.group) return rows;
  const map = new Map<string, Row>();
  for (const r of rows) {
    const v = tab.value(r, variant);
    if (!v) continue;
    const cur = map.get(v);
    if (cur) {
      cur.visitors = (cur.visitors ?? 0) + (r.visitors ?? 0);
      cur.revenue = (cur.revenue ?? 0) + (r.revenue ?? 0);
      cur.payments = (cur.payments ?? 0) + (r.payments ?? 0);
    } else map.set(v, { ...r });
  }
  return [...map.values()].sort((a, b) => (b.visitors ?? 0) - (a.visitors ?? 0));
}

function useRows(
  tab: BreakdownTab,
  variant: string,
  state: DashboardState,
  limit: number,
  offset = 0,
  extraFilter?: Record<string, string>,
  enabled = true,
) {
  const params = {
    ...state.rangeParams,
    ...state.filterParams,
    ...(extraFilter ?? {}),
    ...(tab.extraParams?.(variant) ?? {}),
    limit,
    offset,
  };
  const q = useAnalytics<Row[]>(tab.endpoint, params, { keepPrevious: false, enabled });
  const rows = useMemo(() => groupRows(q.data?.data ?? [], tab, variant), [q.data, tab, variant]);
  return { q, rows, hasMore: Boolean(q.data?.pagination?.hasMore) };
}

function RowList({
  rows,
  tab,
  variant,
  state,
  money,
  currency,
  kpiCounts,
  kpiLabel,
  onPicked,
}: {
  rows: Row[];
  tab: BreakdownTab;
  variant: string;
  state: DashboardState;
  money: boolean;
  currency: string;
  kpiCounts?: Map<string, number> | null;
  kpiLabel?: string;
  onPicked?: () => void;
}) {
  const max = Math.max(1, ...rows.map((r) => r.visitors ?? 0));
  const filterKey = typeof tab.filterKey === "function" ? tab.filterKey(variant) : tab.filterKey;
  const pick = (value: string) => {
    if (!filterKey) return;
    const f: ActiveFilter = { key: filterKey, op: "is", values: [value] };
    state.setFilters(upsertFilter(state.filters, f));
    onPicked?.();
  };
  const third = tab.clicks ? "Clicks" : kpiCounts ? kpiLabel : money ? "Revenue" : null;
  return (
    <div>
      <div className="flex items-center gap-2 px-2 pb-1 text-xs text-muted" aria-hidden="true">
        <span className="flex-1">{tab.label}</span>
        <span className="w-16 text-right">Visitors</span>
        {third ? <span className="w-20 text-right">{third}</span> : null}
        {!tab.clicks && money && !kpiCounts ? (
          <span className="hidden w-14 text-right sm:inline">Payments</span>
        ) : null}
      </div>
      <ul className="space-y-0.5">
        {rows.map((r) => {
          const value = tab.value(r, variant);
          const label = value || "(none)";
          const pct = ((r.visitors ?? 0) / max) * 100;
          const href = tab.href?.(r);
          const metrics = (
            <>
              <span className="w-16 text-right tabular-nums">{formatNumber(r.visitors)}</span>
              {tab.clicks ? (
                <span className="w-20 text-right tabular-nums">{formatNumber(r.clicks)}</span>
              ) : kpiCounts ? (
                <span className="w-20 text-right tabular-nums text-primary-text">
                  {formatNumber(kpiCounts.get(value) ?? 0)}
                </span>
              ) : money ? (
                <span className="w-20 text-right tabular-nums text-primary-text">
                  {formatMoney(r.revenue ?? 0, currency)}
                </span>
              ) : null}
              {!tab.clicks && money && !kpiCounts ? (
                <span className="hidden w-14 text-right tabular-nums text-muted sm:inline">
                  {formatNumber(r.payments ?? 0)}
                </span>
              ) : null}
            </>
          );
          const aria = `${label}: ${formatNumber(r.visitors)} visitors${
            tab.clicks
              ? `, ${formatNumber(r.clicks)} clicks`
              : money
                ? `, ${formatMoney(r.revenue ?? 0, currency)} revenue, ${formatNumber(r.payments ?? 0)} payments`
                : ""
          }`;
          const inner = (
            <>
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 rounded bg-visitors/15"
                style={{ width: `${pct}%` }}
              />
              <span className="relative flex min-w-0 flex-1 items-center gap-2">
                {tab.icon ? <span className="shrink-0">{tab.icon(r)}</span> : null}
                <span className="truncate">{label}</span>
              </span>
              <span className="relative flex items-center gap-2 text-sm">{metrics}</span>
            </>
          );
          return (
            <li
              key={`${value}-${String(r.hostname ?? "")}`}
              className="group flex items-center gap-1"
            >
              {filterKey ? (
                <button
                  type="button"
                  onClick={() => pick(value)}
                  aria-label={`Filter by ${label}. ${aria}`}
                  title={`Filter by ${label}`}
                  className="relative flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                >
                  {inner}
                </button>
              ) : (
                <div
                  className="relative flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded px-2 py-1.5 text-sm"
                  title={aria}
                >
                  {inner}
                </div>
              )}
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${label} in a new tab`}
                  className="rounded p-1 text-muted opacity-60 hover:bg-surface-2 hover:text-text group-hover:opacity-100"
                >
                  ↗
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type DetailsSort = "visitors" | "revenue" | "clicks" | "name";

/** Details ordering (DataFast: sort by name, revenue or traffic); the API sorts by visitors. */
export function sortRows(
  rows: Row[],
  sort: DetailsSort,
  tab: BreakdownTab,
  variant: string,
): Row[] {
  if (sort === "visitors") return rows;
  const out = [...rows];
  if (sort === "name") {
    out.sort((a, b) => tab.value(a, variant).localeCompare(tab.value(b, variant)));
  } else {
    const key = sort === "revenue" ? "revenue" : "clicks";
    out.sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0) || (b.visitors ?? 0) - (a.visitors ?? 0));
  }
  return out;
}

function DetailsDialog({
  open,
  onClose,
  title,
  tab,
  variant,
  state,
  money,
  currency,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  tab: BreakdownTab;
  variant: string;
  state: DashboardState;
  money: boolean;
  currency: string;
}) {
  const [limit, setLimit] = useState(100);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<DetailsSort>("visitors");
  const { q: query, rows, hasMore } = useRows(tab, variant, state, limit, 0, undefined, open);
  const filtered = q
    ? rows.filter((r) => tab.value(r, variant).toLowerCase().includes(q.toLowerCase()))
    : rows;
  const shown = sortRows(filtered, sort, tab, variant);
  const sorts: Array<[DetailsSort, string]> = [
    ["visitors", "Visitors"],
    ...(tab.clicks
      ? ([["clicks", "Clicks"]] as Array<[DetailsSort, string]>)
      : money
        ? ([["revenue", "Revenue"]] as Array<[DetailsSort, string]>)
        : []),
    ["name", "Name"],
  ];
  return (
    <Dialog open={open} onClose={onClose} title={title} wide>
      <div className="mb-3 flex flex-wrap gap-2">
        <input
          aria-label={`Search ${tab.label.toLowerCase()}`}
          placeholder="Search"
          value={q}
          data-autofocus
          onChange={(e) => setQ(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm"
        />
        <select
          aria-label="Sort by"
          value={sort}
          onChange={(e) => setSort(e.target.value as DetailsSort)}
          className="rounded-md border border-line bg-surface px-2 py-2 text-sm"
        >
          {sorts.map(([id, label]) => (
            <option key={id} value={id}>
              Sort by {label.toLowerCase()}
            </option>
          ))}
        </select>
      </div>
      {query.isPending ? (
        <Skeleton className="h-40" />
      ) : query.error ? (
        <ErrorState error={query.error} />
      ) : shown.length ? (
        <RowList
          rows={shown}
          tab={tab}
          variant={variant}
          state={state}
          money={money}
          currency={currency}
          onPicked={onClose}
        />
      ) : (
        <EmptyState>No matching rows.</EmptyState>
      )}
      {hasMore ? (
        <button
          type="button"
          onClick={() => setLimit((l) => Math.min(1000, l + 100))}
          className="mt-3 w-full rounded-md border border-line py-2 text-sm hover:bg-surface-2"
        >
          Load more
        </button>
      ) : null}
    </Dialog>
  );
}

export function BreakdownCard({
  id,
  title,
  tabs,
  state,
  kpiGoal,
  className,
}: {
  id: string;
  title: string;
  tabs: readonly BreakdownTab[];
  state: DashboardState;
  kpiGoal?: { name: string; label: string } | null;
  className?: string;
}) {
  const source = useSource();
  const money = showRevenue(source);
  const [tabId, setTabId] = useState(() => {
    const saved = readPref<string>(`card:${id}`, "");
    return tabs.some((t) => t.id === saved) ? saved : (tabs[0]?.id ?? "");
  });
  const tab = tabs.find((t) => t.id === tabId) ?? (tabs[0] as BreakdownTab);
  const [variant, setVariant] = useState(tab.variants?.[0]?.id ?? "");
  const activeVariant = tab.variants?.some((v) => v.id === variant)
    ? variant
    : (tab.variants?.[0]?.id ?? "");
  const [show, setShow] = useState<"revenue" | "kpi">("revenue");
  const [details, setDetails] = useState(false);
  const goalFilterActive = state.filters.some((f) => f.key === "goal");
  const kpiMode = Boolean(kpiGoal) && show === "kpi" && !tab.clicks && !tab.map;
  const { q, rows } = useRows(tab, activeVariant, state, tab.map ? 250 : 10);
  const kpiQuery = useRows(
    tab,
    activeVariant,
    state,
    tab.map ? 250 : 10,
    0,
    kpiGoal && !goalFilterActive ? { filter_goal: `is:${kpiGoal.name}` } : undefined,
    kpiMode,
  );
  const kpiCounts = useMemo(() => {
    if (!kpiMode) return null;
    if (goalFilterActive)
      return new Map(rows.map((r) => [tab.value(r, activeVariant), r.visitors ?? 0]));
    return new Map(kpiQuery.rows.map((r) => [tab.value(r, activeVariant), r.visitors ?? 0]));
  }, [kpiMode, goalFilterActive, rows, kpiQuery.rows, tab, activeVariant]);

  const changeTab = (t: string) => {
    setTabId(t);
    writePref(`card:${id}`, t);
  };
  const filterKey =
    typeof tab.filterKey === "function" ? tab.filterKey(activeVariant) : tab.filterKey;

  return (
    <section
      className={cx(
        "flex min-w-0 flex-col rounded-lg border border-line bg-surface p-4",
        className,
      )}
      aria-labelledby={`${id}-title`}
      data-testid={`card-${id}`}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-sm font-semibold">
          {title}
        </h2>
        {kpiGoal && money ? (
          <Segmented
            label={`${title} metric`}
            value={show}
            onChange={setShow}
            options={[
              { value: "revenue", label: "Revenue" },
              { value: "kpi", label: kpiGoal.label },
            ]}
          />
        ) : null}
      </div>
      {tabs.length > 1 ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Tabs tabs={tabs} value={tab.id} onChange={changeTab} label={title} idPrefix={id} />
          {tab.variants ? (
            <select
              aria-label="Campaign dimension"
              value={activeVariant}
              onChange={(e) => setVariant(e.target.value)}
              className="ml-auto rounded-md border border-line bg-surface px-2 py-1 text-xs"
            >
              {tab.variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}
      <div
        id={`${id}-panel`}
        {...(tabs.length > 1 ? { role: "tabpanel", "aria-labelledby": `${id}-tab-${tab.id}` } : {})}
        className="min-h-[18rem] flex-1"
      >
        {q.isPending ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
              <Skeleton key={i} className="h-7" />
            ))}
          </div>
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : !rows.length ? (
          <EmptyState>No data for this period.</EmptyState>
        ) : tab.map ? (
          <Suspense fallback={<Skeleton className="h-64" />}>
            <WorldMap
              rows={rows as unknown as CountryRow[]}
              currency={source.currency}
              money={money}
              onPick={
                filterKey
                  ? (country) =>
                      state.setFilters(
                        upsertFilter(state.filters, {
                          key: filterKey,
                          op: "is",
                          values: [country],
                        }),
                      )
                  : undefined
              }
            />
          </Suspense>
        ) : (
          <>
            {tab.donut ? (
              <ShareDonut
                rows={rows}
                label={tab.label}
                value={(r) => tab.value(r, activeVariant)}
                onPick={
                  filterKey
                    ? (v) => {
                        state.setFilters(
                          upsertFilter(state.filters, { key: filterKey, op: "is", values: [v] }),
                        );
                        if (tab.drillTo) changeTab(tab.drillTo);
                      }
                    : undefined
                }
              />
            ) : null}
            <RowList
              rows={rows}
              tab={tab}
              variant={activeVariant}
              state={state}
              money={money}
              currency={source.currency}
              kpiCounts={kpiCounts}
              kpiLabel={kpiGoal?.label}
              onPicked={tab.drillTo ? () => changeTab(tab.drillTo as string) : undefined}
            />
          </>
        )}
      </div>
      {!tab.map && rows.length ? (
        <button
          type="button"
          onClick={() => setDetails(true)}
          className="mt-2 self-start rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text"
        >
          Details
        </button>
      ) : null}
      {details ? (
        <DetailsDialog
          open={details}
          onClose={() => setDetails(false)}
          title={`${title}: ${tab.label}`}
          tab={tab}
          variant={activeVariant}
          state={state}
          money={money}
          currency={source.currency}
        />
      ) : null}
    </section>
  );
}
