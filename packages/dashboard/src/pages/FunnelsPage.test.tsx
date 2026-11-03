import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunnel } from '../api/funnel';
import type { FunnelResult } from '../api/types';
import { FunnelsPage } from './FunnelsPage';

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
  ],
  totalVisitors: 1204,
  totalConversionRate: 1,
  revenue: 0,
  payments: 0,
  revenuePerVisitor: 0,
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

function renderPage(path = '/funnels') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <FunnelsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
});

describe('FunnelsPage', () => {
  it('prompts for a funnel when none is selected', () => {
    renderPage();

    expect(screen.getByText('No funnel selected')).toBeInTheDocument();
  });

  it('renders the results for the funnel in the URL', async () => {
    renderPage('/funnels?funnel=fun_1');

    expect(await screen.findByText('Checkout')).toBeInTheDocument();
    expect(getFunnel).toHaveBeenCalledWith('fun_1', expect.objectContaining({ siteId: 'site_1' }));
  });

  it('shows an error state when the funnel request fails', async () => {
    vi.mocked(getFunnel).mockImplementation(async () => {
      throw new Error('funnel failed');
    });
    renderPage('/funnels?funnel=fun_1');

    expect(await screen.findByText('Cannot load funnel')).toBeInTheDocument();
  });
});
