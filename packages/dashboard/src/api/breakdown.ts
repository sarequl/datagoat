import type { RangeParams } from './analytics';
import { type ApiResponse, apiFetch } from './client';
import { buildQuery } from './query';
import type { BreakdownRow } from './types';

export type BreakdownDimension =
  | 'pages'
  | 'referrers'
  | 'campaigns'
  | 'countries'
  | 'devices'
  | 'browsers';

export interface BreakdownParams extends RangeParams {
  path?: string;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

export function getBreakdown(
  dimension: BreakdownDimension,
  params: BreakdownParams = {},
): Promise<ApiResponse<BreakdownRow[]>> {
  const query = buildQuery({
    siteId: params.siteId,
    startAt: params.startAt,
    endAt: params.endAt,
    timezone: params.timezone,
    path: params.path,
    limit: params.limit,
    offset: params.offset,
    order: params.order,
  });
  return apiFetch<BreakdownRow[]>(`/analytics/${dimension}${query}`);
}
