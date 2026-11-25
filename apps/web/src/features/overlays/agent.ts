/**
 * Agent client (docs/api.md → Agent (M6)) shared by Home's Agent mode, the
 * canvas agent panel, the editor's “Ask for an edit” and the tools' Simple
 * mode. Real mode only; every surface keeps its own mock path.
 *
 * - `POST /api/agent/threads { projectId?, surface, skill?, tool? }` → thread
 * - `POST /api/agent/threads/:id/messages { text, refs?, selection?, llm? }`
 *   runs one turn and answers when it ends; while it runs, `agent.delta`,
 *   `agent.tool`, `proposal.created` stream over the thread socket
 *   (`/api/agent/threads/:id/ws`).
 * - `POST /api/agent/proposals/:id/apply|discard`
 *
 * Errors: `402 NO_PLAN` (join paywall, keep the brief), `429
 * AGENT_ALLOWANCE_EXHAUSTED { allowanceUsd, usedUsd, resetsAt, model }`,
 * `429 RATE_LIMITED`, `409 CONFLICT` (a turn is already running).
 */
import { apiFetch, ApiError, userEvents, type Envelope } from './backend';

export type AgentSurface = 'home' | 'canvas' | 'editor' | 'tool';
export type AgentSkill = 'tv-ad' | 'product-showcase' | 'storyboard' | 'ai-comic' | 'brand-kit';
export type AgentTool = 'quick' | 'remix' | 'avatar' | 'character';

export interface AgentEstimate {
  credits: number;
  items: Array<{ ref: string; model: string; kind: 'video' | 'image'; seconds?: number; resolution?: string; credits: number }>;
  applyIsFree: true;
  balanceAfter: number;
  needsConfirm: boolean;
}

export interface PlanShot {
  n: number;
  title: string;
  seconds: number;
  visual: string;
  line?: string;
  model: string;
  mode: 't2v' | 'i2v';
  resolution: string;
  credits: number;
}

export interface PlanOption {
  title: string;
  ratio: string;
  resolution: string;
  seconds: number;
  estimate: AgentEstimate;
  ops: unknown[];
  shots: PlanShot[];
}

export type ProposalBody =
  | { kind: 'plan'; seconds: number; refs: string[]; options: PlanOption[] }
  | { kind: 'graphPatch'; projectId: string; ops: unknown[]; touched: { added: string[]; updated: string[]; removed: string[]; edges: number } }
  | { kind: 'timelinePatch'; canvasId: string; ops: unknown[]; highlights: Array<{ clipId: string; kind: 'remove' | 'change' }>; durationBefore: number; durationAfter: number }
  | { kind: 'fields'; tool: AgentTool; fields: Record<string, unknown> };

export interface Proposal {
  id: string;
  kind: ProposalBody['kind'];
  status: 'proposed' | 'applied' | 'discarded' | 'stale';
  baseRevision: number | null;
  summary: string;
  createdAt: number;
  estimate: AgentEstimate;
  risks: Array<{ code: string; data: Record<string, unknown> }>;
  body: ProposalBody;
}

export interface Thread {
  id: string;
  workspaceId: string;
  projectId: string | null;
  canvasId: string | null;
  surface: AgentSurface;
  skill: string | null;
  tool: string | null;
  llm: string | null;
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: number; proposalId?: string }>;
  proposals: Proposal[];
}

export type TurnReason = 'completed' | 'proposal' | 'max_tool_calls' | 'invalid_proposal' | 'canceled' | 'error' | 'safety_blocked' | (string & {});

export interface TurnResult {
  turnId: string;
  messageId: string;
  text: string;
  reason: TurnReason;
  proposal: Proposal | null;
  error: { code: string; message: string } | null;
  llm: string;
}

export interface ApplyResult {
  ok: boolean;
  proposalId: string;
  kind: ProposalBody['kind'];
  projectId?: string;
  canvasId?: string;
  revision?: number;
  idMap?: Record<string, string>;
  fields?: Record<string, unknown>;
}

export async function createThread(input: { surface: AgentSurface; projectId?: string; skill?: AgentSkill | null; tool?: AgentTool }): Promise<Thread> {
  const body: Record<string, unknown> = { surface: input.surface };
  if (input.projectId) body.projectId = input.projectId;
  if (input.skill) body.skill = input.skill;
  if (input.tool) body.tool = input.tool;
  const r = await apiFetch<{ thread: Thread }>('/agent/threads', { method: 'POST', body });
  return r.thread;
}

export async function getThread(id: string): Promise<Thread> {
  return (await apiFetch<{ thread: Thread }>(`/agent/threads/${encodeURIComponent(id)}`)).thread;
}

const threadKey = (key: string) => `rolling.agent.thread.${key}`;

/**
 * The thread for a surface key (e.g. `canvas:prj_…`), created on first use and
 * remembered in this browser; a thread the server no longer knows is replaced.
 */
