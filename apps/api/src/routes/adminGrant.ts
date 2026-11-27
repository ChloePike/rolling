/**
 * `POST /api/admin/grant` — owner-only comp grants without Stripe: give a
 * user's workspace an active plan for a number of months and/or extra credits.
 * 404 unless the `ADMIN_TOKEN` secret is set; 401 without `authorization:
 * Bearer <ADMIN_TOKEN>`. No session needed: the target is chosen by email.
 * Kept for scripts; the admin console (`routes/admin.ts`) grants through the
 * same `grantCompPlan` with a staff actor. Both write an `admin_audit` entry.
 *
 * Body: `{ email, planId, months?, seats?, extraCredits?, workspaceName? }`.
 * Writes a `subscriptions` row with a `comp_` id (it does not renew; it ends at
 * `now + months × 30 days`), grants the plan's credits for that period through
 * CreditAccount like `invoice.paid` would, and adds `extraCredits` as purchased
 * credits (no expiry). Every credit change goes through CreditAccount.
 */
import { Hono } from "hono";
import { z } from "zod";
import { PLAN_ORDER, type PlanId } from "@rolling/core";
import type { AppEnv } from "../env";
import { upsertSubscription } from "../billing/stripe";
import { creditAccount, unwrapLedger } from "../billing/credits";
import { ApiError } from "../lib/errors";
import { validate } from "../lib/validate";
import { audit, TOKEN_ACTOR, type Actor } from "../ops/audit";
import { testTokenMatches } from "./testInbox";

const PlanEnum = z.enum(PLAN_ORDER as unknown as [string, ...string[]]);

export const CompGrantFields = {
  planId: PlanEnum,
  months: z.number().int().min(1).max(36).default(1),
  seats: z.number().int().min(1).max(200).default(1),
  extraCredits: z.number().int().min(0).max(1_000_000).default(0),
  workspaceName: z.string().trim().min(1).max(60).optional(),
};

const Body = z.object({ email: z.string().trim().toLowerCase().email(), ...CompGrantFields });

const DAY = 24 * 60 * 60 * 1000;

export interface CompGrantInput {
  workspaceId: string;
  planId: string;
  months: number;
  seats: number;
  extraCredits: number;
  workspaceName?: string | undefined;
}

/** The comp grant itself (subscription row + CreditAccount grant + optional purchased credits) and its audit entry. */
export async function grantCompPlan(env: Env, input: CompGrantInput, actor: Actor, reason: string | null) {
  const { workspaceId, planId, months, seats, extraCredits, workspaceName } = input;
  const plan = planId as PlanId;
  const now = Date.now();
  const periodStart = now;
  const periodEnd = now + months * 30 * DAY;
  const subId = `comp_${workspaceId}`;
  await upsertSubscription(env, {
    id: subId,
    workspaceId,
    planId: plan,
    interval: "month",
    status: "active",
    periodStart,
    periodEnd,
    cancelAtPeriodEnd: true,
    priceId: `comp_${plan}`,
    seats: plan === "team" ? seats : 1,
    baseItemId: `comp_base_${plan}`,
    seatItemId: plan === "team" ? `comp_seat_${plan}` : null,
    ...(workspaceName && { workspaceName }),
  });
  const account = creditAccount(env, workspaceId);
  unwrapLedger(
    await account.grant(
      { planId: plan, interval: "month", start: periodStart, end: periodEnd, ...(plan === "team" ? { seats } : {}) },
      `comp-grant:${subId}:${periodStart}`,
    ),
  );
  if (extraCredits > 0) unwrapLedger(await account.purchase(extraCredits, `comp_${now}`, `comp-purchase:${subId}:${now}`));
  const balance = await account.balance();
  const auditId = await audit(env, actor, {
    action: "plan.comp_grant",
    target: { kind: "workspace", id: workspaceId },
    reason,
    data: { planId, months, seats: plan === "team" ? seats : 1, extraCredits, periodEnd },
  });
  return { workspaceId, subscriptionId: subId, planId, seats: plan === "team" ? seats : 1, periodEnd, balance, auditId };
}

export const adminGrant = new Hono<AppEnv>().post(
  "/grant",
  async (c, next) => {
    const expected = c.env.ADMIN_TOKEN;
    if (!expected) throw new ApiError(404, "NOT_FOUND", "Route not found", { path: c.req.path });
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token || !(await testTokenMatches(token, expected))) throw new ApiError(401, "UNAUTHENTICATED", "Invalid admin token");
    return next();
  },
  validate("json", Body),
  async (c) => {
    const { email, ...rest } = c.req.valid("json");
    // The user's own (owner) workspace: the personal one, or the team it became.
    const row = await c.env.DB.prepare(
      `SELECT m.workspace_id AS workspaceId FROM users u
       JOIN workspace_members m ON m.user_id = u.id AND m.role = 'owner'
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE lower(u.email) = ?1
       ORDER BY CASE w.kind WHEN 'personal' THEN 0 ELSE 1 END, w.created_at
       LIMIT 1`,
    )
      .bind(email)
      .first<{ workspaceId: string }>();
    if (!row) throw new ApiError(404, "NOT_FOUND", "No account with that email owns a workspace", { email });
    const out = await grantCompPlan(c.env, { workspaceId: row.workspaceId, ...rest }, TOKEN_ACTOR, "admin token grant");
    c.header("cache-control", "no-store");
    const { auditId: _auditId, ...body } = out;
    return c.json({ email, ...body });
  },
);
