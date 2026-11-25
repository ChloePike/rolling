import { useQuery } from '@tanstack/react-query';
import { isMockApi } from '@/lib/api/mode';
import { publicSafe } from '@/lib/media';
import { getSession, useSession } from '@/lib/session';
import { accountHandle, accountName } from '@/shell/account';
import { profileMock, type PublicProfile } from './mocks';

/**
 * Public profile (`/u/:handle`). The API has no profiles route yet: in real
 * mode the signed-in user's own handle shows their profile from the session
 * (no published works until publishing exists) and other handles are
 * `unavailable`. Profiles are public (D-005): suggestive and explicit works are
 * dropped here as well as on the server.
 */
export async function fetchProfile(handle: string): Promise<PublicProfile | null> {
  if (!isMockApi()) {
    const s = getSession();
    if (s.status !== 'signedIn' || accountHandle(s) !== handle) return null;
    return { name: accountName(s), handle, bio: null, works: [] };
  }
  const p = structuredClone(profileMock);
  return { ...p, handle: handle || p.handle, works: publicSafe(p.works) };
}

export function useProfile(handle: string) {
  const { status, user } = useSession();
  return useQuery({ queryKey: ['profile', handle, status, user?.id ?? null], queryFn: () => fetchProfile(handle), staleTime: isMockApi() ? Infinity : 60_000 });
}
