import { useQuery } from '@tanstack/react-query';
import { getTimeseries, type Interval } from '../api/analytics';

interface UseTimeseriesOptions {
  startAt: string;
  endAt: string;
  timezone: string;
  interval: Interval;
  fields: string[];
}

export function useTimeseries({
  startAt,
  endAt,
  timezone,
  interval,
  fields,
}: UseTimeseriesOptions) {
  return useQuery({
    queryKey: ['timeseries', startAt, endAt, timezone, interval, fields],
    queryFn: () => getTimeseries({ startAt, endAt, timezone, interval, fields }),
    staleTime: 60_000,
  });
}
