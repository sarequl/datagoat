import { lazy, Suspense } from 'react';
import { ErrorState } from '../components/ErrorState';
import { KpiGrid } from '../components/KpiGrid';
import { PeriodSelector } from '../components/PeriodSelector';
import { Skeleton } from '../components/Skeleton';
import { useMetadata } from '../hooks/useMetadata';
import { useOverview } from '../hooks/useOverview';
import { usePeriod } from '../hooks/usePeriod';
import { useTimeseries } from '../hooks/useTimeseries';
import { presetToInterval } from '../utils/period';

// Chart.js is heavy enough to keep out of the initial page chunk; the module is
// only fetched once a timeseries response is ready to draw.
const TimeseriesChart = lazy(() =>
  import('../components/charts/TimeseriesChart').then((module) => ({
    default: module.TimeseriesChart,
  })),
);

const TIMESERIES_FIELDS = ['visitors', 'pageviews', 'revenue'] as const;

export function DashboardPage() {
  const metadataQuery = useMetadata();
  const timezone = metadataQuery.data?.timezone ?? 'UTC';
  const currency = metadataQuery.data?.currency ?? 'USD';

  const { startAt, endAt, preset, compare } = usePeriod(timezone);
  const interval = presetToInterval(preset, startAt, endAt);

  const overviewQuery = useOverview({ startAt, endAt, timezone, compare });
  const timeseriesQuery = useTimeseries({
    startAt,
    endAt,
    timezone,
    interval,
    fields: [...TIMESERIES_FIELDS],
  });

  if (metadataQuery.isError) {
    return (
      <section aria-label="Overview">
        <h1>Overview</h1>
        <ErrorState
          title="Cannot load site settings"
          message="The dashboard could not read the site timezone and currency."
          onRetry={() => {
            void metadataQuery.refetch();
          }}
        />
      </section>
    );
  }

  return (
    <section aria-label="Overview">
      <div className="page-header">
        <h1>Overview</h1>
        <PeriodSelector timezone={timezone} />
      </div>

      {overviewQuery.isError ? (
        <ErrorState
          title="Cannot load overview"
          message="The dashboard could not read totals for this period."
          onRetry={() => {
            void overviewQuery.refetch();
          }}
        />
      ) : (
        <KpiGrid
          overview={overviewQuery.data}
          currency={overviewQuery.data?.currency ?? currency}
          loading={overviewQuery.isLoading}
        />
      )}

      <div className="chart-section">
        <h2>Visitors and revenue</h2>
        {timeseriesQuery.isError ? (
          <ErrorState
            title="Cannot load timeseries"
            message="The dashboard could not read bucketed metrics for this period."
            onRetry={() => {
              void timeseriesQuery.refetch();
            }}
          />
        ) : timeseriesQuery.data ? (
          <Suspense fallback={<Skeleton className="chart-skeleton" />}>
            <TimeseriesChart data={timeseriesQuery.data} currency={timeseriesQuery.data.currency} />
          </Suspense>
        ) : (
          <Skeleton className="chart-skeleton" />
        )}
      </div>
    </section>
  );
}
