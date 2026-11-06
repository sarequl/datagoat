/**
 * The website overview (DataFast's main dashboard): period selector, filters, KPI row, main
 * chart with markers, breakdown cards, goals and the activity heatmap. Used signed in
 * (`/app/:siteId/overview`) and read-only on public share links (`/share/:token`).
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { GoalRow, Note, Overview, TimeseriesPoint } from "../../../shared/api-types";
import { Button, cx } from "../components/ui";
import { adsTab, locationTabs, pageTabs, sourceTabs, systemTabs } from "./cards";
import { ActivityHeatmap } from "./components/ActivityHeatmap";
import { BreakdownCard } from "./components/BreakdownCard";
import { FilterBar } from "./components/FilterBar";
import { type ExtraTile, KpiRow } from "./components/KpiRow";
import { type ChartMarker, MainChart } from "./components/MainChart";
import { PeriodSelector } from "./components/PeriodSelector";
import { EmptyState, ErrorState, Segmented, Skeleton } from "./components/primitives";
import {
  useAdsSummary,
  useCommits,
  useGoalCustomizations,
  useMentions,
  useMrr,
  useNoteMutations,
  useNotes,
  useRealtimeCount,
  useSearchConsoleConnected,
} from "./hooks";
import { kpiColor } from "./lib/colors";
import { upsertFilter } from "./lib/filters";
import { formatDateTime, formatMoney, formatNumber, formatPercent } from "./lib/format";
import { INTERVAL_LABELS } from "./lib/period";
import { isTypingTarget, readPref, writePref } from "./lib/storage";
import { addDays, endOfMonth, ymdInTz } from "./lib/tz";
import { OverviewHub } from "./OverviewHub";
import { showRevenue, sourceKey, useAnalytics, useSource } from "./source";
import { type DashboardState, rangeToParams, useDashboardState } from "./state";

export const TIMESERIES_FIELDS =
  "visitors,new_visitors,returning_visitors,pageviews,sessions,revenue,payments,conversion_rate,bounce_rate,avg_session_duration,refunds";

/** Header row shared by the analytics pages: title, period and filters. */
export function AnalyticsHeader({
  title,
  state,
  segments = true,
  actions,
  logo,
}: {
  title: ReactNode;
  state: DashboardState;
  segments?: boolean;
  actions?: ReactNode;
  logo?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex min-w-0 items-center gap-2 text-xl font-semibold">
          {logo}
          <span className="truncate">{title}</span>
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <PeriodSelector state={state} />
        </div>
      </div>
      <FilterBar state={state} segments={segments} />
    </div>
  );
}

