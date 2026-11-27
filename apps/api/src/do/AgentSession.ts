import { DurableObject } from "cloudflare:workers";
import {
  analyticsTelemetry,
  rebaseGraphPatch,
  rebaseTimelinePatch,
  runTurn,
  summarizeThread,
  summaryDue,
  messagesToSummarize,
  resolveAgentLlm,
  defaultTurnEstimate,
  DEFAULT_AGENT_LLM,
  type AgentEvent,
  type AgentPorts,
  type FieldTool,
  type GraphPatchBody,
  type PlanBody,
  type Proposal,
  type ProposalStatus,
  type SkillId,
  type Surface,
  type ThreadMessage,
  type ThreadState,
  type TimelinePatchBody,
  type TurnEndReason,
  type TurnSettings,
} from "@rolling/agent";
import { hyperouter, isUnmeteredAgentLlm, tokenPrice, type LlmProvider } from "@rolling/core";
import type { AgentHoldResult, AgentPeriodInput, AgentReleaseResult, AgentSettleResult, LedgerOutcome } from "@rolling/core/credits";
import type { ServerMessageType } from "@rolling/core/graph";
import { newId } from "@rolling/core/ids";
import { agentMigrations } from "@rolling/db/do/agent";
import { migrateDurableObject } from "@rolling/db/do/migrate";
import { allowanceView } from "../agent/allowance";
import { creditAccount } from "../billing/credits";
import { projectRoom } from "../lib/access";
import { gatewayConfigured, hyperouterClient } from "../runs/provider";
import { agentPorts, roomCallerOf, type AgentCaller } from "./agentPorts";
import { canvasIdFor } from "./ProjectRoom";

export type { AgentCaller };

// ---------------------------------------------------------------- test hooks

let llmOverride: LlmProvider | null = null;
let portsOverride: ((caller: AgentCaller) => Promise<AgentPorts>) | null = null;

/** Tests: run turns against a scripted LLM instead of the gateway. */
export function setAgentLlmForTests(llm: LlmProvider | null): void {
  llmOverride = llm;
}

/** Tests: replace the ports (catalog, balance) the harness reads. */
export function setAgentPortsForTests(fn: ((caller: AgentCaller) => Promise<AgentPorts>) | null): void {
  portsOverride = fn;
}

// ---------------------------------------------------------------- contract

export interface ThreadInit {
  threadId: string;
  workspaceId: string;
  projectId: string | null;
  surface: Surface;
  skill: SkillId | null;
  tool: FieldTool | null;
  createdBy: string;
}

export interface ThreadView {
  id: string;
  workspaceId: string;
  projectId: string | null;
  canvasId: string | null;
  surface: Surface;
  skill: string | null;
  tool: string | null;
  llm: string | null;
  messages: ThreadMessage[];
  proposals: Proposal[];
}

export interface SendInput {
  caller: AgentCaller;
  text: string;
  refs: string[];
  selection: string[];
  /** Public LLM id (D-009); default DeepSeek V4.1 Flash. */
  llm?: string | null;
  /** The prompt box's pills (context only). */
  settings?: TurnSettings;
  turnId: string;
  /** D-012: the workspace's allowance period; the turn holds its estimate against it before the first LLM call. */
  allowance?: AgentPeriodInput;
}

export interface TurnSummary {
  turnId: string;
  messageId: string;
  text: string;
  reason: TurnEndReason;
  proposal: Proposal | null;
  error: { code: string; message: string } | null;
  llm: string;
}

export type AgentError = { ok: false; code: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "VALIDATION_FAILED" | "AGENT_ALLOWANCE_EXHAUSTED" | "RATE_LIMITED" | "UNAVAILABLE"; message: string; data?: Record<string, unknown> };

/** CreditAccount agent-allowance RPCs (D-012), typed structurally. */
interface AllowanceApi {
  agentHold(input: unknown): Promise<LedgerOutcome<AgentHoldResult>>;
  agentSettle(input: { turnId: string; actualUsd: number; idemKey: string }): Promise<LedgerOutcome<AgentSettleResult>>;
  agentRelease(input: { turnId: string; idemKey: string }): Promise<LedgerOutcome<AgentReleaseResult>>;
}

export interface ApplyResult {
  ok: true;
  proposalId: string;
  kind: Proposal["kind"];
  projectId?: string;
  canvasId?: string;
  revision?: number;
  idMap?: Record<string, string>;
  fields?: Record<string, unknown>;
}

