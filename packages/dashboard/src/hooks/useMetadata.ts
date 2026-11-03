import { useQuery } from '@tanstack/react-query';
import { getMetadata } from '../api/analytics';

export function useMetadata() {
  return useQuery({
    queryKey: ['metadata'],
    queryFn: getMetadata,
    staleTime: 5 * 60_000,
  });
}
