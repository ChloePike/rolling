/**
 * Access checks for projects and assets (M3). The only place these routes read
 * the auth context: `c.get("auth")` from the auth middleware, resolved here on
 * demand when the middleware is not mounted on a path.
 *
 * Every project belongs to a workspace; a caller may use a project when they are
 * a member of that workspace (any role reads, editor+ writes). Missing and
 * foreign projects both answer NOT_FOUND so ids do not leak.
 */
import type { Context } from "hono";
import { roleAtLeast, type Role } from "@rolling/core/auth/roles";
import { requireUser, resolveAuth, type AuthContext } from "../auth/context";
import type { Membership } from "../auth/workspace";
import type { AppEnv } from "../env";
import { ApiError } from "./errors";
import type { ProjectRoom } from "../do/ProjectRoom";

export type { AuthContext };

export async function authOf(c: Context<AppEnv>): Promise<AuthContext | null> {
  let auth = c.get("auth");
  if (auth === undefined) {
    auth = await resolveAuth(c);
    c.set("auth", auth);
    c.set("user", auth ? { id: auth.userId } : null);
  }
  return auth;
}

export async function requireAuth(c: Context<AppEnv>): Promise<AuthContext> {
  // Normal path: the auth middleware on /api/* already resolved the context.
  if (c.get("auth") !== undefined) return requireUser(c);
  const auth = await authOf(c);
  if (!auth) throw new ApiError(401, "UNAUTHENTICATED", "Sign in required");
  return auth;
}

/** D-005 for one membership: active plan, the user's preference and the workspace switch. */
export function matureAllowedIn(auth: AuthContext, m: Membership): boolean {
  return m.plan !== null && auth.prefs.matureContent && m.matureAllowed;
}

export interface ProjectRow {
  id: string;
  workspace_id: string;
  title: string;
  kind: string;
  thumb_key: string | null;
  node_count: number;
  created_by: string;
  updated_at: number;
}

export interface ProjectAccess {
  project: ProjectRow;
  membership: Membership;
  role: Role;
  canEdit: boolean;
  matureAllowed: boolean;
}

export async function projectAccess(c: Context<AppEnv>, auth: AuthContext, projectId: string, min: Role = "viewer"): Promise<ProjectAccess> {
  const project = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first<ProjectRow>();
  const membership = project ? auth.memberships.find((m) => m.workspaceId === project.workspace_id) : undefined;
  if (!project || !membership) throw new ApiError(404, "NOT_FOUND", "Project not found", { projectId });
  if (!roleAtLeast(membership.role, min)) {
    throw new ApiError(403, "FORBIDDEN", "Your role does not allow this", { required: min, role: membership.role });
  }
  return {
    project,
    membership,
    role: membership.role,
    canEdit: roleAtLeast(membership.role, "editor"),
    matureAllowed: matureAllowedIn(auth, membership),
  };
}

/** Membership of the asset's workspace, or null (shared assets have no workspace). */
export function membershipFor(auth: AuthContext, workspaceId: string | null): Membership | null {
  return workspaceId ? (auth.memberships.find((m) => m.workspaceId === workspaceId) ?? null) : null;
}

export function requireEditor(auth: AuthContext): void {
  if (!roleAtLeast(auth.role, "editor")) {
    throw new ApiError(403, "FORBIDDEN", "Your role does not allow this", { required: "editor", role: auth.role });
  }
}

/** Caller identity passed to ProjectRoom RPCs; the DO re-checks the workspace on every call. */
export interface RoomCaller {
  userId: string;
  workspaceId: string;
  canEdit: boolean;
}

export function roomCaller(auth: AuthContext, access: ProjectAccess): RoomCaller {
  return { userId: auth.userId, workspaceId: access.project.workspace_id, canEdit: access.canEdit };
}

/** Public RPC surface of ProjectRoom (see do/ProjectRoom.ts). */
export type ProjectRoomApi = Pick<
  ProjectRoom,
  | "init"
  | "setTitle"
  | "destroy"
  | "getSnapshot"
  | "getGraph"
  | "applyPatch"
  | "undo"
  | "redo"
  | "addVersion"
  | "inputDigest"
  | "listVersions"
  | "setActiveVersion"
  | "planRun"
  | "markRunning"
  | "markFailed"
  | "markQueued"
  | "resetNode"
  | "broadcast"
  | "getTimeline"
  | "patchTimeline"
  | "reassembleTimeline"
  | "flushIndex"
  | "hubSubscribe"
  | "hubUnsubscribe"
  | "registerThread"
  | "unregisterThread"
  | "notifyThreads"
  // D-031 collaboration.
  | "presenceUpdate"
  | "presenceLeave"
  | "presenceList"
  | "listThreads"
  | "createThread"
  | "replyThread"
  | "setThreadStatus"
  | "editComment"
  | "deleteComment"
  | "markThreadsRead"
  | "listActivity"
  | "reviewThreads"
  | "reviewComment"
  | "reviewEvent"
>;

/**
 * Typed ProjectRoom stub. The generated RPC types map results that carry
 * `unknown` (node params) to `never`, so the stub is typed with the DO's own
 * method signatures; every value crossing RPC is structured-clonable JSON.
 */
export function projectRoom(env: Env, projectId: string): ProjectRoomApi {
  return env.PROJECT.get(env.PROJECT.idFromName(projectId)) as unknown as ProjectRoomApi;
}