/** Room RPCs the agent needs (ProjectRoom, M3). Typed structurally so this file does not depend on its internals. */
interface RoomApi {
  init(input: { projectId: string; workspaceId: string; title: string; createdBy: string; ops?: unknown[] }): Promise<{ revision: number }>;
  getGraph(caller: unknown): Promise<unknown>;
  applyPatch(caller: unknown, patch: { baseRevision: number; ops: unknown[]; origin?: "user" | "agent" }): Promise<unknown>;
  getTimeline(caller: unknown, canvasId?: string): Promise<unknown>;
  patchTimeline(caller: unknown, patch: { canvasId?: string; baseRevision: number; ops: unknown }): Promise<unknown>;
  broadcast(type: ServerMessageType, payload: unknown): Promise<{ sent: number }>;
}

interface Failure {
  ok: false;
  code: string;
  message: string;
}

const isFailure = (v: unknown): v is Failure => typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;

/** Text deltas are batched before they go over RPC to the sockets. */
const DELTA_FLUSH_MS = 60;
const DELTA_FLUSH_CHARS = 120;
/** Messages loaded for a turn (the context keeps the last 12; the summary covers the rest). */
const LOAD_MESSAGES = 40;

/**
 * One instance per agent thread (`idFromName(threadId)`): messages,
 * proposals and summary in SQLite; runs turns with `@rolling/agent`; streams
 * `agent.delta`, `agent.tool`, `proposal.created`, `proposal.updated`,
 * `agent.done`, `agent.error` to the project socket (ProjectRoom.broadcast)
 * or, on Home and tool pages, to the user's socket (UserHub.broadcast), and
 * to sockets opened on the thread itself. Proposals never mutate anything;
 * `apply` runs the stored patch through ProjectRoom as the user.
 */
export class AgentSession extends DurableObject<Env> {
  private schemaVersion = 0;
  private running: { turnId: string; controller: AbortController } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.schemaVersion = migrateDurableObject(ctx.storage, agentMigrations);
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async ping(): Promise<{ ok: true; schemaVersion: number }> {
    return { ok: true, schemaVersion: this.schemaVersion };
  }

  // ---------------------------------------------------------------- lifecycle

  /** Creates the thread. Idempotent for the same workspace. */
  async init(input: ThreadInit): Promise<ThreadView | AgentError> {
    const existing = this.meta("workspace_id");
    if (existing && existing !== input.workspaceId) return { ok: false, code: "NOT_FOUND", message: "Thread not found" };
    if (!existing) {
      this.ctx.storage.transactionSync(() => {
        this.setMeta("thread_id", input.threadId);
        this.setMeta("workspace_id", input.workspaceId);
        this.setMeta("surface", input.surface);
        this.setMeta("created_by", input.createdBy);
        this.setMeta("turn_count", "0");
        this.setMeta("summary", "");
        if (input.projectId) {
          this.setMeta("project_id", input.projectId);
          this.setMeta("canvas_id", canvasIdFor(input.projectId));
        }
        if (input.skill) this.setMeta("skill", input.skill);
        if (input.tool) this.setMeta("tool", input.tool);
      });
    }
    return this.view();
  }

  async get(workspaceId: string): Promise<ThreadView | AgentError> {
    return this.denied(workspaceId) ?? this.view();
  }

