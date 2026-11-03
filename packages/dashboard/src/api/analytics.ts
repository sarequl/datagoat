import { apiFetch } from './client';
import { buildQuery } from './query';
import type { Overview, SiteMetadata, Timeseries } from './types';

export type Interval = 'hour' | 'day' | 'week' | 'month';

export interface RangeParams {
  siteId?: string;
  startAt?: string;
  endAt?: string;
  timezone?: string;
  compare?: boolean;
}

export interface TimeseriesParams extends RangeParams {
  interval?: Interval;
  fields?: string[];
}

export async function getMetadata(params: RangeParams = {}): Promise<SiteMetadata> {
  const query = buildQuery({ siteId: params.siteId });
  const response = await apiFetch<SiteMetadata>(`/analytics/metadata${query}`);
  return response.data;
}

export async function getOverview(params: RangeParams = {}): Promise<Overview> {
  const query = buildQuery({
    siteId: params.siteId,
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
    siteId: params.siteId,
    startAt: params.startAt,
    endAt: params.endAt,
    timezone: params.timezone,
    interval: params.interval,
    fields: params.fields?.join(','),
  });
  const response = await apiFetch<Timeseries>(`/analytics/timeseries${query}`);
  return response.data;
}