export async function threadFor(key: string, input: Parameters<typeof createThread>[0]): Promise<Thread> {
  let id: string | null = null;
  try {
    id = localStorage.getItem(threadKey(key));
  } catch {
    id = null;
  }
  if (id) {
    try {
      return await getThread(id);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  }
  const t = await createThread(input);
  try {
    localStorage.setItem(threadKey(key), t.id);
  } catch {
    /* Storage unavailable: a new thread next time. */
  }
  return t;
}

/** Remembers `threadId` for a surface key (e.g. a Home thread that moved to its new project's canvas). */
export function rememberThread(key: string, threadId: string) {
  try {
    localStorage.setItem(threadKey(key), threadId);
  } catch {
    /* Storage unavailable. */
  }
}

/** The remembered thread for a surface key, without creating one (null when none or gone). */
export async function existingThread(key: string): Promise<Thread | null> {
  let id: string | null = null;
  try {
    id = localStorage.getItem(threadKey(key));
  } catch {
    id = null;
  }
  if (!id) return null;
  try {
    return await getThread(id);
  } catch {
    return null;
  }
}

export function forgetThread(key: string) {
  try {
    localStorage.removeItem(threadKey(key));
  } catch {
    /* ignore */
  }
}

export interface TurnStream {
  onDelta?: (delta: string) => void;
  onTool?: (tool: { name: string; status: 'started' | 'ok' | 'error' }) => void;
  onProposal?: (proposal: Proposal) => void;
}

/**
 * Sends one message and resolves when the turn ends. Live text arrives
 * through `stream` from the thread socket; the resolved result has the full
 * text either way.
 */
export async function sendTurn(
  threadId: string,
  input: { text: string; refs?: string[]; selection?: string[]; llm?: string | null },
  stream: TurnStream = {},
  /** Where the thread's events arrive: the user channel (Home, tools; default) or the project channel (canvas, editor). D-014. */
  subscribe: (listener: (msg: Envelope) => void) => () => void = userEvents,
): Promise<TurnResult> {
  const off = subscribe((msg: Envelope) => {
    const p = msg.payload as { threadId?: string; delta?: string; name?: string; status?: 'started' | 'ok' | 'error'; proposal?: Proposal };
    if (!p || p.threadId !== threadId) return;
    if (msg.type === 'agent.delta' && typeof p.delta === 'string') stream.onDelta?.(p.delta);
    else if (msg.type === 'agent.tool' && p.name && p.status) stream.onTool?.({ name: p.name, status: p.status });
    else if (msg.type === 'proposal.created' && p.proposal) stream.onProposal?.(p.proposal);
  });
  try {
    const body: Record<string, unknown> = { text: input.text };
    if (input.refs?.length) body.refs = input.refs;
    if (input.selection?.length) body.selection = input.selection;
    if (input.llm) body.llm = input.llm;
    return await apiFetch<TurnResult>(`/agent/threads/${encodeURIComponent(threadId)}/messages`, { method: 'POST', body });
  } finally {
    off();
  }
}

export async function cancelTurn(threadId: string, turnId?: string): Promise<void> {
  await apiFetch(`/agent/threads/${encodeURIComponent(threadId)}/cancel`, { method: 'POST', body: turnId ? { turnId } : {} });
}

export async function applyProposal(proposalId: string, body: { optionIndex?: number; title?: string } = {}): Promise<ApplyResult> {
  return apiFetch<ApplyResult>(`/agent/proposals/${encodeURIComponent(proposalId)}/apply`, { method: 'POST', body });
}

export async function discardProposal(proposalId: string): Promise<void> {
  await apiFetch(`/agent/proposals/${encodeURIComponent(proposalId)}/discard`, { method: 'POST', body: {} });
}

/** What a failed agent call means for the UI. */
export type AgentFailure =
  | { kind: 'join' }
  | { kind: 'allowance'; resetsAt: number | null; model: string | null }
  | { kind: 'rateLimited'; retryAfter: number | null }
  | { kind: 'busy' }
  | { kind: 'stale' }
  | { kind: 'offline' }
  | { kind: 'error'; message: string };

export function agentFailure(e: unknown): AgentFailure {
  if (!(e instanceof ApiError)) return { kind: 'error', message: String(e) };
  switch (e.code) {
    case 'NO_PLAN':
      return { kind: 'join' };
    case 'AGENT_ALLOWANCE_EXHAUSTED':
      return { kind: 'allowance', resetsAt: typeof e.data.resetsAt === 'number' ? e.data.resetsAt : null, model: typeof e.data.model === 'string' ? e.data.model : null };
    case 'RATE_LIMITED':
      // DeepSeek sends may be rate limited per model: `{ retryAfter (seconds), model }`.
      return { kind: 'rateLimited', retryAfter: typeof (e.data as { retryAfter?: unknown }).retryAfter === 'number' ? (e.data as { retryAfter: number }).retryAfter : null };
    case 'CONFLICT':
      return typeof e.data.status === 'string' ? { kind: 'stale' } : { kind: 'busy' };
    case 'NETWORK':
      return { kind: 'offline' };
    default:
      return { kind: 'error', message: e.message };
  }
}

/** Skill chip label (Home / canvas) → API skill id. */
export function skillId(label: string | null | undefined): AgentSkill | null {
  if (!label) return null;
  const k = label.trim().toLowerCase().replace(/\s+/g, '-');
  const known: AgentSkill[] = ['tv-ad', 'product-showcase', 'storyboard', 'ai-comic', 'brand-kit'];
  return (known.find((s) => s === k) ?? (/tv/.test(k) ? 'tv-ad' : /product/.test(k) ? 'product-showcase' : /story/.test(k) ? 'storyboard' : /comic/.test(k) ? 'ai-comic' : /brand/.test(k) ? 'brand-kit' : null));
}
