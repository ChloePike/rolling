/**
 * Account deletion (Better Auth `delete-user`, gated by an emailed 6-digit code).
 *
 * Flow: `POST /api/me/delete/send-code` checks the account can be deleted and
 * emails a code; `POST /api/me/delete { code }` verifies it and calls Better
 * Auth's `deleteUser` with a one-time token, whose `beforeDelete` hook runs
 * `purgeAccount`:
 *
 * - owned workspaces: a Team workspace with other members and no other owner
 *   refuses with `409 OWNER_OF_TEAM` (transfer ownership first); one with
 *   another owner is simply left; every other owned workspace is soft-deleted
 *   (`deleted_at`, members, invites, projects, assets, characters, voices,
 *   share links removed) after its live Stripe subscription is set to cancel
 *   at period end, and its R2 prefix is queued for cleanup (`r2_cleanup`);
 * - memberships elsewhere are removed; assets, share links, templates,
 *   characters and feedback lose the user id; retained records (credit ledger
 *   mirror, safety log, agent usage, run/job/export/project authorship) carry
 *   the user's tombstone instead (`@rolling/core/privacy`);
 * - the user's agent threads (anywhere) are removed;
 * - Durable Object storage is wiped or pseudonymised in the background by
 *   `AccountDeletionWorkflow` (`deletionJob.ts`): ProjectRooms and
 *   AgentSessions of closed workspaces, the user's own threads, the UserHub,
 *   and the CreditAccount ledgers (kept, pseudonymised);
 * - prefs and avatar go; Better Auth then deletes the user, its accounts and
 *   every session, and clears the cookie.
 *
 * Everything here is idempotent: running `purgeAccount` again for the same
 * user changes nothing more and restarts the background job if needed.
 */
import { ApiError } from "../lib/errors";
import { isLive, latestSubscription, stripeConfigured, stripeFor } from "../billing/stripe";
import { revokeShares } from "../lib/share";
import { sha256Hex } from "./rateLimit";
import { personalWorkspaceId } from "./workspace";
import { createDeletionJob, pseudonymizeD1, startDeletionWorkflow } from "./deletionJob";

export const DELETE_CODE_TTL_SECONDS = 600;
export const DELETE_CODE_ATTEMPTS = 5;
const CODE_PREFIX = "delete-account-code:";

interface OwnedRow {
  workspace_id: string;
  kind: "personal" | "team";
  name: string;
  others: number;
  other_owners: number;
}

export interface DeletionPlan {
  /** Workspaces that will be soft-deleted. */
  remove: string[];
  /** Workspaces the user just leaves (another owner remains, or the user is not an owner). */
  leave: string[];
}

/** What deleting the account does to each workspace; throws OWNER_OF_TEAM when a Team must be transferred first. */
export async function deletionPlan(env: Env, userId: string): Promise<DeletionPlan> {
  const { results } = await env.DB.prepare(
    `SELECT m.workspace_id, w.kind, w.name,
       (SELECT COUNT(*) FROM workspace_members o WHERE o.workspace_id = m.workspace_id AND o.user_id <> m.user_id) AS others,
       (SELECT COUNT(*) FROM workspace_members o WHERE o.workspace_id = m.workspace_id AND o.user_id <> m.user_id AND o.role = 'owner') AS other_owners
     FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ?1 AND m.role = 'owner' AND w.deleted_at IS NULL`,
  )
    .bind(userId)
    .all<OwnedRow>();
  const blocking = results.filter((r) => r.kind === "team" && r.others > 0 && r.other_owners === 0);
  if (blocking.length) {
    throw new ApiError(409, "OWNER_OF_TEAM", "Transfer ownership of your team workspace before deleting your account", {
      workspaces: blocking.map((r) => ({ id: r.workspace_id, name: r.name, members: r.others + 1 })),
    });
  }
  const remove = results.filter((r) => r.other_owners === 0).map((r) => r.workspace_id);
  const all = await env.DB.prepare("SELECT workspace_id FROM workspace_members WHERE user_id = ?").bind(userId).all<{ workspace_id: string }>();
  return { remove, leave: all.results.map((r) => r.workspace_id).filter((id) => !remove.includes(id)) };
}

// ---------------------------------------------------------------- confirmation code

function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return n.toString().padStart(6, "0");
}

/** Stores a fresh code for `userId` (replacing any earlier one) and returns it. */
export async function issueDeleteCode(env: Env, userId: string, now = Date.now()): Promise<string> {
  const code = randomCode();
  const id = `${CODE_PREFIX}${userId}`;
  const iso = new Date(now).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM verifications WHERE identifier = ?").bind(id),
    env.DB.prepare("INSERT INTO verifications (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
      `vrf_del_${crypto.randomUUID()}`,
      id,
      `${await sha256Hex(`${userId}:${code}`)}:0`,
      new Date(now + DELETE_CODE_TTL_SECONDS * 1000).toISOString(),
      iso,
      iso,
    ),
  ]);
  return code;
}

