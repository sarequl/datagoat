/**
 * Goals (DataFast's goal analytics): goals over time, completions, visitors, conversion and
 * revenue per goal; a side panel per goal with its custom properties and values, display name,
 * colour, description and hide toggle, and quick actions (visitors who completed it, create a
 * funnel, filter the dashboard, set as #1 KPI).
 */
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type {
  GoalColor,
  GoalCustomization,
  GoalPropertyRow,
  GoalRow,
  TimeseriesPoint,
} from "../../../../shared/api-types";
import { MultiLineChart } from "../../analytics/components/MultiLineChart";
import {
  Badge,
  Dialog,
  EmptyState,
  ErrorState,
  Skeleton,
} from "../../analytics/components/primitives";
import {
  useGoalCustomizationMutations,
  useGoalCustomizations,
  useMetadata,
  useSetKpi,
  useTrackedGoals,
} from "../../analytics/hooks";
import { goalColor } from "../../analytics/lib/colors";
import { filtersToParams } from "../../analytics/lib/filters";
import { formatMoney, formatNumber, formatPercent } from "../../analytics/lib/format";
import { AnalyticsHeader } from "../../analytics/OverviewDashboard";
import { SiteAnalytics } from "../../analytics/SiteAnalytics";
import { useAnalytics } from "../../analytics/source";
import { type DashboardState, useDashboardState } from "../../analytics/state";
import { Button, cx } from "../../components/ui";

interface GoalView {
  row: GoalRow;
  label: string;
  color: string;
  custom: GoalCustomization | undefined;
}

