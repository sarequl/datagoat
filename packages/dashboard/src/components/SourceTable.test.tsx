import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BreakdownRow } from '../api/types';
import { SourceTable, type SourceTableSort } from './SourceTable';

const rows: BreakdownRow[] = [
  {
    value: 'google.com',
    visitors: 2400,
    pageviews: 4800,
    revenue: 528,
    payments: 4,
    revenuePerVisitor: 0.22,
  },
  {
    value: 'twitter.com',
    visitors: 1200,
    pageviews: 2400,
    revenue: 240,
    payments: 2,
    revenuePerVisitor: 0.2,
  },
];

interface Overrides {
  loading?: boolean;
  emptyRows?: boolean;
  page?: number;
  total?: number;
  sort?: SourceTableSort;
  onPageChange?: (page: number) => void;
}

function renderTable(overrides: Overrides = {}) {
  const {
    loading = false,
    emptyRows = false,
    page = 1,
    total = 2,
    sort = { key: 'visitors', direction: 'desc' },
    onPageChange = vi.fn(),
  } = overrides;
  return render(
    <SourceTable
      rows={emptyRows ? [] : rows}
      loading={loading}
      currency="USD"
      dimensionLabel="Referrer"
      sort={sort}
      onSortChange={vi.fn()}
      page={page}
      pageSize={25}
      total={total}
      onPageChange={onPageChange}
    />,
  );
}

describe('SourceTable', () => {
  it('renders row values and formatted metrics', () => {
    renderTable();

    expect(screen.getByText('google.com')).toBeInTheDocument();
    expect(screen.getAllByText('2,400')).toHaveLength(2);
    expect(screen.getByText('$528')).toBeInTheDocument();
    expect(screen.getByText('$0.22')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('marks the active sort on the column header', () => {
    renderTable();

    expect(screen.getByRole('columnheader', { name: 'Visitors' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(screen.getByRole('columnheader', { name: 'Pageviews' })).toHaveAttribute(
      'aria-sort',
      'none',
    );
  });

  it('starts a new column descending and toggles the active column', async () => {
    const onSortChange = vi.fn();
    const { rerender } = render(
      <SourceTable
        rows={rows}
        currency="USD"
        dimensionLabel="Referrer"
        sort={{ key: 'visitors', direction: 'desc' }}
        onSortChange={onSortChange}
        page={1}
        pageSize={25}
        total={2}
        onPageChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Pageviews' }));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'pageviews', direction: 'desc' });

    rerender(
      <SourceTable
        rows={rows}
        currency="USD"
        dimensionLabel="Referrer"
        sort={{ key: 'pageviews', direction: 'desc' }}
        onSortChange={onSortChange}
        page={1}
        pageSize={25}
        total={2}
        onPageChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Pageviews' }));
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'pageviews', direction: 'asc' });
  });

  it('disables pagination at the page bounds', async () => {
    const onPageChange = vi.fn();
    const { rerender } = renderTable({ page: 1, total: 60, onPageChange });

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenCalledWith(2);

    rerender(
      <SourceTable
        rows={rows}
        currency="USD"
        dimensionLabel="Referrer"
        sort={{ key: 'visitors', direction: 'desc' }}
        onSortChange={vi.fn()}
        page={3}
        pageSize={25}
        total={60}
        onPageChange={onPageChange}
      />,
    );
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('renders a skeleton while loading', () => {
    const { container } = renderTable({ loading: true, emptyRows: true });

    expect(container.querySelector('.table-skeleton')).not.toBeNull();
    expect(screen.queryByText('google.com')).not.toBeInTheDocument();
  });

  it('renders an empty state without rows', () => {
    renderTable({ emptyRows: true });

    expect(screen.getByText('No rows')).toBeInTheDocument();
  });
});