/** Verifies (and consumes) the code: INVALID_CODE, CODE_EXPIRED, TOO_MANY_ATTEMPTS. */
export async function verifyDeleteCode(env: Env, userId: string, code: string, now = Date.now()): Promise<void> {
  const id = `${CODE_PREFIX}${userId}`;
  const row = await env.DB.prepare("SELECT id, value, expires_at FROM verifications WHERE identifier = ?").bind(id).first<{ id: string; value: string; expires_at: string }>();
  if (!row) throw new ApiError(400, "INVALID_CODE", "That code isn't right. Ask for a new one.");
  if (Date.parse(row.expires_at) <= now) {
    await env.DB.prepare("DELETE FROM verifications WHERE id = ?").bind(row.id).run();
    throw new ApiError(400, "CODE_EXPIRED", "That code has expired. Ask for a new one.");
  }
  const sep = row.value.lastIndexOf(":");
  const hash = row.value.slice(0, sep);
  const attempts = Number(row.value.slice(sep + 1)) || 0;
  if (attempts >= DELETE_CODE_ATTEMPTS) throw new ApiError(429, "TOO_MANY_ATTEMPTS", "Too many wrong codes. Ask for a new one.");
  if (hash !== (await sha256Hex(`${userId}:${code}`))) {
    // Conditional update: concurrent guesses cannot share one attempt.
    await env.DB.prepare("UPDATE verifications SET value = ? WHERE id = ? AND value = ?").bind(`${hash}:${attempts + 1}`, row.id, row.value).run();
    throw new ApiError(400, "INVALID_CODE", "That code isn't right.", { attemptsLeft: Math.max(0, DELETE_CODE_ATTEMPTS - attempts - 1) });
  }
  const used = await env.DB.prepare("DELETE FROM verifications WHERE id = ? AND value = ?").bind(row.id, row.value).run();
  if (!used.meta.changes) throw new ApiError(400, "INVALID_CODE", "That code isn't right. Ask for a new one.");
}

