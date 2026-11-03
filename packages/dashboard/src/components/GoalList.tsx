import type { GoalRow } from '../api/types';
import { formatCurrency, formatNumber } from '../utils/format';
import type { GoalSortKey } from '../utils/goals';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';

export interface GoalTableSort {
  key: GoalSortKey;
  direction: 'asc' | 'desc';
}

interface Column {
  key: GoalSortKey;
  label: string;
}

const COLUMNS: Column[] = [
  { key: 'visitors', label: 'Visitors' },
  { key: 'completions', label: 'Completions' },
  { key: 'revenue', label: 'Revenue (est.)' },
  { key: 'payments', label: 'Payments' },
  { key: 'revenuePerVisitor', label: 'Revenue / visitor' },
];

function ariaSort(sort: GoalTableSort, key: GoalSortKey): 'ascending' | 'descending' | 'none' {
  if (sort.key !== key) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

interface GoalListProps {
  rows: GoalRow[];
  loading?: boolean;
  currency: string;
  sort: GoalTableSort;
  onSortChange: (sort: GoalTableSort) => void;
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export function GoalList({
  rows,
  loading = false,
  currency,
  sort,
  onSortChange,
  page,
  pageSize,
  total,
  onPageChange,
}: GoalListProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function toggleSort(key: GoalSortKey) {
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
    return <EmptyState title="No goals" message="No goals match this period." />;
  }

  return (
    <div className="table-wrap">
      <table className="source-table goal-table">
        <thead>
          <tr>
            <th scope="col" aria-sort={ariaSort(sort, 'value')} className="source-table__value">
              <button
                type="button"
                className="source-table__sort"
                onClick={() => toggleSort('value')}
              >
                Goal
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
              <td>{formatNumber(row.completions)}</td>
              <td>{formatCurrency(row.revenue, currency)}</td>
              <td>{formatNumber(row.payments)}</td>
              <td>{formatCurrency(row.revenuePerVisitor, currency)}</td>
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
