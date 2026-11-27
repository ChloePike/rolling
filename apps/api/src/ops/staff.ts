/**
 * Staff access to `/api/admin/*` (D-025). Checked on the server for every
 * admin route: a signed-in user listed in `staff` (by user id, or by verified
 * email: the owner is seeded before signing up), or the `ADMIN_TOKEN` bearer
 * for scripts (acts as `admin`, audited as `token`). Everyone else gets 404
 * (signed out: 401), so the console's existence is not advertised.
 */
import type { Context, MiddlewareHandler } from "hono";
import { isStaffRole, staffCan, type StaffPermission, type StaffRole } from "@rolling/core/ops/staff";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/errors";
import { testTokenMatches } from "../routes/testInbox";
import type { Actor } from "./audit";

export interface StaffContext {
  actor: Actor;
  role: StaffRole;
  email: string | null;
}

export type AdminEnv = AppEnv & { Variables: AppEnv["Variables"] & { staff: StaffContext } };

/** The caller's staff record, if any (binds `user_id` the first time an email match signs in). */
export async function staffOf(env: Env, auth: { userId: string; user: { email: string | null; emailVerified: boolean } | null } | null): Promise<StaffContext | null> {
  if (!auth) return null;
  const email = auth.user?.email?.trim().toLowerCase() ?? "";
  const verified = auth.user?.emailVerified === true && email !== "";
  const row = await env.DB.prepare("SELECT email, user_id, role FROM staff WHERE user_id = ?1 OR (?3 = 1 AND email = ?2) ORDER BY (user_id = ?1) DESC LIMIT 1")
    .bind(auth.userId, email, verified ? 1 : 0)
    .first<{ email: string; user_id: string | null; role: string }>();
  if (!row || !isStaffRole(row.role)) return null;
  // An email match whose row is bound to another account does not count.
  if (row.user_id && row.user_id !== auth.userId) return null;
  if (!row.user_id) await env.DB.prepare("UPDATE staff SET user_id = ? WHERE email = ? AND user_id IS NULL").bind(auth.userId, row.email).run();
  return { actor: { kind: "staff", id: auth.userId, role: row.role }, role: row.role, email: row.email };
}

async function tokenCaller(c: Context<AdminEnv>): Promise<StaffContext | null> {
  const expected = c.env.ADMIN_TOKEN;
  const header = c.req.header("authorization") ?? "";
  if (!expected || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token || !(await testTokenMatches(token, expected))) throw new ApiError(401, "UNAUTHENTICATED", "Invalid admin token");
  return { actor: { kind: "token", id: null, role: "admin" }, role: "admin", email: null };
}

/** Mounted on every `/api/admin/*` console route: resolves the staff caller or refuses. */
export const staffMiddleware: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const staff = (await tokenCaller(c)) ?? (await staffOf(c.env, c.get("auth")));
  if (!staff) {
    if (!c.get("auth")) throw new ApiError(401, "UNAUTHENTICATED", "Sign in required");
    throw new ApiError(404, "NOT_FOUND", "Route not found", { path: c.req.path });
  }
  c.set("staff", staff);
  c.header("cache-control", "no-store");
  await next();
};

/** The staff caller with `permission`, else 403. */
export function requireStaff(c: Context<AdminEnv>, permission: StaffPermission): StaffContext {
  const staff = c.get("staff");
  if (!staff || !staffCan(staff.role, permission)) throw new ApiError(403, "FORBIDDEN", "Your staff role does not allow this", { required: permission, role: staff?.role ?? null });
  return staff;
}
