/** One funnel's results for the period and filters, with edit and delete. */
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { FunnelBuilder } from "../../analytics/components/FunnelBuilder";
import { FunnelChart } from "../../analytics/components/FunnelChart";
import { Dialog, ErrorState, Skeleton } from "../../analytics/components/primitives";
import {
  useFunnelMutations,
  useFunnelResult,
  useFunnels,
  useTrackedGoals,
} from "../../analytics/hooks";
import {
  formatDateTime,
  formatMoney,
  formatNumber,
  formatPercent,
} from "../../analytics/lib/format";
import { AnalyticsHeader } from "../../analytics/OverviewDashboard";
import { SiteAnalytics } from "../../analytics/SiteAnalytics";
import { useDashboardState } from "../../analytics/state";
import { BackLink, Button } from "../../components/ui";

function Detail({
  siteId,
  funnelId,
  currency,
  timezone,
  canWrite,
}: {
  siteId: string;
  funnelId: string;
  currency: string;
  timezone: string;
  canWrite: boolean;
}) {
  const state = useDashboardState();
  const funnels = useFunnels(siteId);
  const goals = useTrackedGoals(siteId);
  const result = useFunnelResult(siteId, funnelId, { ...state.rangeParams, ...state.filterParams });
  const m = useFunnelMutations(siteId);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const funnel = funnels.data?.find((f) => f.id === funnelId);
  const r = result.data;
  return (
    <div className="space-y-4">
      <BackLink to="/app/$siteId/funnels" params={{ siteId }}>
        Funnels
      </BackLink>
      <AnalyticsHeader
        title={funnel?.name ?? r?.funnel.name ?? "Funnel"}
        state={state}
        actions={
          canWrite && funnel ? (
            <>
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(true)}>
                Delete
              </Button>
            </>
          ) : null
        }
      />
      {result.isPending ? (
        <Skeleton className="h-72" />
      ) : result.error ? (
        <ErrorState error={result.error} />
      ) : r ? (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ["Entered", formatNumber(r.metrics.totalVisitors)],
                ["Completed", formatNumber(r.metrics.completions)],
                ["Conversion", formatPercent(r.metrics.overallConversionRate)],
                [
                  "Revenue/visitor",
                  formatMoney(r.metrics.overallRevenuePerVisitor, currency, { cents: true }),
                ],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="rounded-lg border border-line bg-surface p-3">
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="text-xl font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          <section
            className="rounded-lg border border-line bg-surface p-4"
            aria-label="Funnel results"
          >
            <FunnelChart result={r} currency={currency} money />
            <p className="mt-3 text-xs text-muted">
              Updated {formatDateTime(r.metrics.lastUpdated, timezone)}
            </p>
          </section>
        </>
      ) : null}
      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit funnel" wide>
        {funnel ? (
          <FunnelBuilder
            initialName={funnel.name}
            initialSteps={funnel.steps}
            goals={(goals.data ?? []).map((g) => g.name)}
            submitLabel="Save funnel"
            busy={m.update.isPending}
            error={m.update.error?.message}
            onCancel={() => setEditing(false)}
            onSubmit={(name, steps) =>
              m.update.mutate(
                { id: funnel.id, name, steps },
                { onSuccess: () => setEditing(false) },
              )
            }
          />
        ) : null}
      </Dialog>
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Delete funnel?">
        <p className="text-sm">
          The funnel definition is removed. Your analytics data is not affected.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirm(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={m.remove.isPending}
            onClick={() =>
              m.remove.mutate(funnelId, {
                onSuccess: () => void navigate({ to: "/app/$siteId/funnels", params: { siteId } }),
              })
            }
          >
            Delete funnel
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

export default function FunnelDetailPage() {
  const { funnelId } = useParams({ strict: false }) as { funnelId: string };
  return (
    <SiteAnalytics>
      {(site, source) => (
        <Detail
          siteId={site._id}
          funnelId={funnelId}
          currency={site.currency}
          timezone={site.timezone}
          canWrite={source.kind === "site" && source.canWrite}
        />
      )}
    </SiteAnalytics>
  );
}
