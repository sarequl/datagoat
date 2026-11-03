import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BreakdownRow } from '../api/types';
import { SourceChart } from './SourceChart';

vi.mock('chart.js', () => {
  class FakeChart {
    static register = vi.fn();

    destroy = vi.fn();
  }
  return {
    Chart: FakeChart,
    BarController: class {},
    BarElement: class {},
    CategoryScale: class {},
    Legend: class {},
    LinearScale: class {},
    Tooltip: class {},
  };
});

function makeRows(count: number): BreakdownRow[] {
  return Array.from({ length: count }, (_, index) => ({
    value: `source-${index + 1}`,
    visitors: count - index,
    pageviews: (count - index) * 2,
    revenue: 100,
    payments: 1,
    revenuePerVisitor: 1,
  }));
}

describe('SourceChart', () => {
  it('renders only the top ten rows in the data table', () => {
    render(<SourceChart rows={makeRows(14)} label="Referrers" />);

    const table = screen.getByRole('table', { name: 'Top Referrers by visitors' });
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    expect(within(table).getByText('source-1')).toBeInTheDocument();
    expect(within(table).queryByText('source-11')).not.toBeInTheDocument();
  });

  it('describes the chart for screen readers', () => {
    render(<SourceChart rows={makeRows(2)} label="Referrers" />);

    expect(screen.getByRole('img')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('source-1'),
    );
  });
});
