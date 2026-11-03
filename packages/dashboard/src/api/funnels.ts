import { type ApiResponse, apiFetch } from './client';
import { buildQuery } from './query';
import type { FunnelDefinition, FunnelDefinitionInput } from './types';

export interface FunnelsParams {
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

/** `api.md` §2.8.2: admin subroutes carry the site in the path. */
export function getFunnels(
  siteId: string,
  params: FunnelsParams = {},
): Promise<ApiResponse<FunnelDefinition[]>> {
  const query = buildQuery({
    limit: params.limit,
    offset: params.offset,
    order: params.order,
  });
  return apiFetch<FunnelDefinition[]>(`/admin/sites/${encodeURIComponent(siteId)}/funnels${query}`);
}

export async function createFunnel(
  siteId: string,
  body: FunnelDefinitionInput,
): Promise<FunnelDefinition> {
  const response = await apiFetch<FunnelDefinition>(
    `/admin/sites/${encodeURIComponent(siteId)}/funnels`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
  return response.data;
}

export async function updateFunnel(
  siteId: string,
  funnelId: string,
  body: Partial<FunnelDefinitionInput>,
): Promise<FunnelDefinition> {
  const response = await apiFetch<FunnelDefinition>(
    `/admin/sites/${encodeURIComponent(siteId)}/funnels/${encodeURIComponent(funnelId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
    },
  );
  return response.data;
}

export async function deleteFunnel(siteId: string, funnelId: string): Promise<void> {
  await apiFetch<void>(
    `/admin/sites/${encodeURIComponent(siteId)}/funnels/${encodeURIComponent(funnelId)}`,
    { method: 'DELETE' },
  );
}