function Properties({ goal, state }: { goal: string; state: DashboardState }) {
  const allowed = Object.fromEntries(
    Object.entries(state.filterParams).filter(
      ([k]) =>
        ![
          "filter_entry_page",
          "filter_hostname",
          "filter_visit_count",
          "filter_channel",
          "filter_goal",
        ].includes(k),
    ),
  );
  const props = useAnalytics<GoalPropertyRow[]>(
    "goals/properties",
    { ...state.rangeParams, ...allowed, eventName: goal },
    { keepPrevious: false },
  );
  const [open, setOpen] = useState<string | null>(null);
  const values = useAnalytics<GoalPropertyRow[]>(
    "goals/properties",
    { ...state.rangeParams, ...allowed, eventName: goal, propertyName: open ?? "" },
    { enabled: Boolean(open), keepPrevious: false },
  );
  if (props.isPending) return <Skeleton className="h-24" />;
  if (props.error) return <ErrorState error={props.error} />;
  const rows = props.data?.data ?? [];
  if (!rows.length)
    return <p className="text-sm text-muted">This goal has no custom properties in this period.</p>;
  return (
    <ul className="space-y-1" aria-label="Custom properties">
      {rows.map((p) => (
        <li key={p.property} className="rounded-md border border-line">
          <button
            type="button"
            aria-expanded={open === p.property}
            onClick={() => setOpen(open === p.property ? null : (p.property ?? null))}
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2"
          >
            <span className="font-mono">{p.property}</span>
            <span className="text-xs text-muted">{formatNumber(p.visitors)} visitors</span>
          </button>
          {open === p.property ? (
            <div className="border-t border-line px-3 py-2">
              {values.isPending ? (
                <Skeleton className="h-12" />
              ) : (
                <ul className="space-y-1 text-sm">
                  {(values.data?.data ?? []).map((v) => {
                    const max = Math.max(1, ...(values.data?.data ?? []).map((x) => x.visitors));
                    return (
                      <li
                        key={v.value}
                        className="relative flex justify-between gap-2 overflow-hidden rounded px-2 py-1"
                      >
                        <span
                          aria-hidden="true"
                          className="absolute inset-y-0 left-0 bg-visitors/15"
                          style={{ width: `${(v.visitors / max) * 100}%` }}
                        />
                        <span className="relative truncate">{v.value}</span>
                        <span className="relative tabular-nums text-muted">
                          {formatNumber(v.visitors)} · {formatNumber(v.completions)}×
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function GoalPanel({
  goal,
  siteId,
  state,
  colors,
  currency,
  isKpi,
  canWrite,
  onClose,
}: {
  goal: GoalView;
  siteId: string;
  state: DashboardState;
  colors: GoalColor[];
  currency: string;
  isKpi: boolean;
  canWrite: boolean;
  onClose: () => void;
}) {
  const m = useGoalCustomizationMutations(siteId);
  const kpi = useSetKpi(siteId);
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(goal.custom?.displayName ?? "");
  const [color, setColor] = useState(goal.custom?.color ?? "");
  const [description, setDescription] = useState(goal.custom?.description ?? "");
  const [hidden, setHidden] = useState(goal.custom?.hidden ?? false);
  const name = goal.row.goal;
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-3 text-sm">
        {(
          [
            ["Completions", formatNumber(goal.row.completions)],
            ["Visitors", formatNumber(goal.row.visitors)],
            [
              "Conversion",
              goal.row.conversion_rate !== undefined
                ? formatPercent(goal.row.conversion_rate, 2)
                : "–",
            ],
            ["Revenue", formatMoney(goal.row.revenue ?? 0, currency)],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="rounded-md border border-line p-2">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="text-lg font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="goal-actions">
        <h3 id="goal-actions" className="mb-2 text-sm font-semibold">
          Quick actions
        </h3>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() =>
              void navigate({
                to: "/app/$siteId/visitors",
                params: { siteId },
                search: { goal: name } as never,
              })
            }
          >
            Visitor journeys
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              void navigate({
                to: "/app/$siteId/funnels",
                params: { siteId },
                search: { newGoal: name } as never,
              })
            }
          >
            Create funnel
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              void navigate({
                to: "/app/$siteId/overview",
                params: { siteId },
                search: {
                  ...filtersToParams([
                    ...state.filters.filter((f) => f.key !== "goal"),
                    { key: "goal", op: "is", values: [name] },
                  ]),
                } as never,
              })
            }
          >
            Filter dashboard
          </Button>
          {canWrite ? (
            <Button
              variant={isKpi ? "ghost" : "primary"}
              disabled={kpi.isPending}
              onClick={() => kpi.mutate(isKpi ? null : name)}
            >
              {isKpi ? "Unset #1 KPI" : "Set as #1 KPI"}
            </Button>
          ) : null}
        </div>
        {kpi.isSuccess ? (
          <p role="status" className="mt-2 text-xs text-success-text">
            #1 KPI updated.
          </p>
        ) : null}
        {kpi.error ? (
          <p role="alert" className="mt-2 text-xs text-error-text">
            {kpi.error.message}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="goal-props">
        <h3 id="goal-props" className="mb-2 text-sm font-semibold">
          Custom properties
        </h3>
        <Properties goal={name} state={state} />
      </section>

      {canWrite ? (
        <section aria-labelledby="goal-display">
          <h3 id="goal-display" className="mb-2 text-sm font-semibold">
            Display
          </h3>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              m.save.mutate({
                goalName: name,
                displayName: displayName.trim() || null,
                color: color || null,
                description: description.trim() || null,
                hidden,
              });
            }}
          >
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Display name</span>
              <input
                value={displayName}
                maxLength={80}
                placeholder={name}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full rounded-md border border-line bg-surface px-3 py-2"
              />
            </label>
            <fieldset>
              <legend className="mb-1 text-sm text-muted">Colour</legend>
              <div className="flex flex-wrap gap-2">
                {colors.map((c) => (
                  <label key={c.color} className="cursor-pointer">
                    <input
                      type="radio"
                      name="goal-color"
                      value={c.color}
                      checked={color === c.color}
                      onChange={() => setColor(c.color)}
                      className="peer sr-only"
                    />
                    <span
                      title={c.label}
                      className="block size-7 rounded-full border-2 border-transparent peer-checked:border-text peer-focus-visible:outline-2 peer-focus-visible:outline-primary"
                      style={{ background: c.color }}
                    />
                    <span className="sr-only">{c.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Description</span>
              <textarea
                value={description}
                maxLength={300}
                rows={2}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-md border border-line bg-surface px-3 py-2"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hidden}
                onChange={(e) => setHidden(e.target.checked)}
              />
              Hide from the chart and goal lists (still tracked)
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={m.save.isPending}>
                Save
              </Button>
              {goal.custom ? (
                <Button
                  variant="ghost"
                  onClick={() => m.reset.mutate(name, { onSuccess: onClose })}
                >
                  Reset to defaults
                </Button>
              ) : null}
            </div>
            {m.save.isSuccess ? (
              <p role="status" className="text-xs text-success-text">
                Saved.
              </p>
            ) : null}
            {m.save.error ? (
              <p role="alert" className="text-xs text-error-text">
                {m.save.error.message}
              </p>
            ) : null}
          </form>
        </section>
      ) : null}
    </div>
  );
}

function Goals({
  siteId,
  currency,
  canWrite,
}: {
  siteId: string;
  currency: string;
  canWrite: boolean;
}) {
  const state = useDashboardState();
  const meta = useMetadata(siteId);
  const tracked = useTrackedGoals(siteId);
  const custom = useGoalCustomizations(siteId);
  const base = { ...state.rangeParams, ...state.filterParams };
  const goals = useAnalytics<GoalRow[]>("goals", { ...base, limit: 100 });
  const ts = useAnalytics<TimeseriesPoint[]>("timeseries", {
    ...base,
    interval: state.interval === "minute" ? "hour" : state.interval,
    fields: "goals",
    limit: 1000,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [off, setOff] = useState<Set<string>>(new Set());
  const goalParam = typeof state.search.goalPanel === "string" ? state.search.goalPanel : null;
  useEffect(() => {
    if (goalParam) setSelected(goalParam);
  }, [goalParam]);

  const views: GoalView[] = useMemo(() => {
    const byName = new Map((custom.data?.items ?? []).map((c) => [c.goalName, c]));
    return (goals.data?.data ?? []).map((row, i) => {
      const c = byName.get(row.goal);
      const t = tracked.data?.find((g) => g.name === row.goal);
      return {
        row,
        custom: c,
        label: c?.displayName || t?.displayName || row.goal,
        color: goalColor(row.goal, c?.color ?? t?.color, i),
      };
    });
  }, [goals.data, custom.data, tracked.data]);
  const visible = views.filter((v) => showHidden || !v.custom?.hidden);
  const hiddenCount = views.length - views.filter((v) => !v.custom?.hidden).length;
  const points = ts.data?.data ?? [];
  const series = visible
    .filter((v) => !v.custom?.hidden && !off.has(v.row.goal))
    .map((v) => ({
      key: v.row.goal,
      label: v.label,
      color: v.color,
      values: points.map((p) => p.goals?.[v.row.goal] ?? 0),
    }));
  const current = views.find((v) => v.row.goal === selected);
  const kpiGoal = meta.data?.kpi && meta.data.kpi !== "revenue" ? meta.data.kpi : null;

  return (
    <div className="space-y-4">
      <AnalyticsHeader title="Goals" state={state} />
      <section
        className="rounded-lg border border-line bg-surface p-4"
        aria-labelledby="goals-chart-title"
      >
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 id="goals-chart-title" className="text-sm font-semibold">
            Goals over time
          </h2>
          <div className="flex flex-wrap gap-1">
            {visible
              .filter((v) => !v.custom?.hidden)
              .map((v) => (
                <button
                  key={v.row.goal}
                  type="button"
                  aria-pressed={!off.has(v.row.goal)}
                  onClick={() =>
                    setOff((prev) => {
                      const next = new Set(prev);
                      if (next.has(v.row.goal)) next.delete(v.row.goal);
                      else next.add(v.row.goal);
                      return next;
                    })
                  }
                  className={cx(
                    "flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs",
                    off.has(v.row.goal) && "opacity-50 line-through",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full"
                    style={{ background: v.color }}
                  />
                  {v.label}
                </button>
              ))}
          </div>
        </div>
        {ts.isPending ? (
          <Skeleton className="h-56" />
        ) : ts.error ? (
          <ErrorState error={ts.error} />
        ) : series.length && points.some((p) => p.goals) ? (
          <MultiLineChart
            timestamps={points.map((p) => p.timestamp)}
            series={series}
            interval={state.interval === "minute" ? "hour" : state.interval}
            timezone={state.timezone}
            caption="Goal completions over time"
          />
        ) : (
          <EmptyState>No goal completions over time for this period.</EmptyState>
        )}
      </section>

      <section
        className="overflow-hidden rounded-lg border border-line bg-surface"
        aria-labelledby="goals-table-title"
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-4">
          <h2 id="goals-table-title" className="text-sm font-semibold">
            All goals
          </h2>
          {hiddenCount ? (
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
              />
              Show {hiddenCount} hidden
            </label>
          ) : null}
        </div>
        {goals.isPending ? (
          <Skeleton className="m-4 h-40" />
        ) : goals.error ? (
          <div className="p-4">
            <ErrorState error={goals.error} />
          </div>
        ) : !visible.length ? (
          <EmptyState>
            No goals yet. Track one with <code>window.datafast("signup")</code> or a{" "}
            <code>data-fast-goal</code> attribute.
          </EmptyState>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Goal
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Completions
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Visitors
                  </th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">
                    Conversion
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Revenue
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((v) => (
                  <tr key={v.row.goal} className="border-t border-line hover:bg-surface-2">
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        onClick={() => setSelected(v.row.goal)}
                        className="flex items-center gap-2 text-left font-medium hover:text-primary-text"
                      >
                        <span
                          aria-hidden="true"
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ background: v.color }}
                        />
                        {v.label}
                        {v.label !== v.row.goal ? (
                          <span className="font-mono text-xs font-normal text-muted">
                            {v.row.goal}
                          </span>
                        ) : null}
                        {kpiGoal === v.row.goal ? <Badge tone="primary">#1 KPI</Badge> : null}
                        {v.custom?.hidden ? <Badge>hidden</Badge> : null}
                      </button>
                      {v.custom?.description ? (
                        <p className="text-xs text-muted">{v.custom.description}</p>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatNumber(v.row.completions)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {formatNumber(v.row.visitors)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {v.row.conversion_rate !== undefined
                        ? formatPercent(v.row.conversion_rate, 2)
                        : "–"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-primary-text">
                      {formatMoney(v.row.revenue ?? 0, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="text-xs text-muted">
        Payment providers record <code>payment</code>, <code>free_trial</code> and subscription
        lifecycle goals automatically.{" "}
        <Link
          to="/app/$siteId/funnels"
          params={{ siteId }}
          className="text-primary-text hover:underline"
        >
          Build a funnel from goals →
        </Link>
      </p>
      <Dialog
        open={Boolean(current)}
        onClose={() => setSelected(null)}
        title={current ? current.label : "Goal"}
        side
      >
        {current ? (
          <GoalPanel
            key={current.row.goal}
            goal={current}
            siteId={siteId}
            state={state}
            colors={custom.data?.colors ?? []}
            currency={currency}
            isKpi={kpiGoal === current.row.goal}
            canWrite={canWrite}
            onClose={() => setSelected(null)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

export default function GoalsPage() {
  return (
    <SiteAnalytics>
      {(site, source) => (
        <Goals
          siteId={site._id}
          currency={site.currency}
          canWrite={source.kind === "site" && source.canWrite}
        />
      )}
    </SiteAnalytics>
  );
}
