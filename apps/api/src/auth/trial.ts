/**
 * The one-time sign-up trial (D-022): who gets it and what it unlocks.
 *
 * Grant flow (Better Auth hooks, `betterAuth.ts`):
 * 1. `user.create.after` → `markTrialPending`: a `pending` claim for every user
 *    created from now on. Users created before the trial shipped never have a
 *    row, so nothing is granted retroactively (admins use `POST /api/admin/trial`).
 * 2. `session.create.after` → `claimTrial`: the first session of a pending user
 *    (email code verified, or Google with a verified email) runs the anti-abuse
 *    checks and either grants the trial through CreditAccount or denies it. A
 *    claim is decided once; later sessions do nothing.
 *
 * Anti-abuse (all SHA-256 hashed): verified email only, no disposable domains,
 * one trial per normalized email and per Google account, per-IP and per-/24
 * (IPv6 /64) limits over a rolling day, one trial per device id (soft: a
 * cookie plus localStorage on the client). The partial unique indexes of
 * migration 0028 settle races on email, Google account and workspace.
 */
import type { Context } from "hono";
import { deviceIdFromCookie, ipSubnet, normalizeEmail, precheckTrial, type TrialDenial } from "@rolling/core/auth/trial";
import { TRIAL } from "@rolling/core/pricing/config";
import { trialGrant, type TrialStatus } from "@rolling/core/pricing/trial";
import { defaultTurnEstimates } from "@rolling/agent";
import { turnsLeft } from "@rolling/core";
import { chatModelsOf, type AllowanceModelView, type AllowanceView } from "../agent/allowance";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/errors";
import { creditAccount, unwrapLedger } from "../billing/credits";
import { requireMember, requireUser, type AuthContext } from "./context";
import { sha256Hex } from "./rateLimit";
import { personalWorkspaceId } from "./workspace";

const DAY_MS = 86_400_000;

export type TrialMethod = "email" | "google" | "admin";

