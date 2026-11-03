import { useEffect, useMemo, useState } from 'react';
import { ErrorState } from '../components/ErrorState';
import { GoalList, type GoalTableSort } from '../components/GoalList';
import { PeriodSelector } from '../components/PeriodSelector';
import { useGoals } from '../hooks/useGoals';
import { useMetadata } from '../hooks/useMetadata';
import { usePeriod } from '../hooks/usePeriod';
import { useSelectedSite } from '../hooks/useSelectedSite';
import { sortGoalRows } from '../utils/goals';

const PAGE_SIZE = 25;

export function GoalsPage() {
  const { selectedSite } = useSelectedSite();
  const metadataQuery = useMetadata(selectedSite?.id);
  const timezone = selectedSite?.timezone ?? metadataQuery.data?.timezone ?? 'UTC';
  const currency = selectedSite?.currency ?? metadataQuery.data?.currency ?? 'USD';
  const { startAt, endAt } = usePeriod(timezone);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<GoalTableSort>({ key: 'visitors', direction: 'desc' });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset pagination when the period or site changes
  useEffect(() => {
    setPage(1);
  }, [startAt, endAt, selectedSite?.id]);

  const goalsQuery = useGoals({
    siteId: selectedSite?.id,
    startAt,
    endAt,
    timezone,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    order: 'desc',
  });
  const rows = goalsQuery.data?.data ?? [];
  const total = goalsQuery.data?.pagination?.total ?? 0;
  const sortedRows = useMemo(() => sortGoalRows(rows, sort.key, sort.direction), [rows, sort]);

  return (
    <section aria-label="Goals">
      <div className="page-header">
        <h1>Goals</h1>
        <PeriodSelector timezone={timezone} />
      </div>
      {goalsQuery.isError ? (
        <ErrorState
          title="Cannot load goals"
          message="The dashboard could not read goal totals for this period."
          onRetry={() => {
            void goalsQuery.refetch();
          }}
        />
      ) : (
        <GoalList
          rows={sortedRows}
          loading={goalsQuery.isLoading}
          currency={currency}
          sort={sort}
          onSortChange={setSort}
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onPageChange={setPage}
        />
      )}
    </section>
  );
}
