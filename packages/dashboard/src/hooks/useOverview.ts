import { useQuery } from '@tanstack/react-query';
import { getOverview } from '../api/analytics';
import type { Overview } from '../api/types';
import { previousRange } from '../utils/period';

interface UseOverviewOptions {
  startAt: string;
  endAt: string;
  timezone: string;
  compare: boolean;
}

async function fetchOverview({
  startAt,
  endAt,
  timezone,
  compare,
}: UseOverviewOptions): Promise<Overview> {
  const data = await getOverview({ startAt, endAt, timezone, compare });
  if (!compare || data.previous) {
    return data;
  }
  // Fallback: the Worker may not return a `previous` block yet. Fetch the
  // immediately preceding equal-length range and use it for the delta chips.
  const prior = previousRange(startAt, endAt);
  const priorData = await getOverview({ startAt: prior.startAt, endAt: prior.endAt, timezone });
  return { ...data, previous: priorData };
}

export function useOverview({ startAt, endAt, timezone, compare }: UseOverviewOptions) {
  return useQuery({
    queryKey: ['overview', startAt, endAt, timezone, compare],
    queryFn: () => fetchOverview({ startAt, endAt, timezone, compare }),
    staleTime: 60_000,
  });
}
