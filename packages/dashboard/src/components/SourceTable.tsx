import type { BreakdownRow } from '../api/types';
import type { BreakdownSortKey } from '../utils/breakdown';
import { formatCurrency, formatNumber, formatPercent } from '../utils/format';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';

export interface SourceTableSort {
  key: BreakdownSortKey;
  direction: 'asc' | 'desc';
}

interface Column {
  key: BreakdownSortKey;
  label: string;
}

const COLUMNS: Column[] = [
  { key: 'visitors', label: 'Visitors' },
  { key: 'pageviews', label: 'Pageviews' },
  { key: 'revenue', label: 'Revenue (est.)' },
  { key: 'payments', label: 'Payments' },
  { key: 'revenuePerVisitor', label: 'Revenue / visitor' },
  { key: 'conversionRate', label: 'Conversion' },
];

function ariaSort(
  sort: SourceTableSort,
  key: BreakdownSortKey,
): 'ascending' | 'descending' | 'none' {
  if (sort.key !== key) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

interface SourceTableProps {
  rows: BreakdownRow[];
  loading?: boolean;
  currency: string;
  dimensionLabel: string;
  sort: SourceTableSort;
  onSortChange: (sort: SourceTableSort) => void;
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export function SourceTable({
  rows,
  loading = false,
  currency,
  dimensionLabel,
  sort,
  onSortChange,
  page,
  pageSize,
  total,
  onPageChange,
}: SourceTableProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function toggleSort(key: BreakdownSortKey) {
    if (sort.key === key) {
      onSortChange({ key, direction: sort.direction === 'asc' ? 'desc' : 'asc' });
    } else {
      onSortChange({ key, direction: key === 'value' ? 'asc' : 'desc' });
    }
  }

  if (loading) {
    return <Skeleton className="table-skeleton" />;
  }

  if (rows.length === 0) {
    return <EmptyState title="No rows" message="No traffic matches this dimension and filter." />;
  }

  return (
    <div className="table-wrap">
      <table className="source-table">
        <thead>
          <tr>
            <th scope="col" aria-sort={ariaSort(sort, 'value')} className="source-table__value">
              <button
                type="button"
                className="source-table__sort"
                onClick={() => toggleSort('value')}
              >
                {dimensionLabel}
              </button>
            </th>
            {COLUMNS.map((column) => (
              <th key={column.key} scope="col" aria-sort={ariaSort(sort, column.key)}>
                <button
                  type="button"
                  className="source-table__sort"
                  onClick={() => toggleSort(column.key)}
                >
                  {column.label}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.value}>
              <th scope="row" className="source-table__value">
                {row.value}
              </th>
              <td>{formatNumber(row.visitors)}</td>
              <td>{formatNumber(row.pageviews)}</td>
              <td>{formatCurrency(row.revenue, currency)}</td>
              <td>{formatNumber(row.payments)}</td>
              <td>{formatCurrency(row.revenuePerVisitor, currency)}</td>
              <td>{row.conversionRate === undefined ? '—' : formatPercent(row.conversionRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="table-pagination">
        <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </button>
        <span className="muted">
          Page {page} of {totalPages}
        </span>
        <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
