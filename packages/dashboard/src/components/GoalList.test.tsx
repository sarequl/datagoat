import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { GoalRow } from '../api/types';
import { GoalList, type GoalTableSort } from './GoalList';

const rows: GoalRow[] = [
  {
    value: 'signup',
    completions: 482,
    visitors: 391,
    pageviews: 0,
    revenue: 0,
    payments: 0,
    revenuePerVisitor: 0,
  },
  {
    value: 'payment',
    completions: 42,
    visitors: 42,
    pageviews: 0,
    revenue: 5310.5,
    payments: 42,
    revenuePerVisitor: 126.44,
  },
];

interface Overrides {
  loading?: boolean;
  emptyRows?: boolean;
  page?: number;
  total?: number;
  sort?: GoalTableSort;
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
    <GoalList
      rows={emptyRows ? [] : rows}
      loading={loading}
      currency="USD"
      sort={sort}
      onSortChange={vi.fn()}
      page={page}
      pageSize={25}
      total={total}
      onPageChange={onPageChange}
    />,
  );
}

describe('GoalList', () => {
  it('renders goal rows and formatted metrics', () => {
    renderTable();

    expect(screen.getByText('signup')).toBeInTheDocument();
    expect(screen.getByText('482')).toBeInTheDocument();
    expect(screen.getByText('$5,311')).toBeInTheDocument();
    expect(screen.getByText('$126')).toBeInTheDocument();
  });

  it('marks the active sort on the column header', () => {
    renderTable();

    expect(screen.getByRole('columnheader', { name: 'Visitors' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(screen.getByRole('columnheader', { name: 'Completions' })).toHaveAttribute(
      'aria-sort',
      'none',
    );
  });

  it('starts a new column descending and toggles the active column', async () => {
    const onSortChange = vi.fn();
    const { rerender } = render(
      <GoalList
        rows={rows}
        currency="USD"
        sort={{ key: 'visitors', direction: 'desc' }}
        onSortChange={onSortChange}
        page={1}
        pageSize={25}
        total={2}
        onPageChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Completions' }));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'completions', direction: 'desc' });

    rerender(
      <GoalList
        rows={rows}
        currency="USD"
        sort={{ key: 'completions', direction: 'desc' }}
        onSortChange={onSortChange}
        page={1}
        pageSize={25}
        total={2}
        onPageChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Completions' }));
    expect(onSortChange).toHaveBeenLastCalledWith({ key: 'completions', direction: 'asc' });
  });

  it('disables pagination at the page bounds', async () => {
    const onPageChange = vi.fn();
    const { rerender } = renderTable({ page: 1, total: 60, onPageChange });

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenCalledWith(2);

    rerender(
      <GoalList
        rows={rows}
        currency="USD"
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
    expect(screen.queryByText('signup')).not.toBeInTheDocument();
  });

  it('renders an empty state without rows', () => {
    renderTable({ emptyRows: true });

    expect(screen.getByText('No goals')).toBeInTheDocument();
  });
});
