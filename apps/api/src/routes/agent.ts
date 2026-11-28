/**
 * Agent routes (M6, docs/api.md → Agent). Members only (D-007: NO_PLAN);
 * each turn holds and settles its LLM cost against the plan's monthly agent
 * allowance in the CreditAccount DO (D-012). Turns run in the
 * AgentSession DO (one per thread) and stream over WebSockets (D-003): the
 * project socket for canvas/editor threads, the user socket for Home/tool
 * threads, and the thread socket `GET /api/agent/threads/:id/ws`.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { AGENT_MODES, FIELD_TOOLS, SKILL_IDS } from "@rolling/agent";
import { AUTO_BUDGET, autoBudgetCredits } from "@rolling/core/pricing/config";
import { PUBLIC_CHAT_MODELS } from "@rolling/core";
import { newId } from "@rolling/core/ids";
import type { AgentCaller, AgentError, ApplyResult, ThreadView, TurnSummary } from "../do/AgentSession";
import { allowancePeriod, allowanceView } from "../agent/allowance";
import type { AppEnv } from "../env";
import { requireRole, requireUser, type AuthContext } from "../auth/context";
import { requireGenerator, trialAgentTurn, trialAllowanceView } from "../auth/trial";
import { projectAccess } from "../lib/access";
import { ApiError } from "../lib/errors";
import { validate } from "../lib/validate";

const Id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const IdParam = z.object({ id: Id });

const CreateThread = z.object({
  projectId: Id.optional(),
  surface: z.enum(["home", "canvas", "editor", "tool"]),
  skill: z.enum(SKILL_IDS).optional(),
  tool: z.enum(FIELD_TOOLS).optional(),
});

const SendMessage = z.object({
  text: z.string().trim().min(1).max(8000),
  refs: z.array(Id).max(20).default([]),
  selection: z.array(Id).max(100).default([]),
  /** Public agent LLM id (D-009). */
  llm: z.string().max(64).optional(),
  /** The prompt box's pills (Home: video model, aspect ratio, total length); the agent uses them unless the brief says otherwise. */
  settings: z
    .object({
      videoModel: z.string().max(120).nullable().optional(),
      ratio: z.enum(["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"]).optional(),
      seconds: z.number().int().min(1).max(600).optional(),
      resolution: z.string().max(12).optional(),
    })
    .optional(),
  /** D-021: read | edit (default) | auto. */
  mode: z.enum(AGENT_MODES).optional(),
  /** Auto: credits this turn may start runs for; default the user's Auto budget, else the confirm threshold. */
  autoBudget: z.number().int().min(0).max(AUTO_BUDGET.max).optional(),
});

/** D-039: move a Home conversation onto a canvas (an existing project, or a new one). */
const AttachThread = z.object({ projectId: Id.optional(), title: z.string().trim().min(1).max(120).optional() });

const UndoAuto = z.union([z.object({ changeId: z.string().min(1).max(160) }), z.object({ turnId: z.string().min(1).max(80) })]);

interface ThreadRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  surface: string;
  skill: string | null;
  title: string | null;
  updated_at: number;
  created_by: string | null;
}

/** Typed view of the AgentSession stub (RPC). */
interface SessionApi {
  init(input: unknown): Promise<ThreadView | AgentError>;
  get(workspaceId: string): Promise<ThreadView | AgentError>;
  send(input: unknown): Promise<TurnSummary | AgentError>;
  cancel(workspaceId: string, turnId?: string): Promise<{ ok: true; canceled: boolean } | AgentError>;
  apply(proposalId: string, caller: AgentCaller, opts: { optionIndex?: number; title?: string }): Promise<ApplyResult | AgentError>;
  discard(proposalId: string, caller: AgentCaller): Promise<{ ok: true } | AgentError>;
  undoAuto(caller: AgentCaller, target: { changeId?: string; turnId?: string }): Promise<unknown>;
  attach(caller: AgentCaller, opts: { projectId?: string; title?: string }): Promise<{ ok: true; projectId: string; thread: ThreadView } | AgentError>;
  fetch(req: Request): Promise<Response>;
}

function session(env: Env, threadId: string): SessionApi {
  return env.AGENT.get(env.AGENT.idFromName(threadId)) as unknown as SessionApi;
}

const STATUS = { NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409, VALIDATION_FAILED: 422, AGENT_ALLOWANCE_EXHAUSTED: 429, RATE_LIMITED: 429, UNAVAILABLE: 503 } as const;

