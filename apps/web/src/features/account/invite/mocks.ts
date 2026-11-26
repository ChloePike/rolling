import type { InviteAccepted, InviteLookup } from '@/lib/api/types';

/** Mock invite (mock mode only, through `mockData().invite`): a pending invite to the mock user, or to someone else. */
export function mockInviteLookup(to: 'self' | 'other', state: InviteLookup['state']): InviteLookup {
  return { workspace: { id: 'ws_ridgeline', name: 'Ridgeline brand team' }, inviterName: 'Jordan Lee', email: to === 'other' ? 'sam@ridgeline.co' : 'alex@ridgeline.co', role: 'editor', expiresAt: Date.now() + 6 * 86_400_000, state };
}

export const mockInviteAccepted: InviteAccepted = { workspace: { id: 'ws_ridgeline', name: 'Ridgeline brand team', kind: 'team' }, role: 'editor' };
