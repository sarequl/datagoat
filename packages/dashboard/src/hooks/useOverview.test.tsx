import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOverview } from '../api/analytics';
import type { Overview } from '../api/types';
import { useOverview } from './useOverview';

vi.mock('../api/analytics', () => ({
  getOverview: vi.fn(),
}));

const current: Overview = {
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
};

const prior: Overview = { ...current, visitors: 80 };

const options = { startAt: '2026-01-08', endAt: '2026-01-14', timezone: 'UTC' };

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  queryClient.clear();
  vi.resetAllMocks();
});

describe('useOverview', () => {
  it('uses the previous block returned by the API', async () => {
    vi.mocked(getOverview).mockResolvedValue({ ...current, previous: prior });

    const { result } = renderHook(() => useOverview({ ...options, compare: true }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.data?.previous?.visitors).toBe(80));
    expect(vi.mocked(getOverview)).toHaveBeenCalledTimes(1);
  });

  it('falls back to the prior equal-length range when previous is missing', async () => {
    vi.mocked(getOverview).mockImplementation(async (params) =>
      params?.startAt === '2026-01-08' ? current : prior,
    );

    const { result } = renderHook(() => useOverview({ ...options, compare: true }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.data?.previous?.visitors).toBe(80));
    expect(vi.mocked(getOverview)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getOverview).mock.calls[1][0]).toMatchObject({
      startAt: '2026-01-01',
      endAt: '2026-01-07',
    });
  });

  it('does not fetch a previous block when compare is off', async () => {
    vi.mocked(getOverview).mockResolvedValue(current);

    const { result } = renderHook(() => useOverview({ ...options, compare: false }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.data?.visitors).toBe(100));
    expect(vi.mocked(getOverview)).toHaveBeenCalledTimes(1);
    expect(result.current.data?.previous).toBeUndefined();
  });
});
