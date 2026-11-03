import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFunnel, deleteFunnel, getFunnels, updateFunnel } from '../api/funnels';
import type { FunnelDefinitionInput } from '../api/types';

interface UseFunnelsOptions {
  siteId?: string;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

export function useFunnels({ siteId, limit = 100, offset = 0, order = 'desc' }: UseFunnelsOptions) {
  return useQuery({
    queryKey: ['funnels', siteId, limit, offset, order],
    queryFn: () => {
      if (!siteId) throw new Error('siteId is required');
      return getFunnels(siteId, { limit, offset, order });
    },
    enabled: Boolean(siteId),
    // dashboard.md §6: funnels are fresh for five minutes.
    staleTime: 5 * 60_000,
  });
}

interface UpdateFunnelVariables {
  funnelId: string;
  body: Partial<FunnelDefinitionInput>;
}

export function useFunnelMutations(siteId: string | undefined) {
  const queryClient = useQueryClient();

  const invalidate = async () => {
    if (!siteId) return;
    await queryClient.invalidateQueries({ queryKey: ['funnels', siteId] });
  };

  const create = useMutation({
    mutationFn: (body: FunnelDefinitionInput) => {
      if (!siteId) throw new Error('siteId is required');
      return createFunnel(siteId, body);
    },
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: ({ funnelId, body }: UpdateFunnelVariables) => {
      if (!siteId) throw new Error('siteId is required');
      return updateFunnel(siteId, funnelId, body);
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (funnelId: string) => {
      if (!siteId) throw new Error('siteId is required');
      return deleteFunnel(siteId, funnelId);
    },
    onSuccess: invalidate,
  });

  return { create, update, remove };
}
