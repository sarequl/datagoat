import { useQuery } from '@tanstack/react-query';
import { getTimeseries, type Interval } from '../api/analytics';

interface UseTimeseriesOptions {
  siteId?: string;
  startAt: string;
  endAt: string;
  timezone: string;
  interval: Interval;
  fields: string[];
}

export function useTimeseries({
  siteId,
  startAt,
  endAt,
  timezone,
  interval,
  fields,
}: UseTimeseriesOptions) {
  return useQuery({
    queryKey: ['timeseries', siteId, startAt, endAt, timezone, interval, fields],
    queryFn: () => getTimeseries({ siteId, startAt, endAt, timezone, interval, fields }),
    staleTime: 60_000,
  });
}
