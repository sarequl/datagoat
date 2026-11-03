import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOverview } from '../api/analytics';
import { getBreakdown } from '../api/breakdown';
import { DashboardPage } from './DashboardPage';

vi.mock('../api/analytics', () => ({
  getMetadata: vi.fn(async () => ({
    siteId: 'site_1',
    domain: 'example.com',
    name: 'Example Site',
    timezone: 'UTC',
    currency: 'USD',
    kpi: 'revenue',
  })),
  getOverview: vi.fn(async (params: { compare?: boolean }) =>
    params.compare
      ? {
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
        }
      : {
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
        },
  ),
  getTimeseries: vi.fn(async () => ({
    interval: 'day',
    fields: ['visitors', 'pageviews', 'revenue'],
    timezone: 'UTC',
    currency: 'USD',
    points: [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        visitors: 100,
        pageviews: 200,
        sessions: 80,
        revenue: 50,
        payments: 1,
      },
    ],
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

vi.mock('../api/breakdown', () => ({
  getBreakdown: vi.fn(async (dimension: string) => ({
    data: [
      {
        value: `${dimension}-row`,
        visitors: 2400,
        pageviews: 4800,
        revenue: 528,
        payments: 4,
        revenuePerVisitor: 0.22,
      },
    ],
    pagination: { limit: 25, offset: 0, total: 1, hasMore: false },
  })),
}));

// jsdom has no canvas 2d context, and the page only needs the chart's slot here.
vi.mock('../components/charts/TimeseriesChart', () => ({
  TimeseriesChart: ({ data }: { data: { interval: string } }) => (
    <div data-testid="timeseries-chart">{data.interval}</div>
  ),
}));

vi.mock('../components/SourceChart', () => ({
  SourceChart: () => <div data-testid="source-chart" />,
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
});

describe('DashboardPage', () => {
  it('renders the KPI grid from the overview endpoint', async () => {
    renderPage();

    expect(await screen.findByText('100')).toBeInTheDocument();
    expect(screen.getByText('300')).toBeInTheDocument();
    expect(screen.getByText('$200')).toBeInTheDocument();
  });

  it('renders the lazy timeseries chart from the timeseries endpoint', async () => {
    renderPage();

    expect(await screen.findByTestId('timeseries-chart')).toHaveTextContent('day');
  });

  it('hides delta chips until compare is enabled', async () => {
    renderPage();
    await screen.findByText('100');

    expect(screen.queryByText('+100.0%')).not.toBeInTheDocument();
  });

  it('shows delta chips when compare is enabled', async () => {
    renderPage();
    await screen.findByText('100');

    await userEvent.click(screen.getByLabelText('Compare to previous'));

    expect(await screen.findAllByText('+100.0%')).not.toHaveLength(0);
  });

  it('shows an error state when the overview request fails', async () => {
    vi.mocked(getOverview).mockImplementation(async () => {
      throw new Error('overview failed');
    });
    renderPage();

    expect(await screen.findByText('Cannot load overview')).toBeInTheDocument();
  });

  it('renders the source tabs and the default referrers breakdown', async () => {
    renderPage();

    expect(await screen.findByText('referrers-row')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Referrers' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('source-chart')).toBeInTheDocument();
  });

  it('requests the selected dimension when a tab is clicked', async () => {
    renderPage();
    await screen.findByText('referrers-row');

    await userEvent.click(screen.getByRole('tab', { name: 'Pages' }));

    expect(await screen.findByText('pages-row')).toBeInTheDocument();
    expect(getBreakdown).toHaveBeenCalledWith(
      'pages',
      expect.objectContaining({ limit: 25, offset: 0 }),
    );
  });

  it('applies the path filter after the debounce', async () => {
    renderPage();
    await screen.findByText('referrers-row');

    await userEvent.type(screen.getByLabelText('Filter by path'), '/blog');

    await waitFor(() => {
      expect(getBreakdown).toHaveBeenCalledWith(
        'referrers',
        expect.objectContaining({ path: '/blog' }),
      );
    });
  });

  it('shows an error state when the breakdown request fails', async () => {
    vi.mocked(getBreakdown).mockImplementation(async () => {
      throw new Error('breakdown failed');
    });
    renderPage();

    expect(await screen.findByText('Cannot load breakdown')).toBeInTheDocument();
  });
});
