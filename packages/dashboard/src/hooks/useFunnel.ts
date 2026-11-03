import { useQuery } from '@tanstack/react-query';
import { getFunnel } from '../api/funnel';

interface UseFunnelOptions {
  funnelId: string;
  siteId?: string;
  startAt: string;
  endAt: string;
  timezone: string;
}

export function useFunnel({ funnelId, siteId, startAt, endAt, timezone }: UseFunnelOptions) {
  return useQuery({
    queryKey: ['funnel', funnelId, siteId, startAt, endAt, timezone],
    queryFn: () => getFunnel(funnelId, { siteId, startAt, endAt, timezone }),
    // dashboard.md §6: funnels are fresh for five minutes.
    staleTime: 5 * 60_000,
  });
}
