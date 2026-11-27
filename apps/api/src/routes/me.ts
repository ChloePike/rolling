/**
 * Account (M1): `GET /api/me`, `PATCH /api/me/prefs`, `PATCH /api/me/profile`,
 * and account deletion (`POST /api/me/delete/send-code`, `POST /api/me/delete`).
 */
import { Hono } from "hono";
import { z } from "zod";
import { applyPrefsPatch, PrefsPatch, type Prefs } from "@rolling/core/auth/prefs";
import { ProfilePatch } from "@rolling/core/auth/profile";
import { getAuth } from "../auth/betterAuth";
import { deletionPlan, deleteToken, DELETE_CODE_TTL_SECONDS, issueDeleteCode, verifyDeleteCode } from "../auth/deleteAccount";
import { enqueueEmail } from "../auth/email";
import { readProfileRow, updateProfile } from "../auth/profile";
import { clientIp, limitOrThrow, sha256Hex } from "../auth/rateLimit";
import { PLANS, planConcurrentJobs, planMonthlyCredits, type PlanId } from "@rolling/core/pricing/config";
import type { AppEnv } from "../env";
import { requireUser, type AuthContext } from "../auth/context";
import { ApiError } from "../lib/errors";
import { validate } from "../lib/validate";
import { trialView } from "../auth/trial";

export interface BalanceView {
  plan: number;
  purchased: number;
  held: number;
  planExpiresAt: number | null;
}

const ZERO_BALANCE: BalanceView = { plan: 0, purchased: 0, held: 0, planExpiresAt: null };

