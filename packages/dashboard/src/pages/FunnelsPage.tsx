import { useSearchParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { FunnelBuilder } from '../components/FunnelBuilder';
import { FunnelList } from '../components/FunnelList';
import { FunnelResults } from '../components/FunnelResults';
import { PeriodSelector } from '../components/PeriodSelector';
import { Skeleton } from '../components/Skeleton';
import { useFunnels } from '../hooks/useFunnels';
import { useMetadata } from '../hooks/useMetadata';
import { useSelectedSite } from '../hooks/useSelectedSite';

export function FunnelsPage() {
  const { selectedSite } = useSelectedSite();
  const metadataQuery = useMetadata(selectedSite?.id);
  const timezone = selectedSite?.timezone ?? metadataQuery.data?.timezone ?? 'UTC';
  const [searchParams, setSearchParams] = useSearchParams();
  const funnelId = searchParams.get('funnel') ?? undefined;
  const editId = searchParams.get('edit') ?? undefined;
  const isNew = searchParams.get('new') === '1';

  const funnelsQuery = useFunnels({
    siteId: funnelId ? undefined : selectedSite?.id,
    limit: 100,
    order: 'desc',
  });
  const editing = editId
    ? funnelsQuery.data?.data.find((funnel) => funnel.id === editId)
    : undefined;

  function navigate(updates: Record<string, string | undefined>) {
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

  function goToList() {
    navigate({ funnel: undefined, edit: undefined, new: undefined });
  }

  const header = (
    <div className="page-header">
      <h1>Funnels</h1>
      <PeriodSelector timezone={timezone} />
    </div>
  );

  if (funnelId) {
    return (
      <section aria-label="Funnels">
        {header}
        <FunnelResults funnelId={funnelId} />
      </section>
    );
  }

  if (editId) {
    if (funnelsQuery.isLoading) {
      return (
        <section aria-label="Funnels">
          {header}
          <Skeleton className="table-skeleton" />
        </section>
      );
    }
    if (funnelsQuery.isError) {
      return (
        <section aria-label="Funnels">
          {header}
          <ErrorState
            title="Cannot load funnels"
            message="The dashboard could not read your saved funnels."
            onRetry={() => {
              void funnelsQuery.refetch();
            }}
          />
        </section>
      );
    }
    if (!editing) {
      return (
        <section aria-label="Funnels">
          {header}
          <EmptyState title="Funnel not found" message="This funnel may have been deleted.">
            <button type="button" onClick={goToList}>
              Back to funnels
            </button>
          </EmptyState>
        </section>
      );
    }
  }

  return (
    <section aria-label="Funnels">
      {header}
      {isNew || editId ? (
        <FunnelBuilder
          key={editing?.id ?? 'new'}
          funnel={editing}
          onDone={(id) => navigate({ funnel: id, edit: undefined, new: undefined })}
          onCancel={goToList}
        />
      ) : (
        <FunnelList
          onNew={() => navigate({ new: '1' })}
          onEdit={(id) => navigate({ edit: id })}
          onView={(id) => navigate({ funnel: id })}
        />
      )}
    </section>
  );
}
