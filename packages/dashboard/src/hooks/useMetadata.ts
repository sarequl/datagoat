import { useQuery } from '@tanstack/react-query';
import { getMetadata } from '../api/analytics';

export function useMetadata(siteId?: string) {
  return useQuery({
    queryKey: ['metadata', siteId],
    queryFn: () => getMetadata(siteId ? { siteId } : {}),
    staleTime: 5 * 60_000,
  });
}