/** CreditAccount (billing agent) `balance()` RPC when available; zeros otherwise. `trial`: trial credits left (D-022), kept out of `balance`. */
async function readBalance(env: Env, workspaceId: string): Promise<BalanceView & { trial?: number }> {
  try {
    const stub = env.CREDITS.get(env.CREDITS.idFromName(workspaceId)) as unknown as { balance?: () => Promise<Partial<BalanceView>> };
    if (typeof stub.balance !== "function") return ZERO_BALANCE;
    const b = await stub.balance();
    return {
      plan: Number(b?.plan ?? 0),
      purchased: Number(b?.purchased ?? 0),
      held: Number(b?.held ?? 0),
      planExpiresAt: typeof b?.planExpiresAt === "number" ? b.planExpiresAt : null,
      ...(typeof (b as { trial?: unknown })?.trial === "number" && { trial: (b as { trial: number }).trial }),
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
  const [sub, balance, profile] = await Promise.all([
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
    readProfileRow(env, auth.userId).catch(() => null),
  ]);
  const user = auth.user ?? { id: auth.userId, email: null, name: "", image: null, emailVerified: false };
  return {
    // `handle` (null until chosen) and `bio` (null when empty) for the public profile `/u/:handle`.
    user: { ...user, handle: profile?.handle ?? null, bio: profile?.bio ?? null },
    workspace: auth.workspace,
    role: auth.role,
    monthlyCreditLimit: auth.monthlyCreditLimit,
    workspaces: auth.memberships.map((m) => ({ id: m.workspaceId, name: m.name, kind: m.kind, role: m.role, plan: m.plan })),
    prefs: auth.prefs,
    plan: planView(sub ?? null),
    isMember: auth.isMember,
    matureAllowed: auth.matureAllowed,
    balance: { plan: balance.plan, purchased: balance.purchased, held: balance.held, planExpiresAt: balance.planExpiresAt },
    // D-022: the one-time trial (null when the workspace never had one).
    trial: await trialView(env, auth.workspaceId, balance).catch(() => null),
  };
}

async function savePrefs(env: Env, userId: string, prefs: Prefs): Promise<void> {
  await env.DB.prepare(
    `UPDATE user_prefs SET language = ?2, currency = ?3, creation_mode = ?4, default_ratio = ?5, default_model = ?6,
       confirm_threshold = ?7, notifications = ?8, theme = ?9, mature_content = ?10, updated_at = ?11, enhance_prompt = ?12,
       agent_mode = ?13, auto_budget = ?14
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
      prefs.enhancePrompt ? 1 : 0,
      prefs.agentMode,
      prefs.autoBudget,
    )
    .run();
  // D-024 "Review results" (migration 0032).
  await env.DB.prepare("UPDATE user_prefs SET review_results = ?2 WHERE user_id = ?1").bind(userId, prefs.reviewResults ? 1 : 0).run();
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
  })
  /** Name, handle, bio and avatar (`avatarAssetId`: the caller's uploaded image, rated safe; null removes it). */
  .patch("/profile", validate("json", ProfilePatch), async (c) => {
    const auth = requireUser(c);
    if (!auth.user) throw new ApiError(401, "UNAUTHENTICATED", "Sign in required");
    await limitOrThrow(c.env.RATE_LIMIT, `profile:${auth.userId}`);
    const profile = await updateProfile(c.env, auth, c.req.valid("json"));
    return c.json({ profile });
  })
  /**
   * Account deletion, step 1: checks the account can go (OWNER_OF_TEAM) and
   * emails a 6-digit code to the account's address (30 s resend cooldown).
   */
  .post("/delete/send-code", async (c) => {
    const auth = requireUser(c);
    if (!auth.user?.email) throw new ApiError(401, "UNAUTHENTICATED", "Sign in required");
    await limitOrThrow(c.env.AUTH_RATE_LIMIT, `delete-code:${auth.userId}:${clientIp(c.req.raw)}`, "Too many codes requested. Try again in a minute.");
    const plan = await deletionPlan(c.env, auth.userId);
    const now = Date.now();
    const key = await sha256Hex(`delete:${auth.userId}`);
    const reserved = await c.env.DB.prepare(
      `INSERT INTO auth_email_sends (email, last_sent_at) VALUES (?1, ?2)
       ON CONFLICT (email) DO UPDATE SET last_sent_at = excluded.last_sent_at WHERE auth_email_sends.last_sent_at <= ?3 RETURNING last_sent_at`,
    )
      .bind(key, now, now - 30_000)
      .first();
    if (!reserved) throw new ApiError(429, "RATE_LIMITED", "Wait a moment before asking for another code", { retryAfter: 30 });
    const code = await issueDeleteCode(c.env, auth.userId, now);
    await enqueueEmail(c.env, { to: auth.user.email, template: "delete-account-code", data: { code, expiresInMinutes: DELETE_CODE_TTL_SECONDS / 60 } });
    return c.json({ sent: true, email: auth.user.email, expiresInMinutes: DELETE_CODE_TTL_SECONDS / 60, workspacesToDelete: plan.remove.length });
  })
  /** Account deletion, step 2: `{ code }` → the account is deleted, the session cookie cleared. */
  .post("/delete", validate("json", z.object({ code: z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits") }).strict()), async (c) => {
    const auth = requireUser(c);
    if (!auth.user || !auth.sessionId) throw new ApiError(401, "UNAUTHENTICATED", "Sign in required");
    await limitOrThrow(c.env.AUTH_RATE_LIMIT, `delete-verify:${auth.userId}:${clientIp(c.req.raw)}`, "Too many attempts. Try again in a minute.");
    // Refuse before spending the code when a Team still needs a new owner.
    await deletionPlan(c.env, auth.userId);
    await verifyDeleteCode(c.env, auth.userId, c.req.valid("json").code);
    const token = await deleteToken(c.env, auth.userId);
    const betterAuth = await getAuth(c.env);
    // Runs `beforeDelete` (purgeAccount), deletes the user, accounts and sessions, expires the cookie.
    const { headers } = await betterAuth.api.deleteUser({ body: { token }, headers: c.req.raw.headers, returnHeaders: true });
    const out = c.json({ ok: true });
    for (const v of headers.getSetCookie()) out.headers.append("set-cookie", v);
    c.set("authSetCookies", []);
    return out;
  });
