import { apiFetch } from './client';
import { buildQuery } from './query';
import type { Site } from './types';

export async function getSites(params: { limit?: number; offset?: number } = {}): Promise<Site[]> {
  const query = buildQuery({ limit: params.limit, offset: params.offset });
  const response = await apiFetch<Site[]>(`/admin/sites${query}`);
  return response.data;
}
