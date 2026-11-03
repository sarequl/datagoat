import { useSearchParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { FunnelResults } from '../components/FunnelResults';
import { PeriodSelector } from '../components/PeriodSelector';
import { useMetadata } from '../hooks/useMetadata';
import { useSelectedSite } from '../hooks/useSelectedSite';

export function FunnelsPage() {
  const { selectedSite } = useSelectedSite();
  const metadataQuery = useMetadata(selectedSite?.id);
  const timezone = selectedSite?.timezone ?? metadataQuery.data?.timezone ?? 'UTC';
  const [searchParams] = useSearchParams();
  const funnelId = searchParams.get('funnel') ?? undefined;

  return (
    <section aria-label="Funnels">
      <div className="page-header">
        <h1>Funnels</h1>
        <PeriodSelector timezone={timezone} />
      </div>
      {funnelId ? (
        <FunnelResults funnelId={funnelId} />
      ) : (
        <EmptyState
          title="No funnel selected"
          message="Select a funnel to see step-by-step conversion and revenue. The saved-funnel list and builder land once the admin CRUD contract is pinned."
        />
      )}
    </section>
  );
}
