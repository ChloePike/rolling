import { useQuery } from '@tanstack/react-query';
import { profileMock, type PublicProfile } from './mocks';

/**
 * Public profile (`/u/:handle`). Mock until the profiles API lands. Mature
 * works are dropped here as well as on the server: profiles are public (D-005).
 */
export async function fetchProfile(handle: string): Promise<PublicProfile> {
  const p = structuredClone(profileMock);
  return { ...p, handle: handle || p.handle, works: p.works.filter((w) => !w.mature) };
}

export function useProfile(handle: string) {
  return useQuery({ queryKey: ['profile', handle], queryFn: () => fetchProfile(handle), staleTime: Infinity });
}
