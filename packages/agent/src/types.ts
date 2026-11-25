/**
 * Harness types: threads, proposals and the events a turn streams.
 */
import type { LocalOp } from '@rolling/core/graph';
import type { TimelineOp } from '@rolling/core/timeline';
import type { FieldTool } from './tools/schemas';

export type Surface = 'home' | 'canvas' | 'editor' | 'tool';
export const SURFACES: readonly Surface[] = ['home', 'canvas', 'editor', 'tool'];

export const SKILL_IDS = ['tv-ad', 'product-showcase', 'storyboard', 'ai-comic', 'brand-kit'] as const;
export type SkillId = (typeof SKILL_IDS)[number];

export type ProposalKind = 'plan' | 'graphPatch' | 'timelinePatch' | 'fields';
export type ProposalStatus = 'proposed' | 'applied' | 'discarded' | 'stale';

/** One estimate line: what a later run would cost (proposals never spend). */
export interface EstimateItem {
  /** Node temp id / node id / shot label. */
  ref: string;
  model: string;
  kind: 'video' | 'image';
  seconds?: number;
  resolution?: string;
  credits: number;
}

export interface Estimate {
  /** Credits the follow-up runs would cost; 0 for free changes. */
  credits: number;
  items: EstimateItem[];
  /** Applying the proposal itself is free (always true: proposals never run). */
  applyIsFree: true;
  /** Balance after those runs, from the account snapshot (may be negative). */
  balanceAfter: number;
  /** Runs above the confirm threshold need a confirm (D-006). */
  needsConfirm: boolean;
}

export interface PlanShotOut {
  n: number;
  title: string;
  seconds: number;
  visual: string;
  line?: string;
  model: string;
  mode: 't2v' | 'i2v';
  resolution: string | null;
  credits: number;
}

export interface PlanOptionOut {
  title: string;
  ratio: string;
  resolution: string | null;
  seconds: number;
  shots: PlanShotOut[];
  estimate: Estimate;
  /** The GraphOps "Build on canvas" applies (no spend). */
  ops: LocalOp[];
}

export interface PlanBody {
  kind: 'plan';
  /** Target length in seconds the options were checked against. */
  seconds: number;
  options: PlanOptionOut[];
  /** `@` references the plan wires into keyframes. */
  refs: string[];
}

export interface GraphPatchBody {
  kind: 'graphPatch';
  projectId: string;
  ops: LocalOp[];
  /** Ids the patch touches (for diff highlight). */
  touched: { added: string[]; updated: string[]; removed: string[]; edges: number };
}

export interface TimelineHighlight {
  clipId: string;
  kind: 'remove' | 'change';
}

export interface TimelinePatchBody {
  kind: 'timelinePatch';
  canvasId: string;
  ops: TimelineOp[];
  highlights: TimelineHighlight[];
  durationBefore: number;
  durationAfter: number;
}

export interface FieldsBody {
  kind: 'fields';
  tool: FieldTool;
  fields: Record<string, unknown>;
}

export type ProposalBody = PlanBody | GraphPatchBody | TimelinePatchBody | FieldsBody;

export interface Proposal {
  id: string;
  kind: ProposalKind;
  baseRevision: number | null;
  summary: string;
  estimate: Estimate;
  /** Notes the UI shows under the summary, as codes with data (the UI owns the copy). */
  risks: ProposalRisk[];
  body: ProposalBody;
  status: ProposalStatus;
  createdAt: number;
}

export type ProposalRisk =
  | { code: 'over_balance'; data: { credits: number; available: number } }
  | { code: 'needs_confirm'; data: { credits: number; threshold: number } }
  | { code: 'unpriced'; data: { refs: string[] } }
  | { code: 'removes_user_nodes'; data: { nodeIds: string[] } };

/** Message stored in the thread. Tool traces within a turn are not stored. */
export interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** Proposal created in this assistant message. */
  proposalId?: string;
}

/** Events streamed while a turn runs (to the project socket, the user hub and the thread socket). */
export type AgentEvent =
  | { type: 'agent.delta'; threadId: string; turnId: string; delta: string }
  | { type: 'agent.tool'; threadId: string; turnId: string; name: string; status: 'started' | 'ok' | 'error'; error?: string }
  | { type: 'proposal.created'; threadId: string; turnId: string; proposal: Proposal }
  | { type: 'proposal.updated'; threadId: string; proposalId: string; status: ProposalStatus; baseRevision?: number | null; reason?: string }
  | { type: 'agent.done'; threadId: string; turnId: string; messageId: string; reason: TurnEndReason; proposalId: string | null }
  | { type: 'agent.error'; threadId: string; turnId: string; code: string; message: string };

export type TurnEndReason = 'completed' | 'proposal' | 'max_tool_calls' | 'canceled' | 'error' | 'invalid_proposal';
