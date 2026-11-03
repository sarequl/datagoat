import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGoals } from '../api/goals';
import type { GoalRow } from '../api/types';
import { GoalsPage } from './GoalsPage';

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

vi.mock('../api/goals', () => ({
  getGoals: vi.fn(async () => ({
    data: rows,
    pagination: { limit: 25, offset: 0, total: 2, hasMore: false },
  })),
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <GoalsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
});

describe('GoalsPage', () => {
  it('renders goal rows from the goals endpoint', async () => {
    renderPage();

    expect(await screen.findByText('signup')).toBeInTheDocument();
    expect(screen.getByText('payment')).toBeInTheDocument();
    expect(screen.getByText('482')).toBeInTheDocument();
  });

  it('requests the selected site with pagination', async () => {
    renderPage();
    await screen.findByText('signup');

    expect(getGoals).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'site_1', limit: 25, offset: 0 }),
    );
  });

  it('shows an error state when the request fails', async () => {
    vi.mocked(getGoals).mockImplementation(async () => {
      throw new Error('goals failed');
    });
    renderPage();

    expect(await screen.findByText('Cannot load goals')).toBeInTheDocument();
  });
});