function ok<T>(res: T | AgentError): T {
  if (typeof res === "object" && res !== null && (res as { ok?: unknown }).ok === false) {
    const e = res as AgentError;
    // UNAVAILABLE (no model gateway configured) goes out as 503 INTERNAL, like other unconfigured services.
    throw new ApiError(STATUS[e.code], e.code === "UNAVAILABLE" ? "INTERNAL" : e.code, e.message, e.data ?? {});
  }
  return res as T;
}

export function callerOf(auth: AuthContext): AgentCaller {
  return {
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    role: auth.role,
    plan: auth.plan,
    matureAllowed: auth.matureAllowed,
    language: auth.prefs.language,
    creationMode: auth.prefs.creationMode,
    confirmThreshold: auth.prefs.confirmThreshold,
  };
}

async function threadRow(c: Context<AppEnv>, auth: AuthContext, id: string): Promise<ThreadRow> {
  const row = await c.env.DB.prepare("SELECT * FROM agent_threads WHERE id = ?").bind(id).first<ThreadRow>();
  if (!row || row.workspace_id !== auth.workspaceId) throw new ApiError(404, "NOT_FOUND", "Thread not found", { threadId: id });
  return row;
}

async function proposalThread(c: Context<AppEnv>, auth: AuthContext, proposalId: string): Promise<string> {
  const row = await c.env.DB.prepare("SELECT thread_id, workspace_id FROM agent_proposals WHERE id = ?").bind(proposalId).first<{ thread_id: string; workspace_id: string }>();
  if (!row || row.workspace_id !== auth.workspaceId) throw new ApiError(404, "NOT_FOUND", "Proposal not found", { proposalId });
  return row.thread_id;
}

