/**
 * Suspensions (D-025): a suspended user, or every member of a suspended
 * workspace, can sign in and browse but cannot generate or use the agent
 * (`requireMember` answers `403 SUSPENDED`). Set and lifted from the admin
 * console; every change is audited by the caller.
 */
import { newId } from "@rolling/core/ids";

export interface ActiveSuspension {
  id: string;
  scope: "user" | "workspace";
  subjectId: string;
  since: number;
}

interface Row {
  id: string;
  subject_kind: "user" | "workspace";
  subject_id: string;
  created_at: number;
}

/** Active suspensions of the user and of every workspace they belong to (one query). */
export async function activeSuspensions(env: Env, userId: string): Promise<ActiveSuspension[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, subject_kind, subject_id, created_at FROM suspensions
       WHERE lifted_at IS NULL AND ((subject_kind = 'user' AND subject_id = ?1)
         OR (subject_kind = 'workspace' AND subject_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?1)))
       ORDER BY created_at`,
    )
      .bind(userId)
      .all<Row>();
    return rows.results.map((r) => ({ id: r.id, scope: r.subject_kind, subjectId: r.subject_id, since: r.created_at }));
  } catch (err) {
    // Fail open for browsing; generation still re-checks the ledger and safety layers.
    console.error(JSON.stringify({ msg: "suspensions: lookup failed", error: String(err) }));
    return [];
  }
}

/** The suspension that applies in a workspace: the user's own, else the workspace's. */
export function suspensionFor(list: readonly ActiveSuspension[], userId: string, workspaceId: string): ActiveSuspension | null {
  return list.find((s) => s.scope === "user" && s.subjectId === userId) ?? list.find((s) => s.scope === "workspace" && s.subjectId === workspaceId) ?? null;
}

/** Suspends a subject (no-op when already suspended: returns the active one). */
export async function suspend(env: Env, subject: { kind: "user" | "workspace"; id: string }, reason: string, by: string | null, caseId: string | null = null): Promise<{ id: string; created: boolean }> {
  const existing = await env.DB.prepare("SELECT id FROM suspensions WHERE subject_kind = ? AND subject_id = ? AND lifted_at IS NULL LIMIT 1")
    .bind(subject.kind, subject.id)
    .first<{ id: string }>();
  if (existing) return { id: existing.id, created: false };
  const id = newId("suspension");
  await env.DB.prepare("INSERT INTO suspensions (id, subject_kind, subject_id, reason, case_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, subject.kind, subject.id, reason.slice(0, 1000), caseId, by, Date.now())
    .run();
  return { id, created: true };
}

/** Lifts every active suspension of a subject. Returns how many were lifted. */
export async function unsuspend(env: Env, subject: { kind: "user" | "workspace"; id: string }, by: string | null): Promise<number> {
  const r = await env.DB.prepare("UPDATE suspensions SET lifted_at = ?, lifted_by = ? WHERE subject_kind = ? AND subject_id = ? AND lifted_at IS NULL")
    .bind(Date.now(), by, subject.kind, subject.id)
    .run();
  return r.meta.changes ?? 0;
}

/** Notice shown to the user in the app (warnings, removals, suspensions). */
export async function notifyUser(
  env: Env,
  input: { userId: string; workspaceId?: string | null; kind: "warning" | "content_removed" | "suspended" | "restored"; message: string; caseId?: string | null },
): Promise<string> {
  const id = newId("notice");
  await env.DB.prepare("INSERT INTO user_notices (id, user_id, workspace_id, kind, message, case_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, input.userId, input.workspaceId ?? null, input.kind, input.message.slice(0, 1000), input.caseId ?? null, Date.now())
    .run();
  return id;
}
