/**
 * Workspaces and prefs bootstrap (M1): every user has a personal workspace they
 * own and a `user_prefs` row. Created on sign-up (Better Auth user hook) and,
 * as a fallback, lazily by the auth middleware (e.g. a hook that failed, or a
 * dev-header user in development and tests).
 */
import { initialPrefs, prefsFromRow, type Prefs, type PrefsRow } from "@rolling/core/auth/prefs";
import { isRole, type Role } from "@rolling/core/auth/roles";
import type { PlanId } from "@rolling/core/pricing/config";

export const PERSONAL_WORKSPACE_NAME = "Personal";

/**
 * Personal workspace id, deterministic per user so concurrent bootstraps
 * insert the same row: `usr_<ULID>` → `ws_<ULID>`. Other ids (dev-header users)
 * get `ws_dev_<id>`.
 */
export function personalWorkspaceId(userId: string): string {
  const m = /^usr_([0-9A-HJKMNP-TV-Z]{26})$/.exec(userId);
  return m ? `ws_${m[1]}` : `ws_dev_${userId}`;
}

export interface UserCreatedInfo {
  email?: string;
  name?: string;
  acceptLanguage: string | null;
}

function prefsInsert(db: D1Database, userId: string, prefs: Prefs, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO user_prefs (user_id, language, currency, creation_mode, default_ratio, default_model, confirm_threshold, notifications, mature_content, theme, updated_at, enhance_prompt)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .bind(
      userId,
      prefs.language,
      prefs.currency,
      prefs.creationMode,
      prefs.defaultRatio,
      prefs.defaultModel,
      prefs.confirmThreshold,
      JSON.stringify(prefs.notifications),
      prefs.matureContent ? 1 : 0,
      prefs.theme,
      now,
      prefs.enhancePrompt ? 1 : 0,
    );
}

/** Creates the personal workspace, owner membership and prefs. Idempotent. */
export async function ensurePersonalWorkspace(env: Env, userId: string, acceptLanguage: string | null): Promise<string> {
  const now = Date.now();
  const wsId = personalWorkspaceId(userId);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO workspaces (id, name, kind, mature_allowed, created_at) VALUES (?1, ?2, 'personal', 1, ?3)").bind(
      wsId,
      PERSONAL_WORKSPACE_NAME,
      now,
    ),
    env.DB.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?1, ?2, 'owner')").bind(wsId, userId),
    prefsInsert(env.DB, userId, initialPrefs(acceptLanguage), now),
  ]);
  return wsId;
}

/** Better Auth `user.create.after` hook. */
export async function onUserCreated(env: Env, userId: string, info: UserCreatedInfo): Promise<void> {
  await ensurePersonalWorkspace(env, userId, info.acceptLanguage);
  console.log(JSON.stringify({ msg: "auth: user created", userId }));
}

export interface Membership {
  workspaceId: string;
  name: string;
  kind: "personal" | "team";
  matureAllowed: boolean;
  role: Role;
  monthlyCreditLimit: number | null;
  /** Active plan of the workspace (status active/trialing, period not over), or null. */
  plan: PlanId | null;
}

interface MembershipRow {
  workspace_id: string;
  name: string;
  kind: string;
  mature_allowed: number;
  role: string;
  monthly_credit_limit: number | null;
  plan: string | null;
}

const PLAN_IDS: readonly string[] = ["starter", "plus", "pro", "team"];

/** SQL fragment: the active plan of workspace `ws` at time `?now`. */
export const ACTIVE_PLAN_SQL = (wsColumn: string, nowParam: string) =>
  `(SELECT s.plan FROM subscriptions s WHERE s.workspace_id = ${wsColumn} AND s.status IN ('active','trialing') AND s.current_period_end > ${nowParam} ORDER BY s.current_period_end DESC LIMIT 1)`;

function membershipsStatement(db: D1Database, userId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT m.workspace_id, w.name, w.kind, w.mature_allowed, m.role, m.monthly_credit_limit, ${ACTIVE_PLAN_SQL("m.workspace_id", "?2")} AS plan
       FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ?1
       ORDER BY (w.id = ?3) DESC, (w.kind = 'personal') DESC, w.created_at ASC, w.id ASC
       LIMIT 100`,
    )
    .bind(userId, now, personalWorkspaceId(userId));
}

function toMembership(r: MembershipRow): Membership | null {
  if (!isRole(r.role)) return null;
  return {
    workspaceId: r.workspace_id,
    name: r.name,
    kind: r.kind === "team" ? "team" : "personal",
    matureAllowed: Boolean(r.mature_allowed),
    role: r.role,
    monthlyCreditLimit: r.monthly_credit_limit,
    plan: r.plan && PLAN_IDS.includes(r.plan) ? (r.plan as PlanId) : null,
  };
}

/** Memberships (personal workspace first) and prefs in one D1 round trip. */
export async function loadAccount(env: Env, userId: string, now = Date.now()): Promise<{ memberships: Membership[]; prefs: Prefs | null }> {
  const [m, p] = await env.DB.batch<unknown>([
    membershipsStatement(env.DB, userId, now),
    env.DB.prepare("SELECT * FROM user_prefs WHERE user_id = ?1").bind(userId),
  ]);
  const memberships = ((m?.results ?? []) as MembershipRow[]).map(toMembership).filter((x): x is Membership => x !== null);
  const prefsRow = (p?.results?.[0] ?? null) as PrefsRow | null;
  return { memberships, prefs: prefsRow ? prefsFromRow(prefsRow) : null };
}


/** Longest workspace name (Team flow, `PATCH /api/workspace`). */
export const WORKSPACE_NAME_MAX = 60;

/** "{name}’s team" from the owner's name, else the local part of their email, else "Team". */
export function defaultTeamName(owner: { name?: string | null; email?: string | null }): string {
  const name = owner.name?.trim() || owner.email?.split("@")[0]?.trim() || "";
  return (name ? `${name}’s team` : "Team").slice(0, WORKSPACE_NAME_MAX);
}

/**
 * Names a workspace that becomes a Team workspace (D-013): the name the owner chose in the Team flow, else
 * "{owner}’s team". Only a workspace still named "Personal" is renamed, so a webhook replay never undoes a
 * rename made afterwards.
 */
export async function nameTeamWorkspace(db: D1Database, workspaceId: string, requested?: string | null): Promise<void> {
  const ws = await db.prepare("SELECT name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ name: string }>();
  if (!ws || ws.name !== PERSONAL_WORKSPACE_NAME) return;
  let name = requested?.trim().slice(0, WORKSPACE_NAME_MAX) ?? "";
  if (!name) {
    const owner = await db
      .prepare("SELECT u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role = 'owner' ORDER BY u.created_at LIMIT 1")
      .bind(workspaceId)
      .first<{ name: string | null; email: string | null }>();
    name = defaultTeamName(owner ?? {});
  }
  await db.prepare("UPDATE workspaces SET name = ? WHERE id = ? AND name = ?").bind(name, workspaceId, PERSONAL_WORKSPACE_NAME).run();
}