  /**
   * Account deletion (AccountDeletionWorkflow): stops a running turn, closes
   * thread sockets and wipes the thread's storage. No caller check (Worker-only
   * RPC); idempotent.
   */
  async purge(): Promise<{ ok: true }> {
    this.running?.controller.abort();
    this.running = null;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4410, "Thread deleted");
      } catch {
        // Already closing.
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { ok: true };
  }

  // ---------------------------------------------------------------- turns

  async send(input: SendInput): Promise<TurnSummary | AgentError> {
    const denied = this.denied(input.caller.workspaceId);
    if (denied) return denied;
    if (this.running) return { ok: false, code: "CONFLICT", message: "A turn is already running in this thread", data: { turnId: this.running.turnId } };
    const controller = new AbortController();
    this.running = { turnId: input.turnId, controller };
    try {
      return await this.runOne(input, controller);
    } finally {
      this.running = null;
    }
  }

  /** Stops the running turn (partial text stays, no proposal). */
  async cancel(workspaceId: string, turnId?: string): Promise<{ ok: true; canceled: boolean } | AgentError> {
    const denied = this.denied(workspaceId);
    if (denied) return denied;
    if (!this.running || (turnId && this.running.turnId !== turnId)) return { ok: true, canceled: false };
    this.running.controller.abort();
    return { ok: true, canceled: true };
  }

  private async runOne(input: SendInput, controller: AbortController): Promise<TurnSummary | AgentError> {
    // No model gateway key: a clear refusal before any slot or allowance hold.
    if (!llmOverride && !gatewayConfigured(this.env)) {
      return { ok: false, code: "UNAVAILABLE", message: "The agent is not available right now", data: { reason: "gateway_not_configured" } };
    }
    const ports = portsOverride ? await portsOverride(input.caller) : await agentPorts(this.env, input.caller);
    const llmId = input.llm ?? this.meta("llm");
    // D-012: reserve the turn's estimate before the first LLM call. DeepSeek
    // (unmetered, D-012 amendment) takes a slot of the per-user abuse limit instead.
    const allowance = this.allowanceApi(input.caller.workspaceId);
    const est = defaultTurnEstimate(llmId ?? DEFAULT_AGENT_LLM, ports.models.chatModels(), { mature: input.caller.matureAllowed });
    const unmetered = isUnmeteredAgentLlm(est.publicId);
    let heldLlm: string | null = null;
    if (unmetered) {
      const hub = this.env.USER_HUB.get(this.env.USER_HUB.idFromName(input.caller.userId)) as unknown as {
        takeAgentTurnSlot(): Promise<{ ok: true; remaining: number } | { ok: false; retryAfter: number }>;
      };
      const slot = await hub.takeAgentTurnSlot();
      if (!slot.ok) return { ok: false, code: "RATE_LIMITED", message: "Too many agent turns this hour", data: { retryAfter: slot.retryAfter, model: est.publicId } };
    } else if (input.allowance) {
      const out = await allowance.agentHold({
        ...input.allowance,
        turnId: input.turnId,
        userId: input.caller.userId,
        llm: est.publicId,
        estimateUsd: est.fallbackUsd,
        idemKey: `${input.turnId}:agent:hold`,
      });
      if (!out.ok) {
        if (out.error.code === "AGENT_ALLOWANCE_EXHAUSTED") {
          const { allowanceUsd, usedUsd, resetsAt, model } = out.error.data as Record<string, unknown>;
          return { ok: false, code: "AGENT_ALLOWANCE_EXHAUSTED", message: "Agent allowance for this period is used up", data: { allowanceUsd, usedUsd, resetsAt, model } };
        }
        throw new Error(`agent hold failed: ${out.error.code} ${out.error.message}`);
      }
      heldLlm = est.publicId;
    }
    await this.refreshProposals(ports);
    const thread = this.threadState();
    const llm = llmOverride ?? new hyperouter.HyperouterLlmProvider(hyperouterClient(this.env));
    if (input.llm) this.setMeta("llm", input.llm);
    const sink = this.sink(thread);
    const telemetry = analyticsTelemetry((this.env as { AE?: AnalyticsEngineDataset }).AE);
    let result: Awaited<ReturnType<typeof runTurn>>;
    try {
      result = await runTurn({
      llm,
      ports,
      thread,
      input: { text: input.text, refs: input.refs, selection: input.selection, ...(input.settings ? { settings: input.settings } : {}) },
      turnId: input.turnId,
      llmId,
      newId: (kind) => newId(kind === "proposal" ? "proposal" : "message"),
      signal: controller.signal,
      emit: sink.emit,
      telemetry,
      workspaceId: input.caller.workspaceId,
    });
    } catch (err) {
      // No usage to settle: release the hold, then fail as before.
      if (heldLlm) await allowance.agentRelease({ turnId: input.turnId, idemKey: `${input.turnId}:agent:release` }).catch(() => undefined);
      throw err;
    }
    await sink.flush();

    const turnCount = Number(this.meta("turn_count") ?? "0") + 1;
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(
        "INSERT INTO messages (id, role, content, tokens_in, tokens_out, created_at, proposal_id, turn_id) VALUES (?, 'user', ?, NULL, NULL, ?, NULL, ?)",
        result.userMessage.id,
        result.userMessage.content,
        result.userMessage.createdAt,
        input.turnId,
      );
      sql.exec(
        "INSERT INTO messages (id, role, content, tokens_in, tokens_out, created_at, proposal_id, turn_id) VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?)",
        result.assistantMessage.id,
        result.assistantMessage.content,
        result.usage.promptTokens,
        result.usage.completionTokens,
        result.assistantMessage.createdAt,
        result.proposal?.id ?? null,
        input.turnId,
      );
      if (result.proposal) this.saveProposal(result.proposal);
      this.setMeta("turn_count", String(turnCount));
    });
    await this.indexTurn(input.caller, result.proposal, input.text);
    if (result.proposal && (result.proposal.kind === "graphPatch" || result.proposal.kind === "timelinePatch")) await this.registerWithRoom(input.caller);
    const charge = { turnCost: result.usage.chargedUsd, tokensIn: result.usage.promptTokens, tokensOut: result.usage.completionTokens };
    const close =
      input.allowance && (heldLlm || unmetered)
        ? { llm: heldLlm ?? est.publicId, metered: !unmetered, period: input.allowance, chat: ports.models.chatModels() }
        : null;
    if (summaryDue(turnCount, this.messageCount())) {
      // The summary's cost is part of this turn (D-012): settle once it is done.
      this.ctx.waitUntil(
        this.updateSummary(llm, ports, input.caller.matureAllowed, input.turnId).then((summaryUsd) => (close ? this.closeAllowance(input, close, { ...charge, turnCost: charge.turnCost + summaryUsd }) : undefined)),
      );
    } else if (close) {
      await this.closeAllowance(input, close, charge);
    }
    return {
      turnId: input.turnId,
      messageId: result.assistantMessage.id,
      text: result.text,
      reason: result.reason,
      proposal: result.proposal,
      error: result.error,
      llm: result.llm.publicId,
    };
  }

  /** Refreshes the thread summary; returns its LLM cost in USD (charged to the turn, D-012). */
  private async updateSummary(llm: LlmProvider, ports: AgentPorts, mature: boolean, turnId: string): Promise<number> {
    try {
      const all = this.loadMessages(10_000);
      const older = messagesToSummarize(all);
      if (!older.length) return 0;
      const model = resolveAgentLlm(this.meta("llm"), ports.models.chatModels(), { mature }).gatewayId;
      const listing = ports.models.chatModels().find((m) => m.id === model);
      const { summary, costUsd } = await summarizeThread({ llm, model, previous: "", older, idempotencyKey: `${turnId}:summary`, price: listing ? tokenPrice(listing) : null });
      this.setMeta("summary", summary);
      return costUsd;
    } catch (err) {
      console.error(JSON.stringify({ msg: "agent: summary failed", thread: this.meta("thread_id"), error: String(err) }));
      return 0;
    }
  }

  // ---------------------------------------------------------------- allowance (D-012)

  private allowanceApi(workspaceId: string): AllowanceApi {
    return creditAccount(this.env, workspaceId) as unknown as AllowanceApi;
  }

  /**
   * Settles the turn's actual cost (or releases the hold when nothing was
   * charged), mirrors it to D1 `agent_usage`, and pushes `agent.allowance` to
   * the user's socket. Unmetered turns (DeepSeek, D-012 amendment) only record
   * their cost (`status = 'unmetered'`). Never throws: the turn already happened.
   */
  private async closeAllowance(
    input: SendInput,
    close: { llm: string; metered: boolean; period: AgentPeriodInput; chat: ReturnType<AgentPorts["models"]["chatModels"]> },
    charge: { turnCost: number; tokensIn: number; tokensOut: number },
  ): Promise<void> {
    const { caller, turnId } = input;
    const api = this.allowanceApi(caller.workspaceId);
    try {
      let cost = 0;
      let overrun = 0;
      let status = "released";
      if (!close.metered) {
        cost = charge.turnCost;
        status = "unmetered";
      } else if (charge.turnCost > 0) {
        const out = await api.agentSettle({ turnId, actualUsd: charge.turnCost, idemKey: `${turnId}:agent:settle` });
        if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
        cost = out.value.actualUsd;
        overrun = out.value.overrunUsd;
        status = "settled";
      } else {
        const out = await api.agentRelease({ turnId, idemKey: `${turnId}:agent:release` });
        if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
      }
      await this.env.DB.prepare(
        `INSERT OR REPLACE INTO agent_usage (turn_id, workspace_id, user_id, thread_id, llm, period_start, cost_usd, overrun_usd, tokens_in, tokens_out, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(turnId, caller.workspaceId, caller.userId, this.meta("thread_id"), close.llm, close.period.periodStart, cost, overrun, charge.tokensIn, charge.tokensOut, status, Date.now())
        .run();
      const view = await allowanceView(this.env, { workspaceId: caller.workspaceId, plan: caller.plan, mature: caller.matureAllowed, chatModels: close.chat, period: close.period });
      const hub = this.env.USER_HUB.get(this.env.USER_HUB.idFromName(caller.userId)) as unknown as { broadcast(t: ServerMessageType, p: unknown): Promise<number> };
      await hub.broadcast("agent.allowance", view);
    } catch (err) {
      console.error(JSON.stringify({ msg: "agent: allowance close failed", turnId, error: String(err) }));
    }
  }

  /** D1: proposal index (apply/discard routes find the thread) and thread recency. */
  private async indexTurn(caller: AgentCaller, proposal: Proposal | null, text: string): Promise<void> {
    const threadId = this.meta("thread_id")!;
    const now = Date.now();
    const stmts = [
      this.env.DB.prepare("UPDATE agent_threads SET updated_at = ?, title = COALESCE(title, ?) WHERE id = ?").bind(now, text.slice(0, 80), threadId),
    ];
    if (proposal) {
      stmts.push(
        this.env.DB.prepare("INSERT OR IGNORE INTO agent_proposals (id, thread_id, workspace_id, project_id, kind, status, created_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?)").bind(
          proposal.id,
          threadId,
          caller.workspaceId,
          this.meta("project_id"),
          proposal.kind,
          proposal.createdAt,
        ),
      );
    }
    try {
      await this.env.DB.batch(stmts);
    } catch (err) {
      console.error(JSON.stringify({ msg: "agent: D1 index failed", thread: threadId, error: String(err) }));
    }
  }

  // ---------------------------------------------------------------- proposals

  /**
   * Applies a proposal as the user. Exactly the stored ops go to ProjectRoom
   * (what the user saw); when the canvas moved on, the same ops are re-checked
   * against the new revision (rebase) or the proposal becomes stale.
   * Plans: "Build on canvas" creates a project (Home) or adds to this one.
   */
  async apply(proposalId: string, caller: AgentCaller, opts: { optionIndex?: number; title?: string } = {}): Promise<ApplyResult | AgentError> {
    const denied = this.denied(caller.workspaceId);
    if (denied) return denied;
    if (caller.role === "viewer") return { ok: false, code: "FORBIDDEN", message: "Your role does not allow this" };
    const p = this.loadProposal(proposalId);
    if (!p) return { ok: false, code: "NOT_FOUND", message: "Proposal not found" };
    if (p.status !== "proposed") return { ok: false, code: "CONFLICT", message: `This proposal is ${p.status}`, data: { status: p.status } };
    const rc = roomCallerOf(caller);
    let out: ApplyResult;
    switch (p.body.kind) {
      case "fields":
        out = { ok: true, proposalId, kind: p.kind, fields: p.body.fields };
        break;
      case "plan": {
        const body = p.body as PlanBody;
        const index = opts.optionIndex ?? 0;
        const option = body.options[index];
        if (!option) return { ok: false, code: "VALIDATION_FAILED", message: "No such option", data: { optionIndex: index, options: body.options.length } };
        let projectId = this.meta("project_id");
        if (!projectId) {
          projectId = newId("project");
          const title = (opts.title ?? option.title).slice(0, 120) || "Untitled project";
          await this.env.DB.prepare("INSERT INTO projects (id, workspace_id, title, kind, node_count, created_by, updated_at) VALUES (?, ?, ?, 'canvas', 0, ?, ?)")
            .bind(projectId, caller.workspaceId, title, caller.userId, Date.now())
            .run();
          await this.room(projectId).init({ projectId, workspaceId: caller.workspaceId, title, createdBy: caller.userId });
          this.attachProject(projectId);
        }
        const graph = await this.room(projectId).getGraph(rc);
        if (isFailure(graph)) return { ok: false, code: "NOT_FOUND", message: graph.message };
        const revision = (graph as { state: { revision: number } }).state.revision;
        const res = await this.room(projectId).applyPatch(rc, { baseRevision: revision, ops: option.ops, origin: "agent" });
        if (isFailure(res)) return this.applyFailure(p, res);
        const ok = res as { revision: number; idMap: Record<string, string> };
        out = { ok: true, proposalId, kind: p.kind, projectId, canvasId: canvasIdFor(projectId), revision: ok.revision, idMap: ok.idMap };
        break;
      }
      case "graphPatch": {
        const body = p.body as GraphPatchBody;
        const room = this.room(body.projectId);
        let base = p.baseRevision ?? 0;
        let res = await room.applyPatch(rc, { baseRevision: base, ops: body.ops, origin: "agent" });
        if (isFailure(res) && res.code === "CONFLICT") {
          const graph = await room.getGraph(rc);
          if (isFailure(graph)) return { ok: false, code: "NOT_FOUND", message: graph.message };
          const rebased = rebaseGraphPatch(body, (graph as { state: never }).state);
          if (!rebased.ok) return this.markStale(p, rebased.reason);
          base = rebased.revision;
          this.ctx.storage.sql.exec("UPDATE proposals SET base_revision = ? WHERE id = ?", base, p.id);
          res = await room.applyPatch(rc, { baseRevision: base, ops: body.ops, origin: "agent" });
        }
        if (isFailure(res)) return this.applyFailure(p, res);
        const ok = res as { revision: number; idMap: Record<string, string> };
        out = { ok: true, proposalId, kind: p.kind, projectId: body.projectId, revision: ok.revision, idMap: ok.idMap };
        break;
      }
      case "timelinePatch": {
        const body = p.body as TimelinePatchBody;
        const projectId = this.meta("project_id");
        if (!projectId) return { ok: false, code: "NOT_FOUND", message: "Thread has no project" };
        const room = this.room(projectId);
        let base = p.baseRevision ?? 0;
        let res = await room.patchTimeline(rc, { canvasId: body.canvasId, baseRevision: base, ops: body.ops });
        if (isFailure(res) && res.code === "CONFLICT") {
          const t = await room.getTimeline(rc, body.canvasId);
          if (isFailure(t)) return { ok: false, code: "NOT_FOUND", message: t.message };
          const rebased = rebaseTimelinePatch(body, (t as { timeline: { revision: number; edl: never } }).timeline);
          if (!rebased.ok) return this.markStale(p, rebased.reason);
          base = rebased.revision;
          this.ctx.storage.sql.exec("UPDATE proposals SET base_revision = ? WHERE id = ?", base, p.id);
          res = await room.patchTimeline(rc, { canvasId: body.canvasId, baseRevision: base, ops: body.ops });
        }
        if (isFailure(res)) return this.applyFailure(p, res);
        out = { ok: true, proposalId, kind: p.kind, projectId, canvasId: body.canvasId, revision: (res as { timeline: { revision: number } }).timeline.revision };
        break;
      }
    }
    await this.decide(p, "applied", caller.workspaceId);
    return out;
  }

  async discard(proposalId: string, caller: AgentCaller): Promise<{ ok: true } | AgentError> {
    const denied = this.denied(caller.workspaceId);
    if (denied) return denied;
    const p = this.loadProposal(proposalId);
    if (!p) return { ok: false, code: "NOT_FOUND", message: "Proposal not found" };
    if (p.status === "applied") return { ok: false, code: "CONFLICT", message: "This proposal was applied", data: { status: p.status } };
    if (p.status !== "discarded") await this.decide(p, "discarded", caller.workspaceId);
    return { ok: true };
  }

  /**
   * Integration point for ProjectRoom (M3): call after a graph or timeline
   * commit so pending proposals are rebased or marked stale right away.
   * Turns and `apply` also re-check lazily, so this is an optimization.
   */
  /**
   * Called by ProjectRoom after commits (coalesced) for threads it has
   * registered: rebases pending patch proposals now instead of at the next
   * turn or apply. `pending` = patch proposals still open (0 → the room drops
   * the registration).
   */
  async onRevision(caller: AgentCaller): Promise<{ ok: true; pending: number }> {
    if (this.denied(caller.workspaceId)) return { ok: true, pending: 0 };
    if (!this.pendingPatches().length) return { ok: true, pending: 0 };
    const ports = portsOverride ? await portsOverride(caller) : await agentPorts(this.env, caller);
    await this.refreshProposals(ports);
    return { ok: true, pending: this.pendingPatches().length };
  }

  private pendingPatches(): Proposal[] {
    return this.loadProposals().filter((p) => p.status === "proposed" && (p.kind === "graphPatch" || p.kind === "timelinePatch"));
  }

  /** Registers this thread with its project's room while it has pending patch proposals (eager rebase). */
  private async registerWithRoom(caller: AgentCaller): Promise<void> {
    const projectId = this.meta("project_id");
    if (!projectId) return;
    try {
      await projectRoom(this.env, projectId).registerThread(this.meta("thread_id")!, caller);
    } catch (err) {
      console.warn(JSON.stringify({ msg: "agent: room registration failed", thread: this.meta("thread_id"), error: String(err) }));
    }
  }

  private async applyFailure(p: Proposal, res: Failure): Promise<AgentError> {
    if (res.code === "REFUSED" || res.code === "TIMELINE_INVALID") return this.markStale(p, res.message);
    if (res.code === "FORBIDDEN") return { ok: false, code: "FORBIDDEN", message: res.message };
    if (res.code === "NOT_FOUND") return { ok: false, code: "NOT_FOUND", message: res.message };
    return { ok: false, code: "CONFLICT", message: res.message };
  }

  private async markStale(p: Proposal, reason: string): Promise<AgentError> {
    this.ctx.storage.sql.exec("UPDATE proposals SET status = 'stale', stale_reason = ?, decided_at = ? WHERE id = ?", reason, Date.now(), p.id);
    await this.indexStatus(p.id, "stale");
    await this.broadcastEvent({ type: "proposal.updated", threadId: this.meta("thread_id")!, proposalId: p.id, status: "stale", reason });
    analyticsTelemetry((this.env as { AE?: AnalyticsEngineDataset }).AE).proposal({
      threadId: this.meta("thread_id")!,
      proposalId: p.id,
      kind: p.kind,
      status: "stale",
      timeToDecisionMs: Date.now() - p.createdAt,
      estimate: p.estimate.credits,
    });
    return { ok: false, code: "CONFLICT", message: "The canvas changed and this proposal no longer applies", data: { status: "stale", reason } };
  }

  private async decide(p: Proposal, status: Exclude<ProposalStatus, "proposed" | "stale">, workspaceId: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec("UPDATE proposals SET status = ?, decided_at = ? WHERE id = ?", status, now, p.id);
    await this.indexStatus(p.id, status);
    await this.broadcastEvent({ type: "proposal.updated", threadId: this.meta("thread_id")!, proposalId: p.id, status });
    analyticsTelemetry((this.env as { AE?: AnalyticsEngineDataset }).AE).proposal({
      threadId: this.meta("thread_id")!,
      proposalId: p.id,
      workspaceId,
      kind: p.kind,
      status,
      timeToDecisionMs: now - p.createdAt,
      estimate: p.estimate.credits,
    });
  }

  private async indexStatus(id: string, status: ProposalStatus): Promise<void> {
    try {
      await this.env.DB.prepare("UPDATE agent_proposals SET status = ? WHERE id = ?").bind(status, id).run();
    } catch (err) {
      console.error(JSON.stringify({ msg: "agent: proposal index update failed", id, error: String(err) }));
    }
  }

  /** Rebases pending patch proposals onto the current revision, or marks them stale (told to the agent next turn). */
  private async refreshProposals(ports: AgentPorts): Promise<void> {
    const pending = this.pendingPatches();
    for (const p of pending) {
      if (p.body.kind === "graphPatch") {
        const g = await ports.canvas.getGraph(p.body.projectId);
        if (!g || g.state.revision === p.baseRevision) continue;
        const r = rebaseGraphPatch(p.body, g.state);
        if (r.ok) this.ctx.storage.sql.exec("UPDATE proposals SET base_revision = ? WHERE id = ?", r.revision, p.id);
        else await this.markStale(p, r.reason);
      } else if (p.body.kind === "timelinePatch") {
        const t = await ports.timeline.get(p.body.canvasId);
        if (!t || t.revision === p.baseRevision) continue;
        const r = rebaseTimelinePatch(p.body, t);
        if (r.ok) this.ctx.storage.sql.exec("UPDATE proposals SET base_revision = ? WHERE id = ?", r.revision, p.id);
        else await this.markStale(p, r.reason);
      }
    }
  }

  // ---------------------------------------------------------------- streaming

  /** Thread socket (`GET /api/agent/threads/:id/ws`): events of this thread; accepts `cancel`. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket upgrade", { status: 426 });
    const workspaceId = request.headers.get("x-workspace-id");
    if (!workspaceId || this.meta("workspace_id") !== workspaceId) return new Response("Thread not found", { status: 404 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ workspaceId });
    server.send(JSON.stringify({ type: "hello", id: crypto.randomUUID(), payload: { threadId: this.meta("thread_id"), running: this.running?.turnId ?? null } }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: { type?: unknown; id?: unknown; payload?: unknown };
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : "") as typeof msg;
    } catch {
      ws.send(JSON.stringify({ type: "error", id: "unknown", payload: { code: "BAD_MESSAGE", message: "Message must be JSON" } }));
      return;
    }
    const id = typeof msg.id === "string" ? msg.id : crypto.randomUUID();
    if (msg.type === "cancel") {
      if (this.running) this.running.controller.abort();
      ws.send(JSON.stringify({ type: "ack", id, payload: { canceled: !!this.running } }));
      return;
    }
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", id, payload: null }));
      return;
    }
    ws.send(JSON.stringify({ type: "error", id, payload: { code: "UNKNOWN_TYPE", message: "Send messages with POST /api/agent/threads/:id/messages" } }));
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  /** Where this thread's events go: the project socket on canvas/editor, the user hub on home/tool, plus thread sockets. */
  private async broadcastEvent(event: AgentEvent): Promise<void> {
    const { type, ...payload } = event;
    const json = JSON.stringify({ type, id: crypto.randomUUID(), payload });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(json);
      } catch {
        // Closing.
      }
    }
    const projectId = this.meta("project_id");
    try {
      if (projectId) {
        await this.room(projectId).broadcast(type as ServerMessageType, payload);
      } else {
        const userId = this.meta("created_by");
        if (userId) {
          const hub = this.env.USER_HUB.get(this.env.USER_HUB.idFromName(userId)) as unknown as { broadcast(t: ServerMessageType, p: unknown): Promise<number> };
          await hub.broadcast(type as ServerMessageType, payload);
        }
      }
    } catch (err) {
      console.error(JSON.stringify({ msg: "agent: broadcast failed", type, error: String(err) }));
    }
  }

  private sink(thread: ThreadState) {
    let buffer = "";
    let turnId = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let chain: Promise<void> = Promise.resolve();
    const send = (event: AgentEvent) => {
      chain = chain.then(() => this.broadcastEvent(event));
    };
    const flushDelta = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!buffer) return;
      send({ type: "agent.delta", threadId: thread.threadId, turnId, delta: buffer });
      buffer = "";
    };
    return {
      emit: (event: AgentEvent) => {
        if (event.type === "agent.delta") {
          turnId = event.turnId;
          buffer += event.delta;
          if (buffer.length >= DELTA_FLUSH_CHARS) flushDelta();
          else if (!timer) timer = setTimeout(flushDelta, DELTA_FLUSH_MS);
          return;
        }
        flushDelta();
        send(event);
      },
      flush: async () => {
        flushDelta();
        await chain;
      },
    };
  }

  // ---------------------------------------------------------------- storage

  private room(projectId: string): RoomApi {
    // The typed stub (M3); RoomApi is the subset the agent uses, kept loose on results.
    return projectRoom(this.env, projectId) as unknown as RoomApi;
  }

  private attachProject(projectId: string): void {
    this.setMeta("project_id", projectId);
    this.setMeta("canvas_id", canvasIdFor(projectId));
    if (this.meta("surface") === "home") this.setMeta("surface", "canvas");
    void this.env.DB.prepare("UPDATE agent_threads SET project_id = ?, surface = 'canvas', updated_at = ? WHERE id = ?")
      .bind(projectId, Date.now(), this.meta("thread_id"))
      .run()
      .catch((err: unknown) => console.error(JSON.stringify({ msg: "agent: thread index update failed", error: String(err) })));
  }

  private denied(workspaceId: string): AgentError | null {
    const ws = this.meta("workspace_id");
    return !ws || ws !== workspaceId ? { ok: false, code: "NOT_FOUND", message: "Thread not found" } : null;
  }

  private meta(key: string): string | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private messageCount(): number {
    return Number(this.ctx.storage.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM messages").one().c);
  }

  private loadMessages(limit: number): ThreadMessage[] {
    const rows = this.ctx.storage.sql
      .exec<{ id: string; role: string; content: string; created_at: number; proposal_id: string | null }>(
        "SELECT id, role, content, created_at, proposal_id FROM messages ORDER BY created_at DESC, rowid DESC LIMIT ?",
        limit,
      )
      .toArray()
      .reverse();
    return rows.map((r) => ({
      id: r.id,
      role: r.role === "assistant" ? "assistant" : "user",
      content: r.content,
      createdAt: r.created_at,
      ...(r.proposal_id ? { proposalId: r.proposal_id } : {}),
    }));
  }

  private saveProposal(p: Proposal): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO proposals (id, kind, base_revision, body, estimate, status, decided_at, created_at) VALUES (?, ?, ?, ?, ?, 'proposed', NULL, ?)",
      p.id,
      p.kind,
      p.baseRevision,
      JSON.stringify(p),
      p.estimate.credits,
      p.createdAt,
    );
  }

  private rowToProposal(r: { body: string; status: string; base_revision: number | null }): Proposal {
    const p = JSON.parse(r.body) as Proposal;
    return { ...p, status: r.status as ProposalStatus, baseRevision: r.base_revision };
  }

  private loadProposal(id: string): Proposal | null {
    const r = this.ctx.storage.sql.exec<{ body: string; status: string; base_revision: number | null }>("SELECT body, status, base_revision FROM proposals WHERE id = ?", id).toArray()[0];
    return r ? this.rowToProposal(r) : null;
  }

  private loadProposals(): Proposal[] {
    return this.ctx.storage.sql
      .exec<{ body: string; status: string; base_revision: number | null }>("SELECT body, status, base_revision FROM proposals ORDER BY created_at DESC LIMIT 30")
      .toArray()
      .reverse()
      .map((r) => this.rowToProposal(r));
  }

  private threadState(): ThreadState {
    return {
      threadId: this.meta("thread_id")!,
      surface: (this.meta("surface") ?? "home") as Surface,
      skill: this.meta("skill"),
      projectId: this.meta("project_id"),
      canvasId: this.meta("canvas_id"),
      summary: this.meta("summary") ?? "",
      messages: this.loadMessages(LOAD_MESSAGES),
      proposals: this.loadProposals(),
      tool: (this.meta("tool") as FieldTool | null) ?? null,
    };
  }

  private view(): ThreadView {
    return {
      id: this.meta("thread_id")!,
      workspaceId: this.meta("workspace_id")!,
      projectId: this.meta("project_id"),
      canvasId: this.meta("canvas_id"),
      surface: (this.meta("surface") ?? "home") as Surface,
      skill: this.meta("skill"),
      tool: this.meta("tool"),
      llm: this.meta("llm"),
      messages: this.loadMessages(100),
      proposals: this.loadProposals(),
    };
  }
}