export interface TrialClaimRow {
  user_id: string;
  workspace_id: string;
  status: "pending" | "granted" | "denied";
  reason: string | null;
  method: string | null;
  credits: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

/** What the request that created the session tells us (headers of the sign-in request). */
export interface TrialRequestInfo {
  ip: string | null;
  cookie: string | null;
}

export function trialRequestInfo(headers: Headers | null | undefined): TrialRequestInfo {
  return { ip: headers?.get("cf-connecting-ip") ?? null, cookie: headers?.get("cookie") ?? null };
}

const hash = (kind: string, value: string) => sha256Hex(`trial:${kind}:${value}`);

/** Step 1 (user hook): a pending claim for a brand-new user. Idempotent. */
export async function markTrialPending(env: Env, userId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare("INSERT OR IGNORE INTO trial_claims (user_id, workspace_id, status, created_at, updated_at) VALUES (?1, ?2, 'pending', ?3, ?3)")
    .bind(userId, personalWorkspaceId(userId), now)
    .run();
}

async function deny(env: Env, userId: string, reason: TrialDenial, signals: Partial<Record<"email_hash" | "google_hash" | "ip_hash" | "subnet_hash" | "device_hash", string | null>>, method: TrialMethod): Promise<"denied"> {
  await env.DB.prepare(
    `UPDATE trial_claims SET status = 'denied', reason = ?2, method = ?3, email_hash = ?4, google_hash = ?5, ip_hash = ?6, subnet_hash = ?7, device_hash = ?8, updated_at = ?9
     WHERE user_id = ?1 AND status = 'pending'`,
  )
    .bind(userId, reason, method, signals.email_hash ?? null, signals.google_hash ?? null, signals.ip_hash ?? null, signals.subnet_hash ?? null, signals.device_hash ?? null, Date.now())
    .run();
  console.log(JSON.stringify({ msg: "trial: denied", userId, reason }));
  return "denied";
}

/**
 * Step 2 (session hook): decides a pending claim. Returns the outcome, or
 * `none` when the user has no pending claim (existing users, decided claims).
 */
export async function claimTrial(env: Env, userId: string, info: TrialRequestInfo, now = Date.now()): Promise<"granted" | "denied" | "none"> {
  const claim = await env.DB.prepare("SELECT * FROM trial_claims WHERE user_id = ?1").bind(userId).first<TrialClaimRow>();
  if (!claim || claim.status !== "pending") return "none";
  const [user, google] = await env.DB.batch<unknown>([
    env.DB.prepare("SELECT email, email_verified FROM users WHERE id = ?1").bind(userId),
    env.DB.prepare("SELECT account_id FROM accounts WHERE user_id = ?1 AND provider_id = 'google' ORDER BY created_at LIMIT 1").bind(userId),
  ]);
  const u = (user?.results?.[0] ?? null) as { email: string | null; email_verified: number | boolean } | null;
  if (!u) return "none";
  const sub = ((google?.results?.[0] ?? null) as { account_id: string } | null)?.account_id ?? null;
  const method: TrialMethod = sub ? "google" : "email";
  const normalized = u.email ? normalizeEmail(u.email) : null;
  const subnet = info.ip ? ipSubnet(info.ip) : null;
  const device = deviceIdFromCookie(info.cookie);
  const signals = {
    email_hash: normalized ? await hash("email", normalized) : null,
    google_hash: sub ? await hash("google", sub) : null,
    ip_hash: info.ip ? await hash("ip", info.ip) : null,
    subnet_hash: subnet ? await hash("subnet", subnet) : null,
    device_hash: device ? await hash("device", device) : null,
  };

  const pre = precheckTrial({ emailVerified: Boolean(u.email_verified), email: u.email });
  if (pre) return deny(env, userId, pre, signals, method);

  const since = now - DAY_MS;
  const [byEmail, byGoogle, byDevice, byIp, bySubnet] = await env.DB.batch<{ n: number }>([
    env.DB.prepare("SELECT COUNT(*) AS n FROM trial_claims WHERE email_hash = ?1 AND status = 'granted'").bind(signals.email_hash),
    env.DB.prepare("SELECT COUNT(*) AS n FROM trial_claims WHERE google_hash = ?1 AND status = 'granted'").bind(signals.google_hash),
    env.DB.prepare("SELECT COUNT(*) AS n FROM trial_claims WHERE device_hash = ?1 AND status = 'granted'").bind(signals.device_hash),
    env.DB.prepare("SELECT COUNT(*) AS n FROM trial_claims WHERE ip_hash = ?1 AND status = 'granted' AND updated_at >= ?2").bind(signals.ip_hash, since),
    env.DB.prepare("SELECT COUNT(*) AS n FROM trial_claims WHERE subnet_hash = ?1 AND status = 'granted' AND updated_at >= ?2").bind(signals.subnet_hash, since),
  ]);
  const count = (r: D1Result<{ n: number }> | undefined) => Number(r?.results?.[0]?.n ?? 0);
  if (count(byEmail) > 0) return deny(env, userId, "email_used", signals, method);
  if (signals.google_hash && count(byGoogle) > 0) return deny(env, userId, "google_used", signals, method);
  if (signals.device_hash && count(byDevice) > 0) return deny(env, userId, "device_used", signals, method);
  if (signals.ip_hash && count(byIp) >= TRIAL.perIpPerDay) return deny(env, userId, "ip_limit", signals, method);
  if (signals.subnet_hash && count(bySubnet) >= TRIAL.perSubnetPerDay) return deny(env, userId, "subnet_limit", signals, method);

  return grantClaim(env, claim, signals, method, now);
}

/** Marks the claim granted (unique indexes settle races), then grants the credits through CreditAccount. */
async function grantClaim(
  env: Env,
  claim: Pick<TrialClaimRow, "user_id" | "workspace_id">,
  signals: Record<"email_hash" | "google_hash" | "ip_hash" | "subnet_hash" | "device_hash", string | null>,
  method: TrialMethod,
  now: number,
): Promise<"granted" | "denied"> {
  const g = trialGrant(now);
  try {
    const r = await env.DB.prepare(
      `UPDATE trial_claims SET status = 'granted', reason = NULL, method = ?2, email_hash = ?3, google_hash = ?4, ip_hash = ?5, subnet_hash = ?6, device_hash = ?7,
         credits = ?8, expires_at = ?9, updated_at = ?10
       WHERE user_id = ?1 AND status = 'pending'`,
    )
      .bind(claim.user_id, method, signals.email_hash, signals.google_hash, signals.ip_hash, signals.subnet_hash, signals.device_hash, g.credits, g.expiresAt, now)
      .run();
    if (!r.meta.changes) return "denied";
  } catch (err) {
    // A concurrent sign-up with the same email or Google account won the unique index.
    if (/UNIQUE/i.test(String(err))) return deny(env, claim.user_id, signals.google_hash ? "google_used" : "email_used", signals, method);
    throw err;
  }
  try {
    unwrapLedger(await creditAccount(env, claim.workspace_id).grantTrial(g.credits, g.expiresAt, `trial:${claim.workspace_id}`));
  } catch (err) {
    // Back to pending so the next session retries; the DO grant is idempotent by key.
    await env.DB.prepare("UPDATE trial_claims SET status = 'pending', updated_at = ?2 WHERE user_id = ?1 AND status = 'granted'").bind(claim.user_id, Date.now()).run();
    throw err;
  }
  console.log(JSON.stringify({ msg: "trial: granted", userId: claim.user_id, workspaceId: claim.workspace_id, credits: g.credits, method }));
  return "granted";
}

/**
 * Admin grant for a user who signed up before the trial or was denied by a
 * soft check (D-022: no retroactive grants unless an admin grants them).
 * Still one per workspace; skips the anti-abuse checks.
 */
export async function adminGrantTrial(env: Env, userId: string, now = Date.now()): Promise<{ status: "granted" | "already"; workspaceId: string; expiresAt: number | null }> {
  const workspaceId = personalWorkspaceId(userId);
  const existing = await env.DB.prepare("SELECT status, expires_at FROM trial_claims WHERE user_id = ?1").bind(userId).first<{ status: string; expires_at: number | null }>();
  if (existing?.status === "granted") return { status: "already", workspaceId, expiresAt: existing.expires_at };
  await env.DB.prepare("INSERT OR IGNORE INTO trial_claims (user_id, workspace_id, status, created_at, updated_at) VALUES (?1, ?2, 'pending', ?3, ?3)").bind(userId, workspaceId, now).run();
  await env.DB.prepare("UPDATE trial_claims SET status = 'pending', updated_at = ?2 WHERE user_id = ?1 AND status = 'denied'").bind(userId, now).run();
  const out = await grantClaim(env, { user_id: userId, workspace_id: workspaceId }, { email_hash: null, google_hash: null, ip_hash: null, subnet_hash: null, device_hash: null }, "admin", now);
  if (out !== "granted") return { status: "already", workspaceId, expiresAt: null };
  return { status: "granted", workspaceId, expiresAt: trialGrant(now).expiresAt };
}

// ---------------------------------------------------------------------------
// What a trial unlocks
// ---------------------------------------------------------------------------

export interface TrialView {
  status: Exclude<TrialStatus, "none">;
  /** Credits granted at the start. */
  credits: number;
  /** Trial credits left now. */
  remaining: number;
  /** Epoch ms. */
  expiresAt: number;
  /** Agent allowance for the whole trial (USD of gateway cost, D-012 style) and what is used. */
  agentAllowanceUsd: number;
  agentUsedUsd: number;
}

/** The granted trial of a workspace, without balances (one D1 read). */
export async function grantedTrial(env: Env, workspaceId: string): Promise<{ credits: number; expiresAt: number; grantedAt: number } | null> {
  const row = await env.DB.prepare("SELECT credits, expires_at, updated_at FROM trial_claims WHERE workspace_id = ?1 AND status = 'granted' LIMIT 1")
    .bind(workspaceId)
    .first<{ credits: number; expires_at: number | null; updated_at: number }>();
  return row && row.expires_at !== null ? { credits: row.credits, expiresAt: row.expires_at, grantedAt: row.updated_at } : null;
}

/** USD of agent turns this workspace used since `since` (D1 `agent_usage`, every turn, metered or not). */
export async function agentUsedUsdSince(env: Env, workspaceId: string, since: number): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM agent_usage WHERE workspace_id = ?1 AND created_at >= ?2")
    .bind(workspaceId, since)
    .first<{ usd: number }>();
  return Math.round(Number(r?.usd ?? 0) * 1e6) / 1e6;
}

