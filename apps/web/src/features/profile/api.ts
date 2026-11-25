import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { isMockApi } from '@/lib/api/mode';
import type { ProfileResponse } from '@/lib/api/types';
import { publicSafe } from '@/lib/media';
import { getSession, useSession } from '@/lib/session';
import { accountHandle, accountName } from '@/shell/account';
import { profileMock, type PublicProfile } from './mocks';

/** Maps `GET /api/profiles/:handle` to the page model (published works first, then templates). */
export function profileFromApi(r: ProfileResponse): PublicProfile {
  return {
    name: r.name,
    handle: r.handle,
    bio: r.bio,
    avatarUrl: r.avatarUrl,
    isYou: r.isYou,
    works: [
      ...r.works.map((w) => ({ id: w.shareId, shareId: w.shareId, title: w.title, durationSec: w.durationSec ?? 0, kind: 'published' as const, mature: false, rating: 'safe' as const, coverUrl: w.coverUrl })),
      ...r.templates.map((t) => ({ id: t.id, title: t.title, durationSec: 0, kind: 'template' as const, mature: false, rating: 'safe' as const, coverUrl: t.coverUrl })),
    ],
  };
}

/**
 * Public profile (`/u/:handle`): `GET /api/profiles/:handle` (no session
 * needed). Profiles are public (D-005): the server lists only safe covers and
 * the page drops suggestive and explicit works as well. A signed-in user
 * without a handle yet sees their own stand-in profile (`unclaimed`) with a
 * prompt to pick one; any other unknown handle is `null` (unavailable).
 */
export async function fetchProfile(handle: string): Promise<PublicProfile | null> {
  if (!isMockApi()) {
    const s = getSession();
    // Own stand-in handle (no handle chosen yet): never resolve it to someone else's profile.
    if (s.status === 'signedIn' && !s.user?.handle && accountHandle(s) === handle) {
      return { name: accountName(s), handle, bio: null, works: [], avatarUrl: s.user?.image ?? null, isYou: true, unclaimed: true };
    }
    try {
      return profileFromApi(await api.get<ProfileResponse>(`/profiles/${encodeURIComponent(handle)}`, { noWorkspace: true }));
    } catch (e) {
      if (isApiError(e, 'NOT_FOUND')) return null;
      throw e;
    }
  }
  const p = structuredClone(profileMock);
  return { ...p, handle: handle || p.handle, works: publicSafe(p.works) };
}

export function useProfile(handle: string) {
  const { status, user } = useSession();
  return useQuery({
    queryKey: ['profile', handle, status, user?.id ?? null, user?.handle ?? null, user?.image ?? null],
    queryFn: () => fetchProfile(handle),
    staleTime: isMockApi() ? Infinity : 60_000,
    retry: false,
  });
}
