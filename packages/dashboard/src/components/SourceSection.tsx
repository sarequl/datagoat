import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useBreakdown } from '../hooks/useBreakdown';
import { useMetadata } from '../hooks/useMetadata';
import { usePeriod } from '../hooks/usePeriod';
import { useSelectedSite } from '../hooks/useSelectedSite';
import { sortBreakdownRows } from '../utils/breakdown';
import { ErrorState } from './ErrorState';
import { PathFilter } from './PathFilter';
import { Skeleton } from './Skeleton';
import { SourceTable, type SourceTableSort } from './SourceTable';
import { isSourceTab, SOURCE_TABS, type SourceTab, SourceTabs } from './SourceTabs';

const SourceChart = lazy(() =>
  import('./SourceChart').then((module) => ({ default: module.SourceChart })),
);

const PAGE_SIZE = 25;

const DIMENSION_LABELS: Record<SourceTab, string> = {
  referrers: 'Referrer',
  campaigns: 'Campaign',
  pages: 'Page',
  countries: 'Country',
  devices: 'Device',
  browsers: 'Browser',
};

export function SourceSection() {
  const { selectedSite } = useSelectedSite();
  const metadataQuery = useMetadata(selectedSite?.id);
  const timezone = selectedSite?.timezone ?? metadataQuery.data?.timezone ?? 'UTC';
  const currency = selectedSite?.currency ?? metadataQuery.data?.currency ?? 'USD';
  const { startAt, endAt } = usePeriod(timezone);

  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: SourceTab = isSourceTab(rawTab) ? rawTab : 'referrers';
  const path = searchParams.get('path') ?? '';
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SourceTableSort>({ key: 'visitors', direction: 'desc' });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset pagination when the dimension or filter changes
  useEffect(() => {
    setPage(1);
  }, [tab, path]);

  const breakdownQuery = useBreakdown({
    dimension: tab,
    siteId: selectedSite?.id,
    startAt,
    endAt,
    timezone,
    path: path || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    order: 'desc',
  });

  const rows = breakdownQuery.data?.data ?? [];
  const total = breakdownQuery.data?.pagination?.total ?? 0;
  const sortedRows = useMemo(() => sortBreakdownRows(rows, sort.key, sort.direction), [rows, sort]);

  function updateParams(updates: Record<string, string | undefined>) {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
    }
    setSearchParams(params, { replace: true });
  }

  const activeTab = SOURCE_TABS.find((item) => item.id === tab);

  return (
    <section className="source-section" aria-label="Traffic by source">
      <div className="source-section__header">
        <h2>Traffic by source</h2>
        <PathFilter value={path} onApply={(value) => updateParams({ path: value || undefined })} />
      </div>

      <SourceTabs active={tab} onSelect={(next) => updateParams({ tab: next })} />

      <div
        id="source-panel"
        role="tabpanel"
        aria-labelledby={`source-tab-${tab}`}
        className="source-panel"
      >
        {breakdownQuery.isError ? (
          <ErrorState
            title="Cannot load breakdown"
            message="The dashboard could not read traffic by source for this period."
            onRetry={() => {
              void breakdownQuery.refetch();
            }}
          />
        ) : (
          <>
            {sortedRows.length > 0 ? (
              <Suspense fallback={<Skeleton className="chart-skeleton" />}>
                <SourceChart rows={sortedRows} label={activeTab?.label ?? 'Source'} />
              </Suspense>
            ) : null}
            <SourceTable
              rows={sortedRows}
              loading={breakdownQuery.isLoading}
              currency={currency}
              dimensionLabel={DIMENSION_LABELS[tab]}
              sort={sort}
              onSortChange={(next: SourceTableSort) => setSort(next)}
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          </>
        )}
      </div>
    </section>
  );
}
