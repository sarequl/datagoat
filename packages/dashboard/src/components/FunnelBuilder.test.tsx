import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFunnel, updateFunnel } from '../api/funnels';
import type { FunnelDefinition, Site } from '../api/types';
import { FunnelBuilder } from './FunnelBuilder';

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

const definition: FunnelDefinition = {
  id: 'fun_1',
  name: 'Checkout',
  isActive: true,
  maxGapSeconds: 86400,
  steps: [
    { type: 'page', path: '/pricing', name: 'View pricing' },
    { type: 'page', path: '/checkout', name: 'Start checkout' },
    { type: 'goal', goal: 'payment', name: 'Payment' },
  ],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

function renderBuilder(funnel?: FunnelDefinition) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  render(<FunnelBuilder funnel={funnel} onDone={onDone} onCancel={onCancel} />, { wrapper });
  return { onDone, onCancel };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createFunnel).mockResolvedValue({ ...definition, id: 'fun_3', name: 'Trial' });
  vi.mocked(updateFunnel).mockResolvedValue(definition);
});

describe('FunnelBuilder', () => {
  it('starts a new funnel with two empty steps', async () => {
    renderBuilder();

    expect(screen.getByRole('heading', { name: 'New funnel' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getAllByLabelText('Type')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Create funnel' })).toBeInTheDocument();
  });

  it('requires a name before saving', async () => {
    renderBuilder();

    await userEvent.click(screen.getByRole('button', { name: 'Create funnel' }));

    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    expect(createFunnel).not.toHaveBeenCalled();
  });

  it('creates a funnel with the edited steps', async () => {
    const { onDone } = renderBuilder();

    await userEvent.type(screen.getByLabelText('Name'), 'Trial');
    await userEvent.type(screen.getByLabelText('path'), '/pricing');
    await userEvent.type(screen.getAllByLabelText('goal')[0], 'signup');
    await userEvent.type(screen.getByLabelText('Max gap seconds (optional)'), '3600');
    await userEvent.click(screen.getByRole('button', { name: 'Add step' }));

    await userEvent.click(screen.getByRole('button', { name: 'Create funnel' }));

    await vi.waitFor(() => expect(createFunnel).toHaveBeenCalledTimes(1));
    expect(createFunnel).toHaveBeenCalledWith(
      'site_1',
      expect.objectContaining({
        name: 'Trial',
        isActive: true,
        maxGapSeconds: 3600,
      }),
    );
    const body = vi.mocked(createFunnel).mock.calls[0][1];
    expect(body.steps).toHaveLength(3);
    expect(onDone).toHaveBeenCalledWith('fun_3');
  });

  it('saves edits to an existing funnel', async () => {
    const { onDone } = renderBuilder(definition);

    expect(screen.getByRole('heading', { name: 'Edit funnel' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Checkout');
    expect(screen.getAllByLabelText('Type')).toHaveLength(3);

    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);

    expect(screen.getAllByLabelText('Type')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await vi.waitFor(() => expect(updateFunnel).toHaveBeenCalledTimes(1));
    expect(updateFunnel).toHaveBeenCalledWith(
      'site_1',
      'fun_1',
      expect.objectContaining({ name: 'Checkout' }),
    );
    const body = vi.mocked(updateFunnel).mock.calls[0][2];
    expect(body.steps).toHaveLength(2);
    expect(onDone).toHaveBeenCalledWith('fun_1');
  });

  it('keeps at least two steps', async () => {
    renderBuilder();

    expect(screen.getAllByLabelText('Type')).toHaveLength(2);
    for (const button of screen.getAllByRole('button', { name: 'Remove' })) {
      expect(button).toBeDisabled();
    }
  });

  it('validates the max gap value', async () => {
    renderBuilder();

    await userEvent.type(screen.getByLabelText('Name'), 'Trial');
    await userEvent.type(screen.getByLabelText('Max gap seconds (optional)'), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Create funnel' }));

    expect(
      await screen.findByText('Max gap seconds must be a positive integer.'),
    ).toBeInTheDocument();
    expect(createFunnel).not.toHaveBeenCalled();
  });

  it('cancels back to the list', async () => {
    const { onCancel } = renderBuilder();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