export const agent = new Hono<AppEnv>()
  .get("/allowance", async (c) => {
    // Members, or a workspace on its trial (D-022: the trial's own DeepSeek allowance).
    const auth = await requireGenerator(c);
    if (auth.trialUntil !== null) return c.json(await trialAllowanceView(c.env, auth.workspaceId, auth.trialUntil));
    return c.json(await allowanceView(c.env, { workspaceId: auth.workspaceId, plan: auth.plan, mature: auth.matureAllowed }));
  })
  .post("/threads", validate("json", CreateThread), async (c) => {
    const auth = await requireGenerator(c);
    const body = c.req.valid("json");
    if ((body.surface === "canvas" || body.surface === "editor") && !body.projectId) {
      throw new ApiError(400, "VALIDATION_FAILED", "Canvas and editor threads need a projectId");
    }
    if (body.surface === "tool" && !body.tool) throw new ApiError(400, "VALIDATION_FAILED", "Tool threads need a tool");
    if (body.projectId) await projectAccess(c, auth, body.projectId);
    const id = newId("thread");
    const now = Date.now();
    await c.env.DB.prepare("INSERT INTO agent_threads (id, workspace_id, project_id, surface, skill, title, updated_at, created_by) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)")
      .bind(id, auth.workspaceId, body.projectId ?? null, body.surface, body.skill ?? null, now, auth.userId)
      .run();
    const thread = ok(
      await session(c.env, id).init({
        threadId: id,
        workspaceId: auth.workspaceId,
        projectId: body.projectId ?? null,
        surface: body.surface,
        skill: body.skill ?? null,
        tool: body.tool ?? null,
        createdBy: auth.userId,
      }),
    );
    return c.json({ thread }, 201);
  })
  .get(
    "/threads",
    validate("query", z.object({ projectId: Id.optional(), first: z.coerce.number().int().min(1).max(50).default(20), mine: z.enum(["1", "true", "0", "false"]).optional() })),
    async (c) => {
    const auth = requireUser(c);
    const { projectId, first, mine } = c.req.valid("query");
    // `mine`: only the caller's own threads (the canvas panel restores one of these, never a teammate's).
    const own = mine === "1" || mine === "true" ? auth.userId : null;
    const rows = await c.env.DB.prepare(
      "SELECT * FROM agent_threads WHERE workspace_id = ? AND (? IS NULL OR project_id = ?) AND (? IS NULL OR created_by = ?) ORDER BY updated_at DESC LIMIT ?",
    )
      .bind(auth.workspaceId, projectId ?? null, projectId ?? null, own, own, first)
      .all<ThreadRow>();
    return c.json({
      items: rows.results.map((r) => ({ id: r.id, projectId: r.project_id, surface: r.surface, skill: r.skill, title: r.title, updatedAt: r.updated_at })),
    });
    },
  )
  .get("/threads/:id", validate("param", IdParam), async (c) => {
    const auth = requireUser(c);
    const row = await threadRow(c, auth, c.req.valid("param").id);
    return c.json({ thread: ok(await session(c.env, row.id).get(auth.workspaceId)) });
  })
  .post("/threads/:id/messages", validate("param", IdParam), validate("json", SendMessage), async (c) => {
    const auth = await requireGenerator(c);
    const row = await threadRow(c, auth, c.req.valid("param").id);
    const body = c.req.valid("json");
    const picked = body.llm && PUBLIC_CHAT_MODELS.some((m) => m.id === body.llm) ? body.llm : undefined;
    if (body.llm && !picked) throw new ApiError(400, "VALIDATION_FAILED", "Unknown agent model", { llm: body.llm });
    // D-022: a trial plans with DeepSeek only, within the trial's agent allowance.
    const llm = await trialAgentTurn(c, auth, picked);
    if (row.project_id) await projectAccess(c, auth, row.project_id);
    const allowance = await allowancePeriod(c.env, auth.workspaceId, auth.plan);
    const turnId = newId("event");
    // D-021: Auto's per-turn budget counts as the user's approval for runs within it (quote → hold → settle as always).
    const mode = body.mode ?? "edit";
    const autoBudget = mode === "auto" ? autoBudgetCredits(body.autoBudget ?? auth.prefs.autoBudget, auth.prefs.confirmThreshold) : undefined;
    const result = ok(
      await session(c.env, row.id).send({
        caller: callerOf(auth),
        text: body.text,
        refs: body.refs,
        selection: body.selection,
        ...(llm ? { llm } : {}),
        ...(body.settings ? { settings: body.settings } : {}),
        turnId,
        allowance,
        mode,
        ...(autoBudget !== undefined ? { autoBudget, runAuth: auth } : {}),
      }),
    );
    return c.json(result);
  })
  .post("/threads/:id/attach", validate("param", IdParam), validate("json", AttachThread), async (c) => {
    // D-039: a Home conversation without a project continues on a canvas. Moving it is free (no turn runs).
    const auth = requireRole(c, "editor");
    const row = await threadRow(c, auth, c.req.valid("param").id);
    const body = c.req.valid("json");
    if (body.projectId) {
      const access = await projectAccess(c, auth, body.projectId, "editor");
      if (access.project.workspace_id !== row.workspace_id) throw new ApiError(404, "NOT_FOUND", "Project not found", { projectId: body.projectId });
    }
    const res = ok(await session(c.env, row.id).attach(callerOf(auth), { ...(body.projectId ? { projectId: body.projectId } : {}), ...(body.title ? { title: body.title } : {}) }));
    return c.json({ projectId: res.projectId, thread: res.thread });
  })
  .post("/threads/:id/auto/undo",validate("param", IdParam), validate("json", UndoAuto), async (c) => {
    // Undo is free: any editor of the thread's workspace may undo what Auto applied.
    const auth = requireUser(c);
    const row = await threadRow(c, auth, c.req.valid("param").id);
    if (row.project_id) await projectAccess(c, auth, row.project_id, "editor");
    const body = c.req.valid("json");
    return c.json(ok(await session(c.env, row.id).undoAuto(callerOf(auth), body)));
  })
  .post("/threads/:id/cancel", validate("param", IdParam), validate("json", z.object({ turnId: z.string().max(80).optional() })), async (c) => {
    const auth = requireUser(c);
    const row = await threadRow(c, auth, c.req.valid("param").id);
    return c.json(ok(await session(c.env, row.id).cancel(auth.workspaceId, c.req.valid("json").turnId)));
  })
  .get("/threads/:id/ws", validate("param", IdParam), async (c) => {
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") throw new ApiError(426, "BAD_REQUEST", "Expected WebSocket upgrade");
    const auth = await requireGenerator(c);
    const row = await threadRow(c, auth, c.req.valid("param").id);
    const h = new Headers(c.req.raw.headers);
    h.set("x-workspace-id", auth.workspaceId);
    h.set("x-user-id", auth.userId);
    return session(c.env, row.id).fetch(new Request(c.req.raw, { headers: h }));
  })
  .post(
    "/proposals/:id/apply",
    validate("param", IdParam),
    validate("json", z.object({ optionIndex: z.number().int().min(0).max(2).optional(), title: z.string().trim().min(1).max(120).optional() })),
    async (c) => {
      const auth = await requireGenerator(c);
      const proposalId = c.req.valid("param").id;
      const threadId = await proposalThread(c, auth, proposalId);
      const body = c.req.valid("json");
      return c.json(ok(await session(c.env, threadId).apply(proposalId, callerOf(auth), body)));
    },
  )
  .post("/proposals/:id/discard", validate("param", IdParam), async (c) => {
    const auth = requireUser(c);
    const proposalId = c.req.valid("param").id;
    const threadId = await proposalThread(c, auth, proposalId);
    return c.json(ok(await session(c.env, threadId).discard(proposalId, callerOf(auth))));
  });
