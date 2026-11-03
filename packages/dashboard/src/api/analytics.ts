import { apiFetch } from './client';
import type { Overview, SiteMetadata, Timeseries } from './types';

export type Interval = 'hour' | 'day' | 'week' | 'month';

export interface RangeParams {
  startAt?: string;
  endAt?: string;
  timezone?: string;
  compare?: boolean;
}

export interface TimeseriesParams extends RangeParams {
  interval?: Interval;
  fields?: string[];
}

function buildQuery(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      query.set(key, value);
    }
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

export async function getMetadata(): Promise<SiteMetadata> {
  const response = await apiFetch<SiteMetadata>('/analytics/metadata');
  return response.data;
}

export async function getOverview(params: RangeParams = {}): Promise<Overview> {
  const query = buildQuery({
    startAt: params.startAt,
    endAt: params.endAt,
    timezone: params.timezone,
    ...(params.compare ? { compare: 'previous' } : {}),
  });
  const response = await apiFetch<Overview>(`/analytics/overview${query}`);
  return response.data;
}

export async function getTimeseries(params: TimeseriesParams = {}): Promise<Timeseries> {
  const query = buildQuery({
    startAt: params.startAt,
    endAt: params.endAt,
    timezone: params.timezone,
    interval: params.interval,
    fields: params.fields?.join(','),
  });
  const response = await apiFetch<Timeseries>(`/analytics/timeseries${query}`);
  return response.data;
}
