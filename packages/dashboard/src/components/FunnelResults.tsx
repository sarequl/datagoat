import { lazy, Suspense } from 'react';
import type { FunnelResult } from '../api/types';
import { useFunnel } from '../hooks/useFunnel';
import { useMetadata } from '../hooks/useMetadata';
import { usePeriod } from '../hooks/usePeriod';
import { useSelectedSite } from '../hooks/useSelectedSite';
import { formatCurrency, formatNumber, formatPercent } from '../utils/format';
import { ErrorState } from './ErrorState';
import { KpiCard } from './KpiCard';
import { Skeleton } from './Skeleton';

// Chart.js is heavy enough to keep out of the initial page chunk; the module is
// only fetched once a funnel response is ready to draw.
const FunnelChart = lazy(() =>
  import('./FunnelChart').then((module) => ({ default: module.FunnelChart })),
);

interface FunnelKpi {
  label: string;
  pick: (result: FunnelResult) => number;
  format: (value: number, currency: string) => string;
  betterWhen: 'up' | 'down';
  tooltip: string;
}

const FUNNEL_KPIS: FunnelKpi[] = [
  {
    label: 'Total visitors',
    pick: (result) => result.totalVisitors,
    format: (value) => formatNumber(value),
    betterWhen: 'up',
    tooltip: 'Unique visitors who reached the first funnel step.',
  },
  {
    label: 'Total conversion',
    pick: (result) => result.totalConversionRate,
    format: (value) => formatPercent(value),
    betterWhen: 'up',
    tooltip: 'Last-step visitors divided by first-step visitors.',
  },
  {
    label: 'Revenue (est.)',
    pick: (result) => result.revenue,
    format: (value, currency) => formatCurrency(value, currency),
    betterWhen: 'up',
    tooltip: 'Attributed revenue from visitors who reached the payment step.',
  },
  {
    label: 'Payments',
    pick: (result) => result.payments,
    format: (value) => formatNumber(value),
    betterWhen: 'up',
    tooltip: 'Payments attributed to visitors who reached the payment step.',
  },
  {
    label: 'Revenue / visitor',
    pick: (result) => result.revenuePerVisitor,
    format: (value, currency) => formatCurrency(value, currency),
    betterWhen: 'up',
    tooltip: 'Attributed revenue divided by first-step visitors.',
  },
];

export function FunnelResults({ funnelId }: { funnelId: string }) {
  const { selectedSite } = useSelectedSite();
  const metadataQuery = useMetadata(selectedSite?.id);
  const timezone = selectedSite?.timezone ?? metadataQuery.data?.timezone ?? 'UTC';
  // `FunnelResult` carries no currency; the site supplies it (api.md §2.7.3).
  const currency = selectedSite?.currency ?? metadataQuery.data?.currency ?? 'USD';
  const { startAt, endAt } = usePeriod(timezone);
  const funnelQuery = useFunnel({ funnelId, siteId: selectedSite?.id, startAt, endAt, timezone });
  const data = funnelQuery.data;

  if (funnelQuery.isError) {
    return (
      <section className="funnel-results" aria-label="Funnel results">
        <ErrorState
          title="Cannot load funnel"
          message="The dashboard could not read this funnel's results."
          onRetry={() => {
            void funnelQuery.refetch();
          }}
        />
      </section>
    );
  }

  if (funnelQuery.isLoading || !data) {
    return (
      <section className="funnel-results" aria-label="Funnel results">
        <Skeleton className="funnel-results__title" />
        <div className="kpi-grid">
          {FUNNEL_KPIS.map((kpi) => (
            <KpiCard
              key={kpi.label}
              label={kpi.label}
              value={0}
              format={(value) => kpi.format(value, currency)}
              betterWhen={kpi.betterWhen}
              tooltip={kpi.tooltip}
              loading
            />
          ))}
        </div>
        <Skeleton className="chart-skeleton" />
      </section>
    );
  }

  return (
    <section className="funnel-results" aria-label="Funnel results">
      <div className="funnel-results__header">
        <h2>{data.name}</h2>
        <p className="funnel-results__meta muted">
          {data.startAt && data.endAt ? `${data.startAt} → ${data.endAt}` : 'All time'}
          {' · '}Last updated {data.lastUpdated}
        </p>
      </div>

      <div className="kpi-grid">
        {FUNNEL_KPIS.map((kpi) => (
          <KpiCard
            key={kpi.label}
            label={kpi.label}
            value={kpi.pick(data)}
            format={(value) => kpi.format(value, currency)}
            betterWhen={kpi.betterWhen}
            tooltip={kpi.tooltip}
          />
        ))}
      </div>

      <Suspense fallback={<Skeleton className="chart-skeleton" />}>
        <FunnelChart steps={data.steps} currency={currency} />
      </Suspense>

      <div className="table-wrap">
        <table className="source-table funnel-step-table">
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Name</th>
              <th scope="col">Visitors</th>
              <th scope="col">Conversion</th>
              <th scope="col">Drop-off</th>
              <th scope="col">Revenue</th>
              <th scope="col">Payments</th>
            </tr>
          </thead>
          <tbody>
            {data.steps.map((step) => (
              <tr key={step.step}>
                <td>{step.step}</td>
                <th scope="row" className="source-table__value">
                  {step.name}
                </th>
                <td>{formatNumber(step.visitors)}</td>
                <td>{formatPercent(step.conversionRate)}</td>
                <td>{formatPercent(step.dropoffRate)}</td>
                <td>{formatCurrency(step.revenue, currency)}</td>
                <td>{formatNumber(step.payments)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