function GoalsCard({ state, siteId }: { state: DashboardState; siteId?: string }) {
  const source = useSource();
  const money = showRevenue(source);
  const q = useAnalytics<GoalRow[]>(
    "goals",
    { ...state.rangeParams, ...state.filterParams, limit: 10 },
    { keepPrevious: false },
  );
  const custom = useGoalCustomizations(siteId ?? "", Boolean(siteId));
  const byName = new Map((custom.data?.items ?? []).map((c) => [c.goalName, c]));
  const rows = (q.data?.data ?? []).filter((g) => !byName.get(g.goal)?.hidden);
  const max = Math.max(1, ...rows.map((r) => r.visitors));
  return (
    <section
      className="flex min-w-0 flex-col rounded-lg border border-line bg-surface p-4"
      aria-labelledby="goals-card-title"
      data-testid="card-goals"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 id="goals-card-title" className="text-sm font-semibold">
          Goals
        </h2>
        {siteId ? (
          <Link
            to="/app/$siteId/goals"
            params={{ siteId }}
            className="text-xs text-muted hover:text-text"
          >
            All goals →
          </Link>
        ) : null}
      </div>
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : !rows.length ? (
        <EmptyState>No goals completed in this period.</EmptyState>
      ) : (
        <>
          <div className="flex gap-2 px-2 pb-1 text-xs text-muted" aria-hidden="true">
            <span className="flex-1">Goal</span>
            <span className="w-14 text-right">Visitors</span>
            <span className="w-14 text-right">Conv.</span>
            {money ? <span className="w-20 text-right">Revenue</span> : null}
          </div>
          <ul className="space-y-0.5">
            {rows.map((g) => {
              const c = byName.get(g.goal);
              const label = c?.displayName || g.goal;
              return (
                <li key={g.goal}>
                  <button
                    type="button"
                    onClick={() =>
                      state.setFilters(
                        upsertFilter(state.filters, { key: "goal", op: "is", values: [g.goal] }),
                      )
                    }
                    aria-label={`Filter by goal ${label}: ${formatNumber(g.completions)} completions, ${formatNumber(g.visitors)} visitors`}
                    className="relative flex w-full items-center gap-2 overflow-hidden rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                  >
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 rounded bg-visitors/15"
                      style={{ width: `${(g.visitors / max) * 100}%` }}
                    />
                    <span className="relative flex min-w-0 flex-1 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ background: c?.color ?? "var(--dg-secondary)" }}
                      />
                      <span className="truncate">{label}</span>
                      <span className="text-xs text-muted">{formatNumber(g.completions)}×</span>
                    </span>
                    <span className="relative w-14 text-right tabular-nums">
                      {formatNumber(g.visitors)}
                    </span>
                    <span className="relative w-14 text-right tabular-nums text-muted">
                      {g.conversion_rate !== undefined ? formatPercent(g.conversion_rate) : "–"}
                    </span>
                    {money ? (
                      <span className="relative w-20 text-right tabular-nums text-primary-text">
                        {formatMoney(g.revenue ?? 0, source.currency)}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function MarkerList({
  items,
  siteId,
  canWrite,
  timezone,
  close,
}: {
  items: ChartMarker[];
  siteId: string;
  canWrite: boolean;
  timezone: string;
  close: () => void;
}) {
  const m = useNoteMutations(siteId);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  return (
    <ul className="space-y-3">
      {items.map((it) => (
        <li key={it.id} className="rounded-md border border-line p-3 text-sm">
          <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted">
            <span>
              {it.kind === "note" ? "Note" : it.kind === "commit" ? "GitHub commit" : "𝕏 mention"} ·{" "}
              {formatDateTime(it.ts, timezone)}
            </span>
            {it.url ? (
              <a
                href={it.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary-text hover:underline"
              >
                Open ↗
              </a>
            ) : null}
          </div>
          {editing === it.id ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                m.update.mutate(
                  { id: it.id.replace(/^note:/, ""), text: text.trim() },
                  { onSuccess: () => setEditing(null) },
                );
              }}
            >
              <textarea
                aria-label="Note text"
                value={text}
                maxLength={500}
                onChange={(e) => setText(e.target.value)}
                className="w-full rounded-md border border-line bg-surface px-2 py-1"
              />
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!text.trim()}>
                  Save
                </Button>
              </div>
            </form>
          ) : (
            <p className="whitespace-pre-wrap">{it.title}</p>
          )}
          {it.detail ? <p className="mt-1 text-xs text-muted">{it.detail}</p> : null}
          {it.kind === "note" && canWrite && editing !== it.id ? (
            <div className="mt-2 flex gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(it.id);
                  setText(it.title);
                }}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  m.remove.mutate(it.id.replace(/^note:/, ""), {
                    onSuccess: () => (items.length === 1 ? close() : undefined),
                  })
                }
              >
                Delete
              </Button>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

type MarkerKinds = { notes: boolean; commits: boolean; mentions: boolean };

export function OverviewDashboard({
  title,
  logo,
  siteId,
  domain,
  kpi,
  kpiColorScheme,
}: {
  title: ReactNode;
  logo?: ReactNode;
  siteId?: string;
  domain?: string;
  kpi?: string | null;
  kpiColorScheme?: string | null;
}) {
  const source = useSource();
  const state = useDashboardState();
  const navigate = useNavigate();
  const money = showRevenue(source);
  const live = state.range.live;
  const refetchInterval = live ? 60_000 : false;
  const base = { ...state.rangeParams, ...state.filterParams };

  const overview = useAnalytics<Overview[]>("overview", base, { refetchInterval });
  const prevOverview = useAnalytics<Overview[]>(
    "overview",
    { ...(state.prevParams ?? {}), ...state.filterParams },
    { enabled: Boolean(state.prevParams) },
  );
  const tsParams = { ...base, interval: state.interval, fields: TIMESERIES_FIELDS, limit: 1000 };
  const ts = useAnalytics<TimeseriesPoint[]>("timeseries", tsParams, { refetchInterval });
  const wantPrev =
    Boolean(state.prevParams) &&
    (state.compare || Boolean(state.metric && state.metric !== "visitors"));
  const prevTs = useAnalytics<TimeseriesPoint[]>(
    "timeseries",
    {
      ...(state.prevParams ?? {}),
      ...state.filterParams,
      interval: state.interval,
      fields: TIMESERIES_FIELDS,
      limit: 1000,
    },
    { enabled: wantPrev },
  );

  // Heatmap: hourly buckets for the period, capped to its last 41 days (≤ 1000 hourly points).
  const heatParams = useMemo(() => {
    const today = ymdInTz(state.now, state.timezone);
    if (state.range.kind === "instant") return { ...state.rangeParams };
    const end = state.range.endDay ?? today;
    const start =
      state.range.startDay && state.range.days <= 41 ? state.range.startDay : addDays(end, -40);
    return { timezone: state.timezone, startAt: start, endAt: end };
  }, [state.range, state.rangeParams, state.now, state.timezone]);
  const heatCapped =
    state.range.kind !== "instant" && (state.range.kind === "all" || state.range.days > 41);
  const heat = useAnalytics<TimeseriesPoint[]>("timeseries", {
    ...heatParams,
    ...state.filterParams,
    interval: "hour",
    fields: "visitors,pageviews",
    limit: 1000,
  });

  const kpiGoalName = kpi && kpi !== "revenue" ? kpi : null;
  const goals = useAnalytics<GoalRow[]>(
    "goals",
    { ...base, limit: 100 },
    { enabled: Boolean(kpiGoalName) },
  );
  const prevGoals = useAnalytics<GoalRow[]>(
    "goals",
    { ...(state.prevParams ?? {}), ...state.filterParams, limit: 100 },
    { enabled: Boolean(kpiGoalName && state.prevParams) },
  );
  const custom = useGoalCustomizations(siteId ?? "", Boolean(siteId && kpiGoalName));
  const kpiLabel = kpiGoalName
    ? (custom.data?.items.find((c) => c.goalName === kpiGoalName)?.displayName ?? kpiGoalName)
    : null;

  const [markerKinds, setMarkerKinds] = useState<MarkerKinds>(() =>
    readPref<MarkerKinds>(`markers:${sourceKey(source)}`, {
      notes: true,
      commits: true,
      mentions: true,
    }),
  );
  const toggleMarker = (k: keyof MarkerKinds) =>
    setMarkerKinds((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      writePref(`markers:${sourceKey(source)}`, next);
      return next;
    });
  const site = source.kind === "site" ? source : null;
  const markerRange = state.range.kind === "all" ? {} : rangeToParams(state.range, state.timezone);
  const notes = useNotes(siteId ?? "", markerRange, Boolean(siteId) && markerKinds.notes);
  // DataFast: focus commit markers on a type such as feat: or fix: (message prefix).
  const [commitPrefix, setCommitPrefix] = useState(() =>
    readPref<string>(`commit-prefix:${sourceKey(source)}`, ""),
  );
  const commits = useCommits(
    siteId ?? "",
    commitPrefix ? { ...markerRange, q: commitPrefix } : markerRange,
    Boolean(siteId) && markerKinds.commits,
  );
  const mentions = useMentions(siteId ?? "", markerRange, Boolean(siteId) && markerKinds.mentions);
  const noteMutations = useNoteMutations(siteId ?? "");
  const liveCount = useRealtimeCount(siteId ?? "", Boolean(siteId));
  // Revenue and growth tiles/tabs for signed-in websites (DataFast: MRR, ROAS, keywords, ad spend).
  const mrr = useMrr(siteId ?? "", Boolean(siteId) && money);
  const adsSummary = useAdsSummary(siteId ?? "", markerRange, Boolean(siteId) && money);
  const gscConnected = useSearchConsoleConnected(siteId ?? "", Boolean(siteId));
  const currencyCode = overview.data?.data?.[0]?.currency ?? source.currency;
  const ads = adsSummary.data && adsSummary.data.campaigns > 0 ? adsSummary.data : null;
  const extras: ExtraTile[] = [];
  if (mrr.data && (mrr.data.activeSubscriptions > 0 || mrr.data.revenueMetric === "mrr")) {
    extras.push({
      key: "mrr",
      label: "MRR",
      value: formatMoney(mrr.data.mrr, mrr.data.currency),
      sub: `${formatNumber(mrr.data.activeSubscriptions)} active subscriptions`,
      lead: mrr.data.revenueMetric === "mrr",
    });
  }
  if (ads) {
    extras.push({
      key: "roas",
      label: "ROAS",
      value: ads.roas === null ? "–" : `${ads.roas.toFixed(2)}x`,
      sub: `${formatMoney(ads.spend, ads.currency)} ad spend · ${formatMoney(ads.revenue, ads.currency)} revenue`,
    });
  }
  const sourceCardTabs = useMemo(
    () =>
      sourceTabs({
        keywords: Boolean(siteId) && gscConnected.data === true,
        ads: ads ? adsTab((n) => formatMoney(n, currencyCode)) : null,
      }),
    [siteId, gscConnected.data, ads, currencyCode],
  );

  const markers: ChartMarker[] = useMemo(() => {
    const out: ChartMarker[] = [];
    if (markerKinds.notes)
      for (const n of (notes.data ?? []) as Note[])
        out.push({
          id: `note:${n.id}`,
          kind: "note",
          ts: Date.parse(n.timestamp),
          title: n.text,
          detail: n.author?.name ? `by ${n.author.name}` : undefined,
        });
    if (markerKinds.commits)
      for (const c of commits.data ?? [])
        out.push({
          id: `commit:${c.sha}`,
          kind: "commit",
          ts: Date.parse(c.timestamp),
          title: c.message,
          detail: `${c.repo}${c.author.login ? ` · @${c.author.login}` : ""}`,
          url: c.url,
        });
    if (markerKinds.mentions)
      for (const m of mentions.data ?? [])
        out.push({
          id: `mention:${m.id}`,
          kind: "mention",
          ts: Date.parse(m.timestamp),
          title: m.text,
          detail: m.author.username ? `@${m.author.username}` : undefined,
          url: m.url,
        });
    return out;
  }, [markerKinds, notes.data, commits.data, mentions.data]);

  useEffect(() => {
    if (!siteId) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e) || e.key.toLowerCase() !== "m" || e.shiftKey) return;
      e.preventDefault();
      void navigate({ to: "/app/$siteId/realtime", params: { siteId } });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [siteId, navigate]);

  const ov = overview.data?.data[0];
  const prevOv = prevOverview.data?.data[0];
  const points = ts.data?.data ?? [];
  const goalRow = goals.data?.data.find((g) => g.goal === kpiGoalName);
  const prevGoalRow = prevGoals.data?.data.find((g) => g.goal === kpiGoalName);
  const mode = state.metric === "visitors" ? "visitors" : (state.metric ?? "default");

  const drill = (p: TimeseriesPoint) => {
    const day = ymdInTz(Date.parse(p.timestamp), state.timezone);
    if (state.interval === "day") state.setPeriod({ key: "custom", from: day, to: day });
    else if (state.interval === "week")
      state.setPeriod({ key: "custom", from: day, to: addDays(day, 6) });
    else if (state.interval === "month")
      state.setPeriod({ key: "custom", from: day, to: endOfMonth(day) });
  };

  const goalsCard = <GoalsCard state={state} siteId={siteId} />;
  const heatmapCard = (
    <section
      className="min-w-0 rounded-lg border border-line bg-surface p-4"
      aria-labelledby="heatmap-title"
      data-testid="card-heatmap"
    >
      <h2 id="heatmap-title" className="mb-2 text-sm font-semibold">
        Visitor activity
      </h2>
      {heat.error ? (
        <ErrorState error={heat.error} />
      ) : heat.isPending ? (
        <Skeleton className="h-48" />
      ) : (
        <ActivityHeatmap
          points={heat.data?.data ?? []}
          timezone={state.timezone}
          note={heatCapped ? "last 41 days of the period" : undefined}
        />
      )}
    </section>
  );

  return (
    <div className="space-y-4">
      <AnalyticsHeader
        title={title}
        logo={logo}
        state={state}
        segments={source.kind === "site"}
        actions={
          siteId && liveCount.data !== undefined ? (
            <Link
              to="/app/$siteId/realtime"
              params={{ siteId }}
              title="Open the live map (M)"
              data-testid="kpi-live"
              className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-sm text-muted hover:text-text"
            >
              <span
                aria-hidden="true"
                className={cx(
                  "size-2 rounded-full",
                  liveCount.data > 0 ? "animate-pulse bg-success" : "bg-muted",
                )}
              />
              <span className="font-semibold tabular-nums text-text">
                {formatNumber(liveCount.data)}
              </span>
              online now
            </Link>
          ) : null
        }
      />
      {overview.error ? <ErrorState error={overview.error} /> : null}
      {siteId && ov && ov.visitors === 0 && ov.pageviews === 0 ? (
        <section
          aria-labelledby="awaiting-title"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3"
          data-testid="awaiting-visitors"
        >
          <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-warning" />
          <div className="min-w-0 flex-1">
            <h2 id="awaiting-title" className="text-sm font-semibold">
              No visitors in this period yet
            </h2>
            <p className="text-[13px] text-muted">
              Just added this website? Install the tracking script and the first visit shows up here
              within seconds.
            </p>
          </div>
          <Link
            to="/app/$siteId/settings/install"
            params={{ siteId }}
            className="rounded-lg border border-line-strong px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
          >
            Install the script
          </Link>
        </section>
      ) : null}
      <div className="rounded-lg border border-line bg-surface">
        <KpiRow
          overview={ov}
          prevOverview={prevOv}
          points={points}
          currency={ov?.currency ?? source.currency}
          showRevenue={money}
          metric={state.metric}
          onSelect={(metric) => state.update({ metric: metric ?? undefined })}
          compare={state.compare}
          revenueColor={kpiColor(kpiColorScheme)}
          kpiGoal={
            kpiGoalName && ov
              ? {
                  name: kpiGoalName,
                  label: kpiLabel ?? kpiGoalName,
                  visitors: goalRow?.visitors ?? 0,
                  prevVisitors: prevGoalRow?.visitors ?? (state.prevParams ? 0 : null),
                  rate: ov.visitors ? ((goalRow?.visitors ?? 0) / ov.visitors) * 100 : 0,
                }
              : null
          }
          extras={extras}
        />
        <section className="p-4" aria-label="Main chart">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                label="Granularity"
                value={state.interval}
                onChange={(interval) => state.update({ interval })}
                options={state.intervals.map((i) => ({ value: i, label: INTERVAL_LABELS[i] }))}
              />
              <button
                type="button"
                aria-pressed={state.compare}
                disabled={!state.prevParams}
                onClick={() => state.update({ compare: state.compare ? undefined : true })}
                className={cx(
                  "rounded-md border px-2 py-1 text-xs disabled:opacity-40",
                  state.compare
                    ? "border-primary text-primary-text"
                    : "border-line text-muted hover:text-text",
                )}
              >
                Compare
              </button>
              {state.metric ? (
                <button
                  type="button"
                  onClick={() => state.update({ metric: undefined })}
                  className="rounded-md px-2 py-1 text-xs text-muted hover:text-text"
                >
                  ← Visitors / Revenue
                </button>
              ) : null}
            </div>
            {site ? (
              // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons
              <div
                role="group"
                aria-label="Chart markers"
                className="flex items-center gap-1 text-xs"
              >
                {(
                  [
                    ["notes", "📝 Notes"],
                    ["commits", "GitHub"],
                    ["mentions", "𝕏 Mentions"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={markerKinds[k]}
                    onClick={() => toggleMarker(k)}
                    className={cx(
                      "rounded-md border px-2 py-1",
                      markerKinds[k]
                        ? "border-line-strong text-text"
                        : "border-line text-muted line-through",
                    )}
                  >
                    {label}
                  </button>
                ))}
                {markerKinds.commits ? (
                  <select
                    aria-label="Commit type"
                    value={commitPrefix}
                    onChange={(e) => {
                      setCommitPrefix(e.target.value);
                      writePref(`commit-prefix:${sourceKey(source)}`, e.target.value);
                    }}
                    className="rounded-md border border-line bg-surface px-1.5 py-1 text-xs"
                  >
                    <option value="">All commits</option>
                    <option value="feat:">feat:</option>
                    <option value="fix:">fix:</option>
                    <option value="perf:">perf:</option>
                    <option value="refactor:">refactor:</option>
                    <option value="docs:">docs:</option>
                  </select>
                ) : null}
              </div>
            ) : null}
          </div>
          {ts.error ? (
            <ErrorState error={ts.error} />
          ) : ts.isPending ? (
            <Skeleton className="h-64" />
          ) : (
            <MainChart
              points={points}
              prevPoints={prevTs.data?.data}
              mode={mode}
              interval={state.interval}
              timezone={state.timezone}
              currency={ov?.currency ?? source.currency}
              showRevenue={money}
              revenueColor={kpiColor(kpiColorScheme)}
              compare={state.compare}
              markers={markers}
              loading={ts.isFetching && ts.isPlaceholderData}
              onDrill={drill}
              onAddNote={
                site?.canWrite
                  ? (timestamp, text) => noteMutations.create.mutateAsync({ timestamp, text })
                  : undefined
              }
              renderMarkers={(items, close) => (
                <MarkerList
                  items={items}
                  siteId={siteId ?? ""}
                  canWrite={Boolean(site?.canWrite)}
                  timezone={state.timezone}
                  close={close}
                />
              )}
            />
          )}
        </section>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <BreakdownCard
          id="source"
          title="Source"
          tabs={sourceCardTabs}
          state={state}
          kpiGoal={kpiGoalName ? { name: kpiGoalName, label: kpiLabel ?? kpiGoalName } : null}
        />
        <BreakdownCard
          id="pages"
          title="Pages"
          tabs={pageTabs(domain)}
          state={state}
          kpiGoal={kpiGoalName ? { name: kpiGoalName, label: kpiLabel ?? kpiGoalName } : null}
        />
        <BreakdownCard
          id="location"
          title="Location"
          tabs={locationTabs()}
          state={state}
          kpiGoal={kpiGoalName ? { name: kpiGoalName, label: kpiLabel ?? kpiGoalName } : null}
        />
        <BreakdownCard
          id="system"
          title="System"
          tabs={systemTabs()}
          state={state}
          kpiGoal={kpiGoalName ? { name: kpiGoalName, label: kpiLabel ?? kpiGoalName } : null}
        />
        {siteId ? null : (
          <>
            {goalsCard}
            {heatmapCard}
          </>
        )}
      </div>
      {siteId ? (
        <OverviewHub
          siteId={siteId}
          range={markerRange}
          money={money}
          currency={currencyCode}
          points={points}
          revenueColor={kpiColor(kpiColorScheme)}
          goals={goalsCard}
          heatmap={heatmapCard}
        />
      ) : null}
    </div>
  );
}