/** A one-time Better Auth delete token (`delete-account-<token>` → user id), valid 5 minutes. */
export async function deleteToken(env: Env, userId: string, now = Date.now()): Promise<string> {
  const token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const iso = new Date(now).toISOString();
  await env.DB.prepare("INSERT INTO verifications (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(`vrf_deltok_${crypto.randomUUID()}`, `delete-account-${token}`, userId, new Date(now + 300_000).toISOString(), iso, iso)
    .run();
  return token;
}

// ---------------------------------------------------------------- purge

/** Sets live Stripe subscriptions of `workspaceId` to cancel at period end (idempotent). */
async function cancelSubscription(env: Env, workspaceId: string, userId: string): Promise<void> {
  const sub = await latestSubscription(env, workspaceId);
  if (!isLive(sub) || sub.cancel_at_period_end) return;
  if (!stripeConfigured(env)) {
    // Local dev / staging without Stripe: record the intent so the plan does not renew.
    await env.DB.prepare("UPDATE subscriptions SET cancel_at_period_end = 1, updated_at = ? WHERE id = ?").bind(Date.now(), sub.id).run();
    return;
  }
  try {
    await stripeFor(env).updateSubscription(sub.id, { cancel_at_period_end: true, "metadata[canceledBy]": "account_deletion", "metadata[deletedUserId]": userId }, `account-delete:${sub.id}`);
  } catch (err) {
    console.error(JSON.stringify({ msg: "account delete: stripe cancel failed", workspaceId, error: String(err).slice(0, 300) }));
    throw new ApiError(502, "INTERNAL", "We couldn't cancel your subscription. Try again in a minute; nothing was deleted.");
  }
  await env.DB.prepare("UPDATE subscriptions SET cancel_at_period_end = 1, updated_at = ? WHERE id = ?").bind(Date.now(), sub.id).run();
}

async function removeWorkspace(env: Env, workspaceId: string, now: number): Promise<void> {
  const projects = await env.DB.prepare("SELECT id FROM projects WHERE workspace_id = ?").bind(workspaceId).all<{ id: string }>();
  for (const p of projects.results) await revokeShares(env, p.id);
  const db = env.DB;
  await db.batch([
    db.prepare("UPDATE workspaces SET deleted_at = ? WHERE id = ?").bind(now, workspaceId),
    db.prepare("DELETE FROM workspace_members WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("UPDATE workspace_invites SET revoked_at = ? WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL").bind(now, workspaceId),
    db.prepare("DELETE FROM asset_search WHERE id IN (SELECT id FROM assets WHERE workspace_id = ?)").bind(workspaceId),
    db.prepare("DELETE FROM assets WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM uploads WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM characters WHERE workspace_id = ?").bind(workspaceId),
    // D-032: sheet index, consistency checks and "used in" rows of the workspace's characters.
    db.prepare("DELETE FROM character_sheet_assets WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM character_checks WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM character_uses WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM voices WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM templates WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM agent_proposals WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM agent_threads WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM exports WHERE workspace_id = ?").bind(workspaceId),
    // Run history stays for billing; the prompts in it go.
    db.prepare("UPDATE runs SET request = NULL WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("DELETE FROM projects WHERE workspace_id = ?").bind(workspaceId),
    // Private media of the workspace: deleted in the background by the sweep cron.
    db.prepare("INSERT OR IGNORE INTO r2_cleanup (prefix, reason, created_at) VALUES (?, 'account_deleted', ?)").bind(`ws/${workspaceId}/`, now),
  ]);
}

/** `beforeDelete` hook: everything except the Better Auth rows (user, accounts, sessions). */
export async function purgeAccount(env: Env, userId: string, now = Date.now()): Promise<DeletionPlan> {
  const plan = await deletionPlan(env, userId);
  for (const ws of plan.remove) await cancelSubscription(env, ws, userId);
  // Durable Objects to wipe are listed before their D1 index rows go.
  const job = await createDeletionJob(env, userId, plan, now);
  for (const ws of plan.remove) await removeWorkspace(env, ws, now);
  const prefs = await env.DB.prepare("SELECT avatar_key FROM user_prefs WHERE user_id = ?").bind(userId).first<{ avatar_key: string | null }>();
  await pseudonymizeD1(env, userId, job.tombstone);
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM workspace_members WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM agent_proposals WHERE thread_id IN (SELECT id FROM agent_threads WHERE created_by = ?)").bind(userId),
    db.prepare("DELETE FROM agent_threads WHERE created_by = ?").bind(userId),
    db.prepare("DELETE FROM data_exports WHERE user_id = ?").bind(userId),
    db.prepare("UPDATE assets SET created_by = NULL WHERE created_by = ?").bind(userId),
    // Links in workspaces that stay keep working but leave the deleted user's profile.
    db.prepare("UPDATE share_links SET created_by = NULL, show_on_profile = 0 WHERE created_by = ?").bind(userId),
    db.prepare("UPDATE templates SET created_by = NULL WHERE created_by = ?").bind(userId),
    db.prepare("UPDATE characters SET created_by = NULL WHERE created_by = ?").bind(userId),
    db.prepare("UPDATE feedback SET user_id = NULL WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM user_prefs WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM verifications WHERE identifier = ?").bind(`${CODE_PREFIX}${userId}`),
  ]);
  if (prefs?.avatar_key && !plan.remove.includes(personalWorkspaceId(userId))) await env.MEDIA.delete(prefs.avatar_key).catch(() => undefined);
  // Durable Object storage: background job (restarted by the daily cron if this start fails).
  await startDeletionWorkflow(env, job, now);
  console.log(JSON.stringify({ msg: "account deleted", deletionId: job.id, removed: plan.remove.length, left: plan.leave.length }));
  return plan;
}

// ---------------------------------------------------------------- R2 cleanup (sweep cron)

/** Deletes up to `budget` objects from queued prefixes; marks a prefix done once it is empty. */
export async function runR2Cleanup(env: Env, budget = 2000): Promise<number> {
  const { results } = await env.DB.prepare("SELECT prefix FROM r2_cleanup WHERE done_at IS NULL ORDER BY created_at LIMIT 5").all<{ prefix: string }>();
  let deleted = 0;
  for (const { prefix } of results) {
    // Never sweep outside a workspace prefix.
    if (!/^ws\/[A-Za-z0-9_-]+\/$/.test(prefix)) {
      await env.DB.prepare("UPDATE r2_cleanup SET done_at = ? WHERE prefix = ?").bind(Date.now(), prefix).run();
      continue;
    }
    for (;;) {
      if (deleted >= budget) return deleted;
      const list = await env.MEDIA.list({ prefix, limit: Math.min(1000, budget - deleted) });
      if (list.objects.length) {
        await env.MEDIA.delete(list.objects.map((o) => o.key));
        deleted += list.objects.length;
      }
      if (!list.truncated) {
        await env.DB.prepare("UPDATE r2_cleanup SET done_at = ? WHERE prefix = ?").bind(Date.now(), prefix).run();
        break;
      }
    }
  }
  return deleted;
}