/** The trial state for `/api/me` and the header (null when the workspace never had one). */
export async function trialView(env: Env, workspaceId: string, balance: { trial?: number }, now = Date.now()): Promise<TrialView | null> {
  const t = await grantedTrial(env, workspaceId);
  if (!t) return null;
  const remaining = Math.max(0, Number(balance.trial ?? 0));
  const status: TrialView["status"] = now >= t.expiresAt ? "expired" : remaining > 0 ? "active" : "used";
  const agentUsedUsd = await agentUsedUsdSince(env, workspaceId, t.grantedAt);
  return { status, credits: t.credits, remaining: status === "expired" ? 0 : remaining, expiresAt: t.expiresAt, agentAllowanceUsd: TRIAL.agentAllowanceUsd, agentUsedUsd };
}

/**
 * Generating and the agent: members as before (`requireMember`, which also
 * refuses suspended callers), else an unexpired trial of this workspace.
 * Anything else is `402 NO_PLAN`, with `trial: 'expired'` once a trial ended
 * (the UI then opens the join paywall and keeps the brief). Whether trial
 * credits are left is the ledger's call at hold time.
 */
export async function requireGenerator(c: Context<AppEnv>): Promise<AuthContext & { trialUntil: number | null }> {
  try {
    return Object.assign(requireMember(c), { trialUntil: null });
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== "NO_PLAN") throw err;
    const auth = requireUser(c);
    const t = await grantedTrial(c.env, auth.workspaceId);
    if (t && Date.now() < t.expiresAt) return Object.assign(auth, { trialUntil: t.expiresAt });
    throw new ApiError(402, "NO_PLAN", "An active plan is required", { workspaceId: auth.workspaceId, ...(t && { trial: "expired" }) });
  }
}

