/**
 * The one integration file between the generation pipeline (M4) and the
 * Durable Objects owned by other areas: CreditAccount (M2: quote / hold /
 * settle / release / balance), ProjectRoom (M3: planRun, getGraph, addVersion,
 * inputDigest, markRunning, markFailed, broadcast) and UserHub (live pushes).
 *
 * The pipeline codes against these ports; tests and scripts can swap them.
 */
import type { Balance, HoldInput, HoldResult, LedgerOutcome, QuoteItemInput, QuoteResult, ReleaseResult, SettleResult } from "@rolling/core/credits";
import type { PlanItem as StructuralItem, RunScope } from "@rolling/core/project";
import type { GraphState, NodeStatus, ServerMessageType } from "@rolling/core/graph";
import { creditAccount, quoteCredits } from "../billing/credits";
import { projectRoom, type RoomCaller } from "../lib/access";
import type { RoomError, VersionInfo } from "../do/ProjectRoom";

export interface CreditsPort {
  /** Prices items over the synced catalog; throws ApiError on ledger errors. */
  quote(items: QuoteItemInput[]): Promise<QuoteResult>;
  hold(input: HoldInput): Promise<LedgerOutcome<HoldResult>>;
  settle(jobId: string, credits: number, idemKey: string): Promise<LedgerOutcome<SettleResult>>;
  release(jobId: string, reason: string, idemKey: string): Promise<LedgerOutcome<ReleaseResult>>;
  balance(): Promise<Balance>;
}

export interface RoomPort {
  planRun(caller: RoomCaller, input: { scope: RunScope; nodeIds?: string[] }): Promise<{ ok: true; revision: number; items: StructuralItem[] } | RoomError>;
  getGraph(caller: RoomCaller): Promise<{ state: GraphState; assets: Record<string, string> } | RoomError>;
  inputDigest(caller: RoomCaller, nodeId: string): Promise<{ ok: true; digest: string } | RoomError>;
  addVersion(input: { nodeId: string; assetId: string | null; inputDigest: string; model?: string | null; jobId?: string | null; output?: unknown }): Promise<
    { ok: true; version: VersionInfo; statuses: Record<string, NodeStatus> } | RoomError
  >;
  /** Node queued / generating with progress 0..1; broadcasts `job.progress`. */
  markRunning(input: { nodeId: string; jobId: string; progress?: number; status?: "queued" | "generating" }): Promise<{ ok: boolean }>;
  /** Node failed with the refund; broadcasts `job.failed`. */
  markFailed(input: { nodeId: string; jobId: string; refunded: number; reason: string }): Promise<{ ok: boolean }>;
  broadcast(type: ServerMessageType, payload: unknown): Promise<{ sent: number }>;
}

export interface HubPort {
  broadcast(type: ServerMessageType, payload: unknown): Promise<number>;
}

export interface Ports {
  credits(workspaceId: string): CreditsPort;
  room(projectId: string): RoomPort;
  hub(userId: string): HubPort;
}

export function durableObjectPorts(env: Env): Ports {
  return {
    credits(workspaceId) {
      const stub = creditAccount(env, workspaceId);
      return {
        quote: (items) => quoteCredits(env, workspaceId, items),
        hold: (input) => stub.hold(input) as Promise<LedgerOutcome<HoldResult>>,
        settle: (jobId, credits, key) => stub.settle(jobId, credits, key) as Promise<LedgerOutcome<SettleResult>>,
        release: (jobId, reason, key) => stub.release(jobId, reason, key) as Promise<LedgerOutcome<ReleaseResult>>,
        balance: () => stub.balance() as Promise<Balance>,
      };
    },
    room(projectId) {
      return projectRoom(env, projectId) as unknown as RoomPort;
    },
    hub(userId) {
      const stub = env.USER_HUB.get(env.USER_HUB.idFromName(userId));
      return { broadcast: (type, payload) => stub.broadcast(type, payload) as Promise<number> };
    },
  };
}

let override: ((env: Env) => Ports) | null = null;

/** Tests: replace the ports (null restores the Durable Objects). */
export function setPortsForTests(fn: ((env: Env) => Ports) | null): void {
  override = fn;
}

export function ports(env: Env): Ports {
  return override ? override(env) : durableObjectPorts(env);
}

/** Live pushes never fail the pipeline: log and continue. */
export async function quietly(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(JSON.stringify({ msg: "runs: push failed", what, error: String(err) }));
  }
}
