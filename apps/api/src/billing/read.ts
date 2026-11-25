/** Billing reads shared by REST (`/api/billing`) and GraphQL (`billing`, `ledger`). */
import type { AutoTopUpSettings, Balance } from "@rolling/core/credits";
import { ApiError } from "../lib/errors";
import { creditAccount } from "./credits";
import type { PlanId } from "@rolling/core/pricing/config";
import { isLive, latestSubscription, seatsInUse } from "./stripe";

export interface BillingSummary {
  plan: PlanId | null;
  interval: "month" | "year" | null;
  /** Stripe subscription status (`active`, `trialing`, `past_due`, `canceled`, …) or null without a subscription. */
  status: string | null;
  /** Next renewal (epoch ms); null when the plan ends at period end or there is none. */
  renewsAt: number | null;
  cancelAtPeriodEnd: boolean;
  /** End of the current period (epoch ms). */
  periodEnd: number | null;
  balance: Balance;
  autoTopUp: AutoTopUpSettings | null;
  /** Team (D-013): purchased seats and seats in use (members + pending invites); null on personal plans or without a plan. */
  seats: { purchased: number; used: number } | null;
  /** Start of the current period (epoch ms), for the prorated seat estimate. */
  periodStart: number | null;
}

export async function billingSummary(env: Env, workspaceId: string): Promise<BillingSummary> {
  const [sub, account] = await Promise.all([latestSubscription(env, workspaceId), creditAccount(env, workspaceId).summary()]);
  const live = isLive(sub);
  const team = live && sub.plan === "team";
  const used = team ? (await seatsInUse(env.DB, workspaceId)).used : 0;
  return {
    plan: live ? sub.plan : null,
    interval: live ? sub.interval : null,
    status: sub?.status ?? null,
    renewsAt: live && !sub.cancel_at_period_end ? sub.current_period_end : null,
    cancelAtPeriodEnd: !!sub?.cancel_at_period_end,
    periodEnd: sub?.current_period_end ?? null,
    balance: account.balance,
    autoTopUp: account.autoTopUp,
    seats: team ? { purchased: Math.max(1, sub.seats ?? 1), used } : null,
    periodStart: sub?.current_period_start ?? null,
  };
}

export interface LedgerLineView {
  id: string;
  kind: string;
  bucket: string;
  amount: number;
  userId: string | null;
  runId: string | null;
  jobId: string | null;
  stripeRef: string | null;
  note: string | null;
  createdAt: number;
}

export interface LedgerPage {
  lines: LedgerLineView[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

export function encodeLedgerCursor(createdAt: number, id: string): string {
  return btoa(`${createdAt}:${id}`).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeCursor(cursor: string): { createdAt: number; id: string } {
  try {
    const raw = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const i = raw.indexOf(":");
    const createdAt = Number(raw.slice(0, i));
    if (i <= 0 || !Number.isInteger(createdAt)) throw new Error("bad cursor");
    return { createdAt, id: raw.slice(i + 1) };
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Invalid cursor");
  }
}

/** Mirrored ledger lines of a workspace, newest first (D1 `ledger_lines`; eventually consistent with the DO). */
export async function listLedger(env: Env, workspaceId: string, first: number, after: string | null): Promise<LedgerPage> {
  const c = after ? decodeCursor(after) : null;
  const sql = `SELECT id, kind, bucket, amount, user_id, run_id, job_id, stripe_ref, note, created_at FROM ledger_lines
     WHERE workspace_id = ?1 ${c ? "AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))" : ""}
     ORDER BY created_at DESC, id DESC LIMIT ${first + 1}`;
  const stmt = c ? env.DB.prepare(sql).bind(workspaceId, c.createdAt, c.id) : env.DB.prepare(sql).bind(workspaceId);
  const { results } = await stmt.all<{
    id: string;
    kind: string;
    bucket: string;
    amount: number;
    user_id: string | null;
    run_id: string | null;
    job_id: string | null;
    stripe_ref: string | null;
    note: string | null;
    created_at: number;
  }>();
  const page = results.slice(0, first);
  const last = page[page.length - 1];
  return {
    lines: page.map((r) => ({
      id: r.id,
      kind: r.kind,
      bucket: r.bucket,
      amount: r.amount,
      userId: r.user_id,
      runId: r.run_id,
      jobId: r.job_id,
      stripeRef: r.stripe_ref,
      note: r.note,
      createdAt: r.created_at,
    })),
    pageInfo: { hasNextPage: results.length > first, endCursor: last ? encodeLedgerCursor(last.created_at, last.id) : null },
  };
}
