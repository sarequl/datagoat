import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunnel } from '../api/funnel';
import type { FunnelResult } from '../api/types';
import { FunnelResults } from './FunnelResults';

const funnel: FunnelResult = {
  id: 'fun_1',
  name: 'Checkout',
  steps: [
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
      name: 'Start checkout',
      visitors: 310,
      conversionRate: 0.2574,
      dropoffRate: 0.7426,
      revenue: 0,
      payments: 0,
    },
    {
      step: 3,
      name: 'Payment',
      visitors: 42,
      conversionRate: 0.0349,
      dropoffRate: 0.8645,
      revenue: 5310.5,
      payments: 42,
    },
  ],
  totalVisitors: 1204,
  totalConversionRate: 0.0349,
  revenue: 5310.5,
  payments: 42,
  revenuePerVisitor: 4.4111,
  timezone: 'UTC',
  startAt: '2026-11-01',
  endAt: '2026-11-03',
  lastUpdated: '2026-11-03T08:00:00Z',
};

vi.mock('../api/analytics', () => ({
  getMetadata: vi.fn(async () => ({
    siteId: 'site_1',
    domain: 'example.com',
    name: 'Example Site',
    timezone: 'UTC',
    currency: 'USD',
    kpi: null,
  })),
}));

vi.mock('../api/sites', () => ({
  getSites: vi.fn(async () => [
    {
      id: 'site_1',
      name: 'Example Site',
      domain: 'example.com',
      timezone: 'UTC',
      currency: 'USD',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ]),
}));

vi.mock('../api/funnel', () => ({
  getFunnel: vi.fn(async () => funnel),
}));

vi.mock('../components/FunnelChart', () => ({
  FunnelChart: () => <div data-testid="funnel-chart" />,
}));

function renderResults() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <FunnelResults funnelId="fun_1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
});

describe('FunnelResults', () => {
  it('renders the funnel name, KPIs, chart, and step table', async () => {
    renderResults();

    expect(await screen.findByText('Checkout')).toBeInTheDocument();
    expect(screen.getByText('Total visitors')).toBeInTheDocument();
    expect(screen.getByText('Total conversion')).toBeInTheDocument();
    expect(screen.getByTestId('funnel-chart')).toBeInTheDocument();
    expect(screen.getByText('View pricing')).toBeInTheDocument();
    expect(screen.getByText('Payment')).toBeInTheDocument();
  });

  it('requests the funnel results for the selected site', async () => {
    renderResults();
    await screen.findByText('Checkout');

    expect(getFunnel).toHaveBeenCalledWith(
      'fun_1',
      expect.objectContaining({ siteId: 'site_1', timezone: 'UTC' }),
    );
  });

  it('shows an error state when the request fails', async () => {
    vi.mocked(getFunnel).mockImplementation(async () => {
      throw new Error('funnel failed');
    });
    renderResults();

    expect(await screen.findByText('Cannot load funnel')).toBeInTheDocument();
  });
});
