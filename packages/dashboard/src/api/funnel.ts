import { apiFetch } from './client';
import { buildQuery } from './query';
import type { FunnelResult } from './types';

export interface FunnelParams {
  siteId?: string;
  startAt?: string;
  endAt?: string;
  timezone?: string;
}

/** `api.md` §2.7.3: results are computed server-side from the saved funnel. */
export async function getFunnel(
  funnelId: string,
  params: FunnelParams = {},
): Promise<FunnelResult> {
  const query = buildQuery({
    siteId: params.siteId,
    startAt: params.startAt,
    endAt: params.endAt,
    timezone: params.timezone,
  });
  const response = await apiFetch<FunnelResult>(
    `/analytics/funnel/${encodeURIComponent(funnelId)}${query}`,
  );
  return response.data;
}
