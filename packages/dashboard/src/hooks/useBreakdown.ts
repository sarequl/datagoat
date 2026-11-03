import { useQuery } from '@tanstack/react-query';
import { type BreakdownDimension, getBreakdown } from '../api/breakdown';

interface UseBreakdownOptions {
  dimension: BreakdownDimension;
  siteId?: string;
  startAt: string;
  endAt: string;
  timezone: string;
  path?: string;
  limit: number;
  offset: number;
  order?: 'asc' | 'desc';
}

export function useBreakdown({
  dimension,
  siteId,
  startAt,
  endAt,
  timezone,
  path,
  limit,
  offset,
  order = 'desc',
}: UseBreakdownOptions) {
  return useQuery({
    queryKey: [
      'breakdown',
      dimension,
      siteId,
      startAt,
      endAt,
      timezone,
      path ?? '',
      limit,
      offset,
      order,
    ],
    queryFn: () =>
      getBreakdown(dimension, {
        siteId,
        startAt,
        endAt,
        timezone,
        path,
        limit,
        offset,
        order,
      }),
    enabled: Boolean(siteId),
    staleTime: 60_000,
  });
}
