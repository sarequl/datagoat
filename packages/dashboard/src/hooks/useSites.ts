import { useQuery } from '@tanstack/react-query';
import { getSites } from '../api/sites';

export function useSites() {
  return useQuery({
    queryKey: ['sites'],
    queryFn: () => getSites({ limit: 100 }),
    staleTime: 5 * 60_000,
  });
}
