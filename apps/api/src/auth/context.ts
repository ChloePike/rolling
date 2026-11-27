/**
 * The one auth middleware: resolves `AuthContext` once per `/api` request.
 *
 * - Session: Better Auth session cookie (sessions live in D1).
 * - Dev identity: the `x-dev-user` header (or `devUser` query) is honoured only
 *   when `ENVIRONMENT === "development"` (local dev and tests).
 * - Workspace: `x-workspace-id` header (or `workspaceId` query, for WebSocket
 *   upgrades that cannot set headers), validated against membership; default is
 *   the personal workspace.
 *
 * Routes read it with `c.get("auth")` (null when signed out) or the helpers
 * `requireUser`, `requireMember` (NO_PLAN, D-007) and `requireRole`.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { Prefs } from "@rolling/core/auth/prefs";
import { DEFAULT_PREFS } from "@rolling/core/auth/prefs";
import { roleAtLeast, type Role } from "@rolling/core/auth/roles";
import type { PlanId } from "@rolling/core/pricing/config";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/errors";
import { getAuth } from "./betterAuth";
import { ensurePersonalWorkspace, loadAccount, type Membership } from "./workspace";
import { activeSuspensions, suspensionFor, type ActiveSuspension } from "../ops/suspension";
import { SUSPENDED_MESSAGE } from "@rolling/core/ops/trust";

export interface AuthUser {
  id: string;
  email: string | null;
  name: string;
  image: string | null;
  emailVerified: boolean;
}

export interface AuthContext {
  userId: string;
  /** Null only for dev-header identities, which have no `users` row. */
  user: AuthUser | null;
  /** Better Auth session id; null for dev-header identities. */
  sessionId: string | null;
  workspaceId: string;
  workspace: { id: string; name: string; kind: "personal" | "team"; matureAllowed: boolean };
  role: Role;
  monthlyCreditLimit: number | null;
  /** Active plan of the workspace (subscription active/trialing and period not over), or null. */
  plan: PlanId | null;
  /** The workspace has an active plan (D-007). */
  isMember: boolean;
  /** D-005: member && prefs.matureContent && workspace.matureAllowed. */
  matureAllowed: boolean;
  prefs: Prefs;
  /** Every workspace the user belongs to (switcher), personal first. */
  memberships: Membership[];
  /**
   * D-025: an active suspension of the user or of the current workspace. Suspended callers can
   * browse; `requireMember` refuses generation and the agent with `403 SUSPENDED`.
   */
  suspension: ActiveSuspension | null;
}

const DEV_ID = /^[A-Za-z0-9_-]{1,64}$/;
const WS_ID = /^ws_[A-Za-z0-9_-]{1,80}$/;

function devIdentity(c: Context<AppEnv>): string | null {
  if (c.env.ENVIRONMENT !== "development") return null;
  const dev = c.req.header("x-dev-user") ?? c.req.query("devUser");
  return dev && DEV_ID.test(dev) ? dev : null;
}

function hasSessionCookie(req: Request): boolean {
  const cookie = req.headers.get("cookie");
  return !!cookie && cookie.includes(".session_token=");
}

function requestedWorkspace(c: Context<AppEnv>): string | null {
  const raw = c.req.header("x-workspace-id") ?? (c.req.header("upgrade") ? c.req.query("workspaceId") : undefined);
  if (raw === undefined || raw === "") return null;
  if (!WS_ID.test(raw)) throw new ApiError(400, "BAD_REQUEST", "Invalid workspace id", { workspaceId: raw });
  return raw;
}

/** Builds the context from memberships and prefs; throws FORBIDDEN for a workspace the user is not in. */
export function buildContext(
  userId: string,
  user: AuthUser | null,
  sessionId: string | null,
  memberships: Membership[],
  prefs: Prefs,
  requested: string | null,
  suspensions: readonly ActiveSuspension[] = [],
): AuthContext {
  const m = requested ? memberships.find((x) => x.workspaceId === requested) : memberships[0];
  if (!m) {
    throw new ApiError(403, "FORBIDDEN", "You are not a member of this workspace", { workspaceId: requested });
  }
  const isMember = m.plan !== null;
  return {
    userId,
    user,
    sessionId,
    workspaceId: m.workspaceId,
    workspace: { id: m.workspaceId, name: m.name, kind: m.kind, matureAllowed: m.matureAllowed },
    role: m.role,
    monthlyCreditLimit: m.monthlyCreditLimit,
    plan: m.plan,
    isMember,
    matureAllowed: isMember && prefs.matureContent && m.matureAllowed,
    prefs,
    memberships,
    suspension: suspensionFor(suspensions, userId, m.workspaceId),
  };
}

