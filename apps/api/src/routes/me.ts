/**
 * Account (M1): `GET /api/me`, `PATCH /api/me/prefs`.
 */
import { Hono } from "hono";
import { applyPrefsPatch, PrefsPatch, type Prefs } from "@rolling/core/auth/prefs";
import { PLANS, planConcurrentJobs, planMonthlyCredits, type PlanId } from "@rolling/core/pricing/config";
import type { AppEnv } from "../env";
import { requireUser, type AuthContext } from "../auth/context";
import { ApiError } from "../lib/errors";
import { validate } from "../lib/validate";

export interface BalanceView {
  plan: number;
  purchased: number;
  held: number;
  planExpiresAt: number | null;
}

const ZERO_BALANCE: BalanceView = { plan: 0, purchased: 0, held: 0, planExpiresAt: null };

/** CreditAccount (billing agent) `balance()` RPC when available; zeros otherwise. */
async function readBalance(env: Env, workspaceId: string): Promise<BalanceView> {
  try {
    const stub = env.CREDITS.get(env.CREDITS.idFromName(workspaceId)) as unknown as { balance?: () => Promise<Partial<BalanceView>> };
    if (typeof stub.balance !== "function") return ZERO_BALANCE;
    const b = await stub.balance();
    return {
      plan: Number(b?.plan ?? 0),
      purchased: Number(b?.purchased ?? 0),
      held: Number(b?.held ?? 0),
      planExpiresAt: typeof b?.planExpiresAt === "number" ? b.planExpiresAt : null,
    };
  } catch {
    return ZERO_BALANCE;
  }
}

interface SubscriptionRow {
  plan: PlanId;
  interval: "month" | "year";
  status: string;
  current_period_end: number;
  cancel_at_period_end: number;
  seats: number | null;
}

function planView(sub: SubscriptionRow | null) {
  if (!sub) return null;
  const p = PLANS[sub.plan];
  return {
    id: sub.plan,
    label: p.label,
    interval: sub.interval,
    status: sub.status,
    currentPeriodEnd: sub.current_period_end,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    perks: {
      // Team perks scale with purchased seats (D-013).
      monthlyCredits: planMonthlyCredits(sub.plan, sub.seats),
      topUpBonus: p.topUpBonus,
      concurrentJobs: planConcurrentJobs(sub.plan, sub.seats),
      maxVideoResolution: p.maxVideoResolution,
      maxImageResolution: p.maxImageResolution,
      voiceCloning: p.voiceCloning,
      seats: p.kind === "team" ? Math.max(1, sub.seats ?? 1) : 1,
    },
  };
}

export async function mePayload(env: Env, auth: AuthContext) {
  const [sub, balance] = await Promise.all([
    auth.plan
      ? env.DB.prepare(
          `SELECT plan, interval, status, current_period_end, cancel_at_period_end, seats FROM subscriptions
           WHERE workspace_id = ?1 AND status IN ('active','trialing') AND current_period_end > ?2
           ORDER BY current_period_end DESC LIMIT 1`,
        )
          .bind(auth.workspaceId, Date.now())
          .first<SubscriptionRow>()
      : Promise.resolve(null),
    readBalance(env, auth.workspaceId),
  ]);
  return {
    user: auth.user ?? { id: auth.userId, email: null, name: "", image: null, emailVerified: false },
    workspace: auth.workspace,
    role: auth.role,
    monthlyCreditLimit: auth.monthlyCreditLimit,
    workspaces: auth.memberships.map((m) => ({ id: m.workspaceId, name: m.name, kind: m.kind, role: m.role, plan: m.plan })),
    prefs: auth.prefs,
    plan: planView(sub ?? null),
    isMember: auth.isMember,
    matureAllowed: auth.matureAllowed,
    balance,
  };
}

async function savePrefs(env: Env, userId: string, prefs: Prefs): Promise<void> {
  await env.DB.prepare(
    `UPDATE user_prefs SET language = ?2, currency = ?3, creation_mode = ?4, default_ratio = ?5, default_model = ?6,
       confirm_threshold = ?7, notifications = ?8, theme = ?9, mature_content = ?10, updated_at = ?11
     WHERE user_id = ?1`,
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
      prefs.theme,
      prefs.matureContent ? 1 : 0,
      Date.now(),
    )
    .run();
}

export const me = new Hono<AppEnv>()
  .get("/", async (c) => {
    const auth = requireUser(c);
    c.header("cache-control", "private, no-store");
    return c.json(await mePayload(c.env, auth));
  })
  .patch("/prefs", validate("json", PrefsPatch), async (c) => {
    const auth = requireUser(c);
    const patch = c.req.valid("json");
    // D-005: turning mature content on needs an active plan (payment is the age gate).
    if (patch.matureContent === true && !auth.isMember) {
      throw new ApiError(402, "NO_PLAN", "Mature content needs an active plan", { workspaceId: auth.workspaceId });
    }
    const prefs = applyPrefsPatch(auth.prefs, patch);
    await savePrefs(c.env, auth.userId, prefs);
    const hub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(auth.userId));
    // Other tabs update at once; a failed push is not a failed save.
    c.executionCtx.waitUntil(
      hub.broadcast("prefs.changed", { prefs }).catch((err: unknown) => {
        console.warn(JSON.stringify({ msg: "prefs.changed push failed", error: String(err) }));
      }),
    );
    return c.json({ prefs, matureAllowed: auth.isMember && prefs.matureContent && auth.workspace.matureAllowed });
  });
