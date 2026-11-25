/**
 * Agent routes (M6, docs/api.md → Agent). Members only (D-007: NO_PLAN);
 * a per-workspace daily turn limit protects against abuse. Turns run in the
 * AgentSession DO (one per thread) and stream over WebSockets (D-003): the
 * project socket for canvas/editor threads, the user socket for Home/tool
 * threads, and the thread socket `GET /api/agent/threads/:id/ws`.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { DAILY_TURN_LIMITS, dayKey, FIELD_TOOLS, nextDayStart, SKILL_IDS, turnWeight, DEFAULT_AGENT_LLM } from "@rolling/agent";
import { PUBLIC_CHAT_MODELS } from "@rolling/core";
import { newId } from "@rolling/core/ids";
import type { AgentCaller, AgentError, ApplyResult, ThreadView, TurnSummary } from "../do/AgentSession";
import type { AppEnv } from "../env";
import { requireMember, requireUser, type AuthContext } from "../auth/context";
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
});

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
  fetch(req: Request): Promise<Response>;
}

function session(env: Env, threadId: string): SessionApi {
  return env.AGENT.get(env.AGENT.idFromName(threadId)) as unknown as SessionApi;
}

const STATUS = { NOT_FOUND: 404, FORBIDDEN: 403, CONFLICT: 409, VALIDATION_FAILED: 422 } as const;

function ok<T>(res: T | AgentError): T {
  if (typeof res === "object" && res !== null && (res as { ok?: unknown }).ok === false) {
    const e = res as AgentError;
    throw new ApiError(STATUS[e.code], e.code, e.message, e.data ?? {});
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

/** D-007 abuse limit: turns per workspace per UTC day; premium LLMs weigh more (D-009 open item). */
async function takeTurn(env: Env, auth: AuthContext, llm: string): Promise<void> {
  const now = Date.now();
  const day = dayKey(now);
  const limit = DAILY_TURN_LIMITS[auth.plan!];
  const weight = turnWeight(llm);
  const row = await env.DB.prepare("SELECT turns FROM agent_usage WHERE workspace_id = ? AND day = ?").bind(auth.workspaceId, day).first<{ turns: number }>();
  const used = row?.turns ?? 0;
  if (used + weight > limit) {
    throw new ApiError(429, "RATE_LIMITED", "Daily agent limit reached for this workspace", { limit, used, resetsAt: nextDayStart(now) });
  }
  await env.DB.prepare("INSERT INTO agent_usage (workspace_id, day, turns) VALUES (?, ?, ?) ON CONFLICT (workspace_id, day) DO UPDATE SET turns = turns + excluded.turns")
    .bind(auth.workspaceId, day, weight)
    .run();
}

async function proposalThread(c: Context<AppEnv>, auth: AuthContext, proposalId: string): Promise<string> {
  const row = await c.env.DB.prepare("SELECT thread_id, workspace_id FROM agent_proposals WHERE id = ?").bind(proposalId).first<{ thread_id: string; workspace_id: string }>();
  if (!row || row.workspace_id !== auth.workspaceId) throw new ApiError(404, "NOT_FOUND", "Proposal not found", { proposalId });
  return row.thread_id;
}

export const agent = new Hono<AppEnv>()
  .post("/threads", validate("json", CreateThread), async (c) => {
    const auth = requireMember(c);
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
  .get("/threads", validate("query", z.object({ projectId: Id.optional(), first: z.coerce.number().int().min(1).max(50).default(20) })), async (c) => {
    const auth = requireUser(c);
    const { projectId, first } = c.req.valid("query");
    const rows = await c.env.DB.prepare(
      "SELECT * FROM agent_threads WHERE workspace_id = ? AND (? IS NULL OR project_id = ?) ORDER BY updated_at DESC LIMIT ?",
    )
      .bind(auth.workspaceId, projectId ?? null, projectId ?? null, first)
      .all<ThreadRow>();
    return c.json({
      items: rows.results.map((r) => ({ id: r.id, projectId: r.project_id, surface: r.surface, skill: r.skill, title: r.title, updatedAt: r.updated_at })),
    });
  })
  .get("/threads/:id", validate("param", IdParam), async (c) => {
    const auth = requireUser(c);
    const row = await threadRow(c, auth, c.req.valid("param").id);
    return c.json({ thread: ok(await session(c.env, row.id).get(auth.workspaceId)) });
  })
  .post("/threads/:id/messages", validate("param", IdParam), validate("json", SendMessage), async (c) => {
    const auth = requireMember(c);
    const row = await threadRow(c, auth, c.req.valid("param").id);
    const body = c.req.valid("json");
    const llm = body.llm && PUBLIC_CHAT_MODELS.some((m) => m.id === body.llm) ? body.llm : undefined;
    if (body.llm && !llm) throw new ApiError(400, "VALIDATION_FAILED", "Unknown agent model", { llm: body.llm });
    if (row.project_id) await projectAccess(c, auth, row.project_id);
    await takeTurn(c.env, auth, llm ?? DEFAULT_AGENT_LLM);
    const turnId = newId("event");
    const result = ok(
      await session(c.env, row.id).send({
        caller: callerOf(auth),
        text: body.text,
        refs: body.refs,
        selection: body.selection,
        ...(llm ? { llm } : {}),
        turnId,
      }),
    );
    return c.json(result);
  })
  .post("/threads/:id/cancel", validate("param", IdParam), validate("json", z.object({ turnId: z.string().max(80).optional() })), async (c) => {
    const auth = requireUser(c);
    const row = await threadRow(c, auth, c.req.valid("param").id);
    return c.json(ok(await session(c.env, row.id).cancel(auth.workspaceId, c.req.valid("json").turnId)));
  })
  .get("/threads/:id/ws", validate("param", IdParam), async (c) => {
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") throw new ApiError(426, "BAD_REQUEST", "Expected WebSocket upgrade");
    const auth = requireMember(c);
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
      const auth = requireMember(c);
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