/**
 * Agent turns on a trial (D-022): DeepSeek only, within the trial's agent
 * allowance. Members pass through. Returns the LLM the turn must use.
 */
export async function trialAgentTurn(c: Context<AppEnv>, auth: AuthContext & { trialUntil: number | null }, llm: string | undefined): Promise<string | undefined> {
  if (auth.trialUntil === null) return llm;
  if (llm && llm !== TRIAL.agentLlm) {
    throw new ApiError(402, "NO_PLAN", "Other agent models need a plan", { workspaceId: auth.workspaceId, trial: "active", feature: "agent_model", llm });
  }
  const t = await grantedTrial(c.env, auth.workspaceId);
  const used = t ? await agentUsedUsdSince(c.env, auth.workspaceId, t.grantedAt) : TRIAL.agentAllowanceUsd;
  if (used >= TRIAL.agentAllowanceUsd) {
    throw new ApiError(402, "NO_PLAN", "The trial’s agent allowance is used up", { workspaceId: auth.workspaceId, trial: "agent_used", allowanceUsd: TRIAL.agentAllowanceUsd, usedUsd: used });
  }
  return TRIAL.agentLlm;
}

/**
 * `GET /api/agent/allowance` for a trial (D-022): the trial's own allowance,
 * DeepSeek only, metered (unlike members' unmetered DeepSeek), until the trial ends.
 */
export async function trialAllowanceView(env: Env, workspaceId: string, trialUntil: number): Promise<AllowanceView & { trial: true }> {
  const chat = await chatModelsOf(env);
  const est = defaultTurnEstimates(chat, { mature: false }).find((d) => d.id === TRIAL.agentLlm);
  const t = await grantedTrial(env, workspaceId);
  const usedUsd = t ? await agentUsedUsdSince(env, workspaceId, t.grantedAt) : TRIAL.agentAllowanceUsd;
  const models: AllowanceModelView[] = est
    ? [{ id: est.id, name: est.name, unlimited: false, estTurnUsd: Math.round(est.fallbackUsd * 1e6) / 1e6, turnsLeft: turnsLeft(TRIAL.agentAllowanceUsd, usedUsd, est.fallbackUsd) }]
    : [];
  return { plan: null, allowanceUsd: TRIAL.agentAllowanceUsd, usedUsd, resetsAt: trialUntil, models, trial: true };
}
