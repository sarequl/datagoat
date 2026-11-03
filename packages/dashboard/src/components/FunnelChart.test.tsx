import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FunnelStepResult } from '../api/types';
import { FunnelChart } from './FunnelChart';

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

const steps: FunnelStepResult[] = [
  {
    step: 1,
    name: 'View pricing',
    visitors: 1204,
    conversionRate: 1,
    dropoffRate: 0,
    revenue: 0,
    payments: 0,
  },
  {
    step: 2,
    name: 'Payment',
    visitors: 42,
    conversionRate: 0.0349,
    dropoffRate: 0.8645,
    revenue: 5310.5,
    payments: 42,
  },
];

describe('FunnelChart', () => {
  it('renders every step in the data table fallback', () => {
    render(<FunnelChart steps={steps} currency="USD" />);

    const table = screen.getByRole('table', { name: 'Funnel steps' });
    expect(within(table).getByText('View pricing')).toBeInTheDocument();
    expect(within(table).getByText('Payment')).toBeInTheDocument();
    expect(within(table).getByText('$5,311')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(3);
  });

  it('describes the funnel for screen readers', () => {
    render(<FunnelChart steps={steps} currency="USD" />);

    expect(screen.getByRole('img')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('View pricing'),
    );
  });
});
