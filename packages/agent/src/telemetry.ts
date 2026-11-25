/**
 * Telemetry hooks (docs/harness.md section 9). The Worker writes these to
 * Analytics Engine; tests collect them in memory.
 */
import type { ProposalKind, ProposalStatus, Surface, TurnEndReason } from './types';

export interface TurnMetrics {
  threadId: string;
  turnId: string;
  workspaceId?: string;
  surface: Surface;
  skill: string | null;
  llm: string;
  tokensIn: number;
  tokensOut: number;
  /** Estimated context tokens (our estimator), to calibrate it against `tokensIn`. */
  contextTokens: number;
  costUsd: number | null;
  toolCalls: number;
  llmCalls: number;
  retries: number;
  latencyMs: number;
  reason: TurnEndReason;
  proposalKind: ProposalKind | null;
}

export interface ProposalMetrics {
  threadId: string;
  proposalId: string;
  workspaceId?: string;
  kind: ProposalKind;
  status: Exclude<ProposalStatus, 'proposed'>;
  /** ms from creation to decision. */
  timeToDecisionMs: number;
  estimate: number;
}

export interface AgentTelemetry {
  turn(m: TurnMetrics): void;
  proposal(m: ProposalMetrics): void;
}

export const noopTelemetry: AgentTelemetry = { turn: () => {}, proposal: () => {} };

export class MemoryTelemetry implements AgentTelemetry {
  readonly turns: TurnMetrics[] = [];
  readonly proposals: ProposalMetrics[] = [];
  turn(m: TurnMetrics): void {
    this.turns.push(m);
  }
  proposal(m: ProposalMetrics): void {
    this.proposals.push(m);
  }
}

/** Structural subset of the Analytics Engine binding. */
export interface AnalyticsEngineLike {
  writeDataPoint(event: { indexes?: string[]; blobs?: (string | null)[]; doubles?: number[] }): void;
}

/**
 * Analytics Engine writer. Blob and double positions are the query contract:
 * turn: blobs [event, surface, skill, llm, reason, proposalKind, workspace], doubles [tokensIn, tokensOut, contextTokens, costUsd, toolCalls, llmCalls, retries, latencyMs]
 * proposal: blobs [event, kind, status, workspace], doubles [timeToDecisionMs, estimate]
 */
export function analyticsTelemetry(ae: AnalyticsEngineLike | undefined): AgentTelemetry {
  if (!ae) return noopTelemetry;
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // Telemetry never breaks a turn.
    }
  };
  return {
    turn: (m) =>
      safe(() =>
        ae.writeDataPoint({
          indexes: [m.threadId],
          blobs: ['agent.turn', m.surface, m.skill, m.llm, m.reason, m.proposalKind, m.workspaceId ?? null],
          doubles: [m.tokensIn, m.tokensOut, m.contextTokens, m.costUsd ?? 0, m.toolCalls, m.llmCalls, m.retries, m.latencyMs],
        }),
      ),
    proposal: (m) =>
      safe(() =>
        ae.writeDataPoint({
          indexes: [m.threadId],
          blobs: ['agent.proposal', m.kind, m.status, m.workspaceId ?? null],
          doubles: [m.timeToDecisionMs, m.estimate],
        }),
      ),
  };
}
