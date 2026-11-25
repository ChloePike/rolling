/**
 * The one place billing reads the caller's identity. Uses the auth
 * middleware's context (`c.get("auth")`: userId, workspaceId, role, plan,
 * isMember) and resolves it on demand where the middleware is not mounted.
 * The dev header (`x-dev-user`) is honoured inside `resolveAuth` only in
 * `ENVIRONMENT=development`.
 */
import type { Context } from "hono";
import { roleAtLeast, type Role } from "@rolling/core/auth/roles";
import { resolveAuth, type AuthContext } from "../auth/context";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/errors";

export type BillingCaller = Pick<AuthContext, "userId" | "workspaceId" | "role" | "plan" | "isMember" | "monthlyCreditLimit"> & {
  email: string | null;
};

export async function billingCaller(c: Context<AppEnv>, min: Role = "viewer"): Promise<BillingCaller> {
  let auth = c.get("auth");
  if (auth === undefined) {
    auth = await resolveAuth(c);
    c.set("auth", auth);
  }
  if (!auth) throw new ApiError(401, "UNAUTHENTICATED", "Sign in required");
  if (!roleAtLeast(auth.role, min)) {
    throw new ApiError(403, "FORBIDDEN", "Your role does not allow this", { required: min, role: auth.role });
  }
  return {
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    role: auth.role,
    plan: auth.plan,
    isMember: auth.isMember,
    monthlyCreditLimit: auth.monthlyCreditLimit,
    email: auth.user?.email ?? null,
  };
}
