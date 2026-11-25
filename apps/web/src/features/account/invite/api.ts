import { useQuery } from '@tanstack/react-query';
import { api, setWorkspaceId } from '@/lib/api/client';
import { ApiError, isApiError } from '@/lib/api/errors';
import { isMockApi } from '@/lib/api/mode';
import { queryClient } from '@/lib/api/queryClient';
import type { InviteAccepted, InviteLookup } from '@/lib/api/types';

/**
 * Invite links (`/invite/:token`, docs/api.md → Workspaces and team):
 * `GET /api/workspace/invites/lookup?token=` (no session needed) and
 * `POST /api/workspace/invites/accept { token }` (session; the signed-in email
 * must match). After accepting, the client switches to the workspace.
 *
 * Mock tokens: `expired`, `revoked`, `accepted`, `missing` (404), `other` (another email), `full` (no seat on accept); anything
 * else is a pending invite to alex@ridgeline.co.
 */
export async function lookupInvite(token: string): Promise<InviteLookup | null> {
  if (isMockApi()) {
    if (token === 'missing') return null;
    const state = (['expired', 'revoked', 'accepted'] as const).find((s) => s === token) ?? 'pending';
    return { workspace: { id: 'ws_ridgeline', name: 'Ridgeline brand team' }, inviterName: 'Jordan Lee', email: token === 'other' ? 'sam@ridgeline.co' : 'alex@ridgeline.co', role: 'editor', expiresAt: Date.now() + 6 * 86_400_000, state };
  }
  try {
    return await api.get<InviteLookup>('/workspace/invites/lookup', { query: { token }, noWorkspace: true });
  } catch (e) {
    // Unknown, or not even shaped like a token.
    if (isApiError(e, 'NOT_FOUND') || isApiError(e, 'VALIDATION_FAILED') || isApiError(e, 'BAD_REQUEST')) return null;
    throw e;
  }
}

export function useInviteLookup(token: string) {
  return useQuery({ queryKey: ['invite', token], queryFn: () => lookupInvite(token), staleTime: 30_000 });
}

export async function acceptInvite(token: string): Promise<InviteAccepted> {
  if (isMockApi()) {
    await new Promise((r) => setTimeout(r, 300));
    if (token === 'full') throw new ApiError('SEATS_REQUIRED', 'No free seat', 402, { seats: 3, used: 3, needed: 4 } as never);
    return { workspace: { id: 'ws_ridgeline', name: 'Ridgeline brand team', kind: 'team' }, role: 'editor' };
  }
  const r = await api.post<InviteAccepted>('/workspace/invites/accept', { token }, { noWorkspace: true });
  // Act in the joined workspace from now on.
  setWorkspaceId(r.workspace.id);
  await queryClient.resetQueries({ predicate: (q) => q.queryKey[0] !== 'models' });
  return r;
}
