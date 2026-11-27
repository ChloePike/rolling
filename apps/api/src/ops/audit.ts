/**
 * Immutable admin audit log (D-025). Every admin action, from the console or
 * an `ADMIN_TOKEN` script, writes one row in `admin_audit`; the table refuses
 * UPDATE and DELETE (triggers in migration 0027). Rows hold ids, never
 * prompts; `reason` is the staff member's own note.
 */
import { newId } from "@rolling/core/ids";

export interface Actor {
  kind: "staff" | "token" | "system";
  /** Staff user id; null for the token and the system. */
  id: string | null;
  role: string | null;
}

export const SYSTEM_ACTOR: Actor = { kind: "system", id: null, role: null };
export const TOKEN_ACTOR: Actor = { kind: "token", id: null, role: "admin" };

export interface AuditEntry {
  action: string;
  target?: { kind: string; id: string } | null;
  reason?: string | null;
  data?: Record<string, unknown>;
}

export function auditStatement(env: Env, actor: Actor, entry: AuditEntry, now = Date.now()): { id: string; stmt: D1PreparedStatement } {
  const id = newId("audit");
  const stmt = env.DB.prepare(
    "INSERT INTO admin_audit (id, actor_kind, actor_id, actor_role, action, target_kind, target_id, reason, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, actor.kind, actor.id, actor.role, entry.action, entry.target?.kind ?? null, entry.target?.id ?? null, entry.reason?.slice(0, 1000) ?? null, JSON.stringify(entry.data ?? {}), now);
  return { id, stmt };
}

export async function audit(env: Env, actor: Actor, entry: AuditEntry): Promise<string> {
  const { id, stmt } = auditStatement(env, actor, entry);
  await stmt.run();
  return id;
}
