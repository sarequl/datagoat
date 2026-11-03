import { useState } from 'react';
import { useFunnelMutations, useFunnels } from '../hooks/useFunnels';
import { useSelectedSite } from '../hooks/useSelectedSite';
import { formatDate } from '../utils/format';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { Skeleton } from './Skeleton';

interface FunnelListProps {
  onNew: () => void;
  onEdit: (funnelId: string) => void;
  onView: (funnelId: string) => void;
}

export function FunnelList({ onNew, onEdit, onView }: FunnelListProps) {
  const { selectedSite } = useSelectedSite();
  const query = useFunnels({ siteId: selectedSite?.id, limit: 100, order: 'desc' });
  const { remove } = useFunnelMutations(selectedSite?.id);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const funnels = query.data?.data ?? [];

  if (query.isLoading) {
    return <Skeleton className="table-skeleton" />;
  }

  if (query.isError) {
    return (
      <ErrorState
        title="Cannot load funnels"
        message="The dashboard could not read your saved funnels."
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  return (
    <section className="funnel-list" aria-label="Saved funnels">
      <div className="funnel-list__header">
        <h2>Saved funnels</h2>
        <button type="button" className="button-primary" onClick={onNew}>
          New funnel
        </button>
      </div>

      {funnels.length === 0 ? (
        <EmptyState
          title="No funnels yet"
          message="Create a funnel to see step-by-step conversion and revenue."
        />
      ) : (
        <div className="table-wrap">
          <table className="source-table funnel-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Steps</th>
                <th scope="col">Status</th>
                <th scope="col">Last updated</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {funnels.map((funnel) => (
                <tr key={funnel.id}>
                  <th scope="row" className="source-table__value">
                    {funnel.name}
                  </th>
                  <td>{funnel.steps.length}</td>
                  <td>{funnel.isActive ? 'Active' : 'Inactive'}</td>
                  <td>{formatDate(funnel.updatedAt)}</td>
                  <td>
                    <div className="funnel-table__actions">
                      <button
                        type="button"
                        onClick={() => onView(funnel.id)}
                        disabled={!funnel.isActive}
                      >
                        Results
                      </button>
                      <button type="button" onClick={() => onEdit(funnel.id)}>
                        Edit
                      </button>
                      {confirmingId === funnel.id ? (
                        <>
                          <button
                            type="button"
                            className="button-danger"
                            onClick={() => {
                              setConfirmingId(null);
                              void remove.mutateAsync(funnel.id);
                            }}
                            disabled={remove.isPending}
                          >
                            Confirm
                          </button>
                          <button type="button" onClick={() => setConfirmingId(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button type="button" onClick={() => setConfirmingId(funnel.id)}>
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