interface ResolvedSession {
  userId: string;
  user: AuthUser | null;
  sessionId: string | null;
  setCookies: string[];
}

async function resolveSession(c: Context<AppEnv>): Promise<ResolvedSession | null> {
  if (hasSessionCookie(c.req.raw)) {
    const auth = await getAuth(c.env);
    const { headers, response } = await auth.api.getSession({ headers: c.req.raw.headers, returnHeaders: true });
    if (response?.user) {
      const u = response.user;
      return {
        userId: u.id,
        user: { id: u.id, email: u.email, name: u.name, image: u.image ?? null, emailVerified: u.emailVerified },
        sessionId: response.session.id,
        // Sliding refresh (or clearing a stale cookie) comes back as Set-Cookie.
        setCookies: headers.getSetCookie(),
      };
    }
    const cleared = headers.getSetCookie();
    const dev = devIdentity(c);
    if (dev) return { userId: dev, user: null, sessionId: null, setCookies: cleared };
    if (cleared.length) c.set("authSetCookies", cleared);
    return null;
  }
  const dev = devIdentity(c);
  return dev ? { userId: dev, user: null, sessionId: null, setCookies: [] } : null;
}

/** Resolves the auth context for a request (null when signed out). */
export async function resolveAuth(c: Context<AppEnv>): Promise<AuthContext | null> {
  const session = await resolveSession(c);
  if (!session) return null;
  if (session.setCookies.length) c.set("authSetCookies", session.setCookies);
  const requested = requestedWorkspace(c);
  // Suspensions (D-025) load in parallel with the account: no extra round trip on the critical path.
  const [account, suspensions] = await Promise.all([loadAccount(c.env, session.userId), activeSuspensions(c.env, session.userId)]);
  let { memberships, prefs } = account;
  if (memberships.length === 0 || !prefs) {
    // Sign-up hook did not run or failed: bootstrap now (idempotent).
    await ensurePersonalWorkspace(c.env, session.userId, c.req.header("accept-language") ?? null);
    ({ memberships, prefs } = await loadAccount(c.env, session.userId));
  }
  return buildContext(session.userId, session.user, session.sessionId, memberships, prefs ?? DEFAULT_PREFS, requested, suspensions);
}

/** Paths that never need the auth context (Better Auth handles its own routes). */
function skips(path: string): boolean {
  return path === "/api/health" || path.startsWith("/api/health/") || path.startsWith("/api/auth/") || path === "/api/status";
}

/** Mounted once on `/api/*`. */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (skips(c.req.path)) {
    c.set("auth", null);
    c.set("user", null);
    return next();
  }
  const auth = await resolveAuth(c);
  c.set("auth", auth);
  c.set("user", auth ? { id: auth.userId } : null);
  await next();
  const cookies = c.get("authSetCookies");
  if (cookies?.length && c.res.status !== 101) {
    // Responses from DOs / Response.json may carry immutable headers; rebuild when needed.
    try {
      for (const v of cookies) c.res.headers.append("set-cookie", v);
    } catch {
      const res = new Response(c.res.body, c.res);
      for (const v of cookies) res.headers.append("set-cookie", v);
      c.res = res;
    }
  }
};

/** The signed-in context, or UNAUTHENTICATED (401). */
export function requireUser(c: Context<AppEnv>): AuthContext {
  const auth = c.get("auth");
  if (!auth) throw new ApiError(401, "UNAUTHENTICATED", "Sign in required");
  return auth;
}

/**
 * Signed in and the workspace has an active plan, else NO_PLAN (402, D-007). A suspended user or
 * workspace (D-025) gets `403 SUSPENDED` instead: generation and the agent go through here.
 */
export function requireMember(c: Context<AppEnv>): AuthContext {
  const auth = requireUser(c);
  if (auth.suspension) {
    throw new ApiError(403, "SUSPENDED", SUSPENDED_MESSAGE, { scope: auth.suspension.scope, suspensionId: auth.suspension.id, since: auth.suspension.since });
  }
  if (!auth.isMember) throw new ApiError(402, "NO_PLAN", "An active plan is required", { workspaceId: auth.workspaceId });
  return auth;
}

/** Signed in with at least `min` role in the current workspace, else FORBIDDEN (403). */
export function requireRole(c: Context<AppEnv>, min: Role): AuthContext {
  const auth = requireUser(c);
  if (!roleAtLeast(auth.role, min)) {
    throw new ApiError(403, "FORBIDDEN", "Your role does not allow this", { required: min, role: auth.role });
  }
  return auth;
}
