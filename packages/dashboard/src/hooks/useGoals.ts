import { useQuery } from '@tanstack/react-query';
import { getGoals } from '../api/goals';

interface UseGoalsOptions {
  siteId?: string;
  startAt: string;
  endAt: string;
  timezone: string;
  limit: number;
  offset: number;
  order?: 'asc' | 'desc';
}

export function useGoals({
  siteId,
  startAt,
  endAt,
  timezone,
  limit,
  offset,
  order = 'desc',
}: UseGoalsOptions) {
  return useQuery({
    queryKey: ['goals', siteId, startAt, endAt, timezone, limit, offset, order],
    queryFn: () => getGoals({ siteId, startAt, endAt, timezone, limit, offset, order }),
    // dashboard.md §6: goals are fresh for five minutes.
    staleTime: 5 * 60_000,
  });
}
