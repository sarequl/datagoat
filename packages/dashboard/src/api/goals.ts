import { type ApiResponse, apiFetch } from './client';
import { buildQuery } from './query';
import type { GoalRow } from './types';

export interface GoalsParams {
  siteId?: string;
  startAt?: string;
  endAt?: string;
  timezone?: string;
  limit?: number;
  offset?: number;
  /** `api.md` §2.7.9: goals sort by visitors descending unless `order=asc`. */
  order?: 'asc' | 'desc';
}

export function getGoals(params: GoalsParams = {}): Promise<ApiResponse<GoalRow[]>> {
  const query = buildQuery({
    siteId: params.siteId,
    startAt: params.startAt,
    endAt: params.endAt,
    timezone: params.timezone,
    limit: params.limit,
    offset: params.offset,
    order: params.order,
  });
  return apiFetch<GoalRow[]>(`/analytics/goals${query}`);
}
