import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMetadata } from '../api/analytics';
import { getFunnel } from '../api/funnel';
import { createFunnel, deleteFunnel, getFunnels, updateFunnel } from '../api/funnels';
import { getSites } from '../api/sites';
import type { FunnelDefinition, FunnelResult, Site, SiteMetadata } from '../api/types';
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

const site: Site = {
  id: 'site_1',
  name: 'Example Site',
  domain: 'example.com',
  timezone: 'UTC',
  currency: 'USD',
  createdAt: '2026-01-01T00:00:00Z',
};

const metadata: SiteMetadata = {
  siteId: 'site_1',
  domain: 'example.com',
  name: 'Example Site',
  timezone: 'UTC',
  currency: 'USD',
  kpi: null,
};

const definitions: FunnelDefinition[] = [
  {
    id: 'fun_1',
    name: 'Checkout',
    isActive: true,
    maxGapSeconds: 86400,
    steps: [
      { type: 'page', path: '/pricing', name: 'View pricing' },
      { type: 'goal', goal: 'payment', name: 'Payment' },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  },
  {
    id: 'fun_2',
    name: 'Signup',
    isActive: false,
    maxGapSeconds: null,
    steps: [{ type: 'page', path: '/', name: 'Landing' }],
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-02-02T00:00:00Z',
  },
];

vi.mock('../api/analytics', () => ({
  getMetadata: vi.fn(async () => metadata),
}));

vi.mock('../api/sites', () => ({
  getSites: vi.fn(async () => [site]),
}));

vi.mock('../api/funnel', () => ({
  getFunnel: vi.fn(async () => funnel),
}));

vi.mock('../api/funnels', () => ({
  getFunnels: vi.fn(),
  createFunnel: vi.fn(),
  updateFunnel: vi.fn(),
  deleteFunnel: vi.fn(),
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

function rowFor(name: string): HTMLElement {
  const row = screen.getByRole('rowheader', { name }).closest('tr');
  if (!row) throw new Error(`Missing row for ${name}`);
  return row;
}

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  vi.mocked(getMetadata).mockResolvedValue(metadata);
  vi.mocked(getSites).mockResolvedValue([site]);
  vi.mocked(getFunnel).mockResolvedValue(funnel);
  vi.mocked(getFunnels).mockResolvedValue({
    data: definitions,
    pagination: { limit: 100, offset: 0, total: definitions.length, hasMore: false },
  });
  vi.mocked(createFunnel).mockResolvedValue({ ...definitions[0], id: 'fun_9', name: 'Trial' });
  vi.mocked(updateFunnel).mockResolvedValue(definitions[0]);
  vi.mocked(deleteFunnel).mockResolvedValue(undefined);
});

describe('FunnelsPage', () => {
  it('shows the saved funnels list', async () => {
    renderPage();

    expect(await screen.findByRole('rowheader', { name: 'Checkout' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Signup' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New funnel' })).toBeInTheDocument();
    expect(within(rowFor('Checkout')).getByText('Active')).toBeInTheDocument();
    expect(within(rowFor('Signup')).getByText('Inactive')).toBeInTheDocument();
  });

  it('opens the builder and creates a funnel', async () => {
    renderPage();

    await screen.findByRole('rowheader', { name: 'Checkout' });
    await userEvent.click(screen.getByRole('button', { name: 'New funnel' }));

    expect(await screen.findByRole('heading', { name: 'New funnel' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name'), 'Trial');
    await userEvent.click(screen.getByRole('button', { name: 'Create funnel' }));

    await vi.waitFor(() => expect(createFunnel).toHaveBeenCalledTimes(1));
    expect(createFunnel).toHaveBeenCalledWith('site_1', expect.objectContaining({ name: 'Trial' }));
    expect(await screen.findByRole('heading', { name: 'Checkout' })).toBeInTheDocument();
  });

  it('edits a saved funnel from the list', async () => {
    renderPage();

    await screen.findByRole('rowheader', { name: 'Checkout' });
    await userEvent.click(within(rowFor('Checkout')).getByRole('button', { name: 'Edit' }));

    expect(await screen.findByRole('heading', { name: 'Edit funnel' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Checkout');

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await vi.waitFor(() => expect(updateFunnel).toHaveBeenCalledTimes(1));
    expect(updateFunnel).toHaveBeenCalledWith(
      'site_1',
      'fun_1',
      expect.objectContaining({ name: 'Checkout' }),
    );
  });

  it('deletes a saved funnel from the list', async () => {
    renderPage();

    await screen.findByRole('rowheader', { name: 'Checkout' });
    await userEvent.click(within(rowFor('Checkout')).getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(rowFor('Checkout')).getByRole('button', { name: 'Confirm' }));

    await vi.waitFor(() => expect(deleteFunnel).toHaveBeenCalledWith('site_1', 'fun_1'));
  });

  it('shows an error state when the list request fails', async () => {
    vi.mocked(getFunnels).mockRejectedValue(new Error('funnels failed'));
    renderPage();

    expect(await screen.findByText('Cannot load funnels')).toBeInTheDocument();
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
