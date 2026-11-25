import type { TypedEnvelope } from '@rolling/core/graph';
import type { AllowanceView, ServerPrefs } from '@/lib/api/types';

/**
 * Messages on the user socket (`/api/ws` → UserHub, D-003), each a
 * `{ type, id, payload }` envelope from `@rolling/core/graph`.
 */
export interface UserHubPayloads {
  hello: { userId: string; connectedAt: number };
  pong: null;
  error: { code: string; message: string; data?: unknown };
  /** After every hold, settle and release (and, later, billing). `balance` = plan + purchased (available). */
  'credits.changed': { balance: number; held: number; plan?: number; purchased?: number; workspaceId?: string };
  'prefs.changed': { prefs: ServerPrefs };
  'activity.updated': { runId: string; jobId?: string };
  /** D-012: same body as `GET /api/agent/allowance`, after each settled turn. */
  'agent.allowance': AllowanceView & { workspaceId?: string };
  /** Product notifications (run done, credits low, renewal). Shape is open; `message` is shown as is. */
  notification: { kind?: string; title?: string; message?: string; href?: string; [k: string]: unknown };
  // Home and tool agent threads stream here too (docs/api.md → Agent).
  'agent.delta': { threadId: string; turnId: string; delta: string };
  'agent.tool': { threadId: string; turnId: string; name: string; status: 'started' | 'ok' | 'error'; error?: string };
  'agent.done': { threadId: string; turnId: string; messageId: string; reason: string; proposalId: string | null };
  'agent.error': { threadId: string; turnId: string; code: string; message: string };
  'proposal.created': { threadId: string; turnId: string; proposal: unknown };
  'proposal.updated': { threadId: string; proposalId: string; status: string; reason?: string };
}

export type UserHubType = keyof UserHubPayloads;

export type UserHubMessage = { [K in UserHubType]: TypedEnvelope<K, UserHubPayloads[K]> }[UserHubType];

/** `connecting` → `open`; `retrying` while backing off; `closed` when stopped or refused (4401/4402/4403/4404). */
export type SocketStatus = 'idle' | 'connecting' | 'open' | 'retrying' | 'closed';

/** Close codes the server uses: session gone, forbidden, not found. */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_NO_PLAN = 4402;
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_NOT_FOUND = 4404;
