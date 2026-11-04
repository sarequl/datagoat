/** Funnels: every active funnel with its headline conversion, and the funnel builder. */
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { Funnel } from "../../../../shared/api-types";
import { FunnelBuilder } from "../../analytics/components/FunnelBuilder";
import { Dialog, EmptyState, ErrorState, Skeleton } from "../../analytics/components/primitives";
import {
  useFunnelMutations,
  useFunnelResult,
  useFunnels,
  useTrackedGoals,
} from "../../analytics/hooks";
import { formatNumber, formatPercent } from "../../analytics/lib/format";
import { AnalyticsHeader } from "../../analytics/OverviewDashboard";
import { SiteAnalytics } from "../../analytics/SiteAnalytics";
import { type DashboardState, useDashboardState } from "../../analytics/state";
import { Button } from "../../components/ui";

function FunnelCard({
  funnel,
  siteId,
  state,
}: {
  funnel: Funnel;
  siteId: string;
  state: DashboardState;
}) {
  const r = useFunnelResult(siteId, funnel.id, { ...state.rangeParams, ...state.filterParams });
  return (
    <li className="min-w-0">
      <Link
        to="/app/$siteId/funnels/$funnelId"
        params={{ siteId, funnelId: funnel.id }}
        search={state.search as never}
        className="block h-full rounded-lg border border-line bg-surface p-4 hover:bg-surface-2"
      >
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-semibold">{funnel.name}</h2>
          <span className="text-xs text-muted">{funnel.steps.length} steps</span>
        </div>
        <p className="mt-1 truncate text-xs text-muted">
          {funnel.steps.map((s) => s.name).join(" → ")}
        </p>
        {r.data ? (
          <div className="mt-3 flex items-end gap-1" aria-hidden="true">
            {r.data.data.map((s) => (
              <span
                key={s.id}
                className="flex-1 rounded-sm bg-visitors/70"
                style={{
                  height: `${Math.max(4, (s.value / Math.max(1, r.data?.data[0]?.value ?? 1)) * 48)}px`,
                }}
              />
            ))}
          </div>
        ) : (
          <Skeleton className="mt-3 h-12" />
        )}
        <p className="mt-2 text-sm">
          {r.data ? (
            <>
              <span className="font-semibold tabular-nums">
                {formatPercent(r.data.metrics.overallConversionRate)}
              </span>{" "}
              <span className="text-muted">
                conversion · {formatNumber(r.data.metrics.completions)} of{" "}
                {formatNumber(r.data.metrics.totalVisitors)} visitors
              </span>
            </>
          ) : r.error ? (
            <span className="text-error-text">{r.error.message}</span>
          ) : (
            " "
          )}
        </p>
      </Link>
    </li>
  );
}

function Funnels({ siteId, canWrite }: { siteId: string; canWrite: boolean }) {
  const state = useDashboardState();
  const funnels = useFunnels(siteId);
  const goals = useTrackedGoals(siteId);
  const m = useFunnelMutations(siteId);
  const navigate = useNavigate();
  const newGoal = typeof state.search.newGoal === "string" ? state.search.newGoal : null;
  const [open, setOpen] = useState(Boolean(newGoal));
  const close = () => {
    setOpen(false);
    if (newGoal) state.update({ newGoal: undefined });
  };
  return (
    <div className="space-y-4">
      <AnalyticsHeader
        title="Funnels"
        state={state}
        actions={canWrite ? <Button onClick={() => setOpen(true)}>New funnel</Button> : null}
      />
      {funnels.isPending ? (
        <Skeleton className="h-40" />
      ) : funnels.error ? (
        <ErrorState error={funnels.error} />
      ) : funnels.data?.length ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {funnels.data.map((f) => (
            <FunnelCard key={f.id} funnel={f} siteId={siteId} state={state} />
          ))}
        </ul>
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState>
            No funnels yet. A funnel shows where visitors drop off between steps, like landing page
            → signup → payment.
          </EmptyState>
        </div>
      )}
      <Dialog open={open} onClose={close} title="New funnel" wide>
        <FunnelBuilder
          goals={(goals.data ?? []).map((g) => g.name)}
          initialSteps={
            newGoal
              ? [
                  { name: "Landing page", type: "pageview", url: "/", urlMatchType: "equals" },
                  {
                    name: newGoal,
                    type: "goal",
                    goalName: newGoal,
                    goalCompletionType: "completed",
                  },
                ]
              : undefined
          }
          submitLabel="Create funnel"
          busy={m.create.isPending}
          error={m.create.error?.message}
          onCancel={close}
          onSubmit={(name, steps) =>
            m.create.mutate(
              { name, steps },
              {
                onSuccess: (f) => {
                  setOpen(false);
                  void navigate({
                    to: "/app/$siteId/funnels/$funnelId",
                    params: { siteId, funnelId: f.id },
                  });
                },
              },
            )
          }
        />
      </Dialog>
    </div>
  );
}

export default function FunnelsPage() {
  return (
    <SiteAnalytics>
      {(site, source) => (
        <Funnels siteId={site._id} canWrite={source.kind === "site" && source.canWrite} />
      )}
    </SiteAnalytics>
  );
}
