import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteFunnel, getFunnels } from '../api/funnels';
import type { FunnelDefinition, Site } from '../api/types';
import { FunnelList } from './FunnelList';

vi.mock('../api/funnels', () => ({
  getFunnels: vi.fn(),
  createFunnel: vi.fn(),
  updateFunnel: vi.fn(),
  deleteFunnel: vi.fn(),
}));

const site: Site = {
  id: 'site_1',
  name: 'Example Site',
  domain: 'example.com',
  timezone: 'UTC',
  currency: 'USD',
  createdAt: '2026-01-01T00:00:00Z',
};

vi.mock('../hooks/useSelectedSite', () => ({
  useSelectedSite: () => ({ selectedSite: site }),
}));

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

function renderList(
  handlers: {
    onNew?: () => void;
    onEdit?: (id: string) => void;
    onView?: (id: string) => void;
  } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <FunnelList
        onNew={handlers.onNew ?? vi.fn()}
        onEdit={handlers.onEdit ?? vi.fn()}
        onView={handlers.onView ?? vi.fn()}
      />
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
  vi.mocked(getFunnels).mockResolvedValue({
    data: definitions,
    pagination: { limit: 100, offset: 0, total: definitions.length, hasMore: false },
  });
  vi.mocked(deleteFunnel).mockResolvedValue(undefined);
});

describe('FunnelList', () => {
  it('renders saved funnels with step counts and status', async () => {
    renderList();

    expect(await screen.findByRole('rowheader', { name: 'Checkout' })).toBeInTheDocument();
    const checkout = within(rowFor('Checkout'));
    expect(checkout.getByText('2')).toBeInTheDocument();
    expect(checkout.getByText('Active')).toBeInTheDocument();

    const signup = within(rowFor('Signup'));
    expect(signup.getByText('1')).toBeInTheDocument();
    expect(signup.getByText('Inactive')).toBeInTheDocument();
    expect(signup.getByRole('button', { name: 'Results' })).toBeDisabled();
  });

  it('opens the builder, editor, and results from the row actions', async () => {
    const onNew = vi.fn();
    const onEdit = vi.fn();
    const onView = vi.fn();
    renderList({ onNew, onEdit, onView });

    await screen.findByRole('rowheader', { name: 'Checkout' });

    await userEvent.click(screen.getByRole('button', { name: 'New funnel' }));
    expect(onNew).toHaveBeenCalledTimes(1);

    await userEvent.click(within(rowFor('Checkout')).getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledWith('fun_1');

    await userEvent.click(within(rowFor('Checkout')).getByRole('button', { name: 'Results' }));
    expect(onView).toHaveBeenCalledWith('fun_1');
  });

  it('deletes a funnel after an inline confirmation', async () => {
    renderList();

    await screen.findByRole('rowheader', { name: 'Checkout' });
    const calls = vi.mocked(getFunnels).mock.calls.length;

    await userEvent.click(within(rowFor('Checkout')).getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(rowFor('Checkout')).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(deleteFunnel).toHaveBeenCalledWith('site_1', 'fun_1'));
    await waitFor(() => expect(vi.mocked(getFunnels).mock.calls.length).toBeGreaterThan(calls));
  });

  it('cancels a delete without calling the api', async () => {
    renderList();

    await screen.findByRole('rowheader', { name: 'Checkout' });
    await userEvent.click(within(rowFor('Checkout')).getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(rowFor('Checkout')).getByRole('button', { name: 'Cancel' }));

    expect(deleteFunnel).not.toHaveBeenCalled();
  });

  it('shows an empty state when the site has no funnels', async () => {
    vi.mocked(getFunnels).mockResolvedValue({
      data: [],
      pagination: { limit: 100, offset: 0, total: 0, hasMore: false },
    });
    renderList();

    expect(await screen.findByText('No funnels yet')).toBeInTheDocument();
  });

  it('shows an error state with retry when the list fails', async () => {
    vi.mocked(getFunnels).mockRejectedValue(new Error('funnels failed'));
    renderList();

    expect(await screen.findByText('Cannot load funnels')).toBeInTheDocument();

    vi.mocked(getFunnels).mockResolvedValue({
      data: definitions,
      pagination: { limit: 100, offset: 0, total: definitions.length, hasMore: false },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('rowheader', { name: 'Checkout' })).toBeInTheDocument();
  });
});
