import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFunnel, deleteFunnel, getFunnels, updateFunnel } from '../api/funnels';
import type { FunnelDefinition } from '../api/types';
import { useFunnelMutations, useFunnels } from './useFunnels';

vi.mock('../api/funnels', () => ({
  getFunnels: vi.fn(),
  createFunnel: vi.fn(),
  updateFunnel: vi.fn(),
  deleteFunnel: vi.fn(),
}));

const definition: FunnelDefinition = {
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
};

function createClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createClient()}>{children}</QueryClientProvider>;
}

function useHarness(siteId: string | undefined) {
  const list = useFunnels({ siteId });
  const mutations = useFunnelMutations(siteId);
  return { list, mutations };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getFunnels).mockResolvedValue({
    data: [definition],
    pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
  });
  vi.mocked(createFunnel).mockResolvedValue({ ...definition, id: 'fun_3', name: 'Trial' });
  vi.mocked(updateFunnel).mockResolvedValue({ ...definition, name: 'Checkout v2' });
  vi.mocked(deleteFunnel).mockResolvedValue(undefined);
});

describe('useFunnels', () => {
  it('fetches the saved funnel definitions for a site', async () => {
    const { result } = renderHook(() => useFunnels({ siteId: 'site_1' }), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getFunnels).toHaveBeenCalledWith('site_1', {
      limit: 100,
      offset: 0,
      order: 'desc',
    });
    expect(result.current.data?.data[0].id).toBe('fun_1');
  });

  it('skips the request until a site is selected', () => {
    const { result } = renderHook(() => useFunnels({}), { wrapper: Wrapper });

    expect(getFunnels).not.toHaveBeenCalled();
    expect(result.current.isPending).toBe(true);
  });
});

describe('useFunnelMutations', () => {
  it('creates a funnel and refreshes the list', async () => {
    const queryClient = createClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useHarness('site_1'), { wrapper });

    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    const calls = vi.mocked(getFunnels).mock.calls.length;

    act(() => {
      result.current.mutations.create.mutate({ name: 'Trial', steps: definition.steps });
    });

    await waitFor(() => expect(result.current.mutations.create.isSuccess).toBe(true));
    expect(createFunnel).toHaveBeenCalledWith('site_1', expect.objectContaining({ name: 'Trial' }));
    await waitFor(() => expect(vi.mocked(getFunnels).mock.calls.length).toBeGreaterThan(calls));
  });

  it('updates a funnel and refreshes the list', async () => {
    const { result } = renderHook(() => useHarness('site_1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    const calls = vi.mocked(getFunnels).mock.calls.length;

    act(() => {
      result.current.mutations.update.mutate({
        funnelId: 'fun_1',
        body: { name: 'Checkout v2' },
      });
    });

    await waitFor(() => expect(result.current.mutations.update.isSuccess).toBe(true));
    expect(updateFunnel).toHaveBeenCalledWith(
      'site_1',
      'fun_1',
      expect.objectContaining({ name: 'Checkout v2' }),
    );
    await waitFor(() => expect(vi.mocked(getFunnels).mock.calls.length).toBeGreaterThan(calls));
  });

  it('deletes a funnel and refreshes the list', async () => {
    const { result } = renderHook(() => useHarness('site_1'), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    const calls = vi.mocked(getFunnels).mock.calls.length;

    act(() => {
      result.current.mutations.remove.mutate('fun_1');
    });

    await waitFor(() => expect(result.current.mutations.remove.isSuccess).toBe(true));
    expect(deleteFunnel).toHaveBeenCalledWith('site_1', 'fun_1');
    await waitFor(() => expect(vi.mocked(getFunnels).mock.calls.length).toBeGreaterThan(calls));
  });

  it('does not invalidate a list for another site', async () => {
    const queryClient = createClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useHarness('site_1'), { wrapper });

    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    const otherKey = ['funnels', 'site_2', 100, 0, 'desc'];
    queryClient.setQueryData(otherKey, {
      data: [],
      pagination: { limit: 100, offset: 0, total: 0, hasMore: false },
    });

    act(() => {
      result.current.mutations.remove.mutate('fun_1');
    });

    await waitFor(() => expect(result.current.mutations.remove.isSuccess).toBe(true));
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });
});
