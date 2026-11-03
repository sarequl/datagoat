import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Overview } from '../api/types';
import { KpiGrid } from './KpiGrid';

const overview: Overview = {
  visitors: 100,
  sessions: 120,
  pageviews: 300,
  bounceRate: 0.5,
  avgSessionDuration: 60,
  currency: 'USD',
  revenue: 200,
  payments: 2,
  revenuePerVisitor: 2,
  conversionRate: 0.02,
  previous: {
    visitors: 50,
    sessions: 60,
    pageviews: 150,
    bounceRate: 0.6,
    avgSessionDuration: 30,
    currency: 'USD',
    revenue: 100,
    payments: 1,
    revenuePerVisitor: 2,
    conversionRate: 0.02,
  },
};

describe('KpiGrid', () => {
  it('renders one card per metric', () => {
    render(<KpiGrid overview={overview} currency="USD" />);
    expect(screen.getByText('Visitors')).toBeInTheDocument();
    expect(screen.getByText('Revenue (est.)')).toBeInTheDocument();
    expect(screen.getByText('Bounce rate')).toBeInTheDocument();
  });

  it('shows a delta chip when a previous block is present', () => {
    render(<KpiGrid overview={overview} currency="USD" />);
    expect(screen.getAllByText(/\+100\.0%/).length).toBeGreaterThan(0);
  });

  it('hides delta chips without a previous block', () => {
    const { previous, ...withoutPrevious } = overview;
    render(<KpiGrid overview={withoutPrevious} currency="USD" />);
    expect(screen.queryByText(/\+100\.0%/)).not.toBeInTheDocument();
  });

  it('renders skeletons while loading', () => {
    render(<KpiGrid currency="USD" loading />);
    expect(screen.getByText('Visitors')).toBeInTheDocument();
    expect(screen.getByText('Revenue (est.)')).toBeInTheDocument();
  });
});
