/**
 * Workspace members and invites (M1) for the current workspace (the
 * `x-workspace-id` header, default personal). Only Team workspaces invite
 * (D-013): seats are purchased on the Team subscription; members (owner
 * included) and pending invites each use one.
 */
import { Hono } from "hono";
import { z } from "zod";
import { INVITE_ROLES, ROLES } from "@rolling/core/auth/roles";
import { newId } from "@rolling/core/ids";
import type { AppEnv } from "../env";
import { requireRole, requireUser, type AuthContext } from "../auth/context";
import { authBaseUrl } from "../auth/betterAuth";
import { enqueueEmail } from "../auth/email";
import { personalWorkspaceId, WORKSPACE_NAME_MAX } from "../auth/workspace";
import { limitOrThrow, sha256Hex } from "../auth/rateLimit";
import { ApiError } from "../lib/errors";
import { isLive, latestSubscription, seatsInUse } from "../billing/stripe";
import { validate } from "../lib/validate";

export const INVITE_TTL_DAYS = 7;
const DAY_MS = 86_400_000;

const CreditLimit = z.number().int().min(0).max(100_000_000).nullable();
const InviteBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    role: z.enum(INVITE_ROLES),
    /** Applied to the member when the invite is accepted; null/absent = no limit. */
    monthlyCreditLimit: CreditLimit.optional(),
  })
  .strict();
const AcceptBody = z.object({ token: z.string().min(20).max(200) }).strict();
const TokenQuery = z.object({ token: z.string().min(20).max(200) });
const MemberParam = z.object({ id: z.string().min(1).max(80) });
const InviteParam = z.object({ id: z.string().regex(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/) });
const MemberPatch = z
  .object({
    role: z.enum(ROLES),
    /** Credits per calendar month this member may spend from the shared pool; null removes the limit. */
    monthlyCreditLimit: CreditLimit,
  })
  .partial()
  .strict()
  .refine((v) => v.role !== undefined || v.monthlyCreditLimit !== undefined, { message: "role or monthlyCreditLimit is required" });

interface MemberRow {
  user_id: string;
  role: string;
  monthly_credit_limit: number | null;
  name: string | null;
  email: string | null;
  image: string | null;
}

interface InviteRow {
  id: string;
  workspace_id: string;
  email: string;
  role: "editor" | "viewer";
  invited_by: string;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
  monthly_credit_limit?: number | null;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Purchased seats of a live Team subscription; null when the workspace is not on Team (D-013). */
async function teamSeats(env: Env, workspaceId: string, now: number): Promise<number | null> {
  const sub = await latestSubscription(env, workspaceId);
  return isLive(sub, now) && sub.plan === "team" ? Math.max(1, sub.seats ?? 1) : null;
}

function inviteView(r: InviteRow) {
  return { id: r.id, email: r.email, role: r.role, monthlyCreditLimit: r.monthly_credit_limit ?? null, invitedBy: r.invited_by, createdAt: r.created_at, expiresAt: r.expires_at };
}

async function ownerCount(db: D1Database, workspaceId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?1 AND role = 'owner'")
    .bind(workspaceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function findInviteByToken(db: D1Database, token: string) {
  const hash = await sha256Hex(token);
  return db
    .prepare(
      `SELECT i.*, w.name AS workspace_name, w.kind AS workspace_kind, COALESCE(NULLIF(TRIM(u.name), ''), u.email) AS inviter_name
       FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.token_hash = ?1`,
    )
    .bind(hash)
    .first<InviteRow & { workspace_name: string; workspace_kind: string; inviter_name: string | null }>();
}

function inviteState(r: InviteRow, now: number): "pending" | "accepted" | "revoked" | "expired" {
  if (r.accepted_at) return "accepted";
  if (r.revoked_at) return "revoked";
  if (r.expires_at <= now) return "expired";
  return "pending";
}

const RenameBody = z.object({ name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX) }).strict();

export const workspace = new Hono<AppEnv>()
  /** Renames the current Team workspace (owners). Personal workspaces keep their name. */
  .patch("/", validate("json", RenameBody), async (c) => {
    const auth = requireRole(c, "owner");
    const { name } = c.req.valid("json");
    if (auth.workspace.kind !== "team") throw new ApiError(402, "TEAM_REQUIRED", "Only Team workspaces have a name", { currentPlan: auth.plan });
    await c.env.DB.prepare("UPDATE workspaces SET name = ? WHERE id = ?").bind(name, auth.workspaceId).run();
    return c.json({ workspace: { id: auth.workspaceId, name, kind: auth.workspace.kind } });
  })
  .get("/members", async (c) => {
    const auth = requireUser(c);
    const now = Date.now();
    const [members, invites] = await c.env.DB.batch<unknown>([
      c.env.DB.prepare(
        `SELECT m.user_id, m.role, m.monthly_credit_limit, u.name, u.email, u.image
         FROM workspace_members m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ?1
         ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.name`,
      ).bind(auth.workspaceId),
      c.env.DB.prepare(
        `SELECT * FROM workspace_invites WHERE workspace_id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2
         ORDER BY created_at DESC`,
      ).bind(auth.workspaceId, now),
    ]);
    const memberRows = (members?.results ?? []) as MemberRow[];
    const purchased = await teamSeats(c.env, auth.workspaceId, now);
    const inviteRows = auth.role === "owner" ? ((invites?.results ?? []) as InviteRow[]) : [];
    return c.json({
      members: memberRows.map((m) => ({
        userId: m.user_id,
        name: m.name ?? "",
        email: m.email,
        image: m.image,
        role: m.role,
        monthlyCreditLimit: m.monthly_credit_limit,
        isYou: m.user_id === auth.userId,
      })),
      invites: inviteRows.map(inviteView),
      // `limit` = purchased Team seats (1 without Team); `team` tells the client whether invites are possible.
      seats: { used: memberRows.length + ((invites?.results ?? []) as unknown[]).length, limit: purchased ?? 1, team: purchased !== null },
    });
  })
  .post("/invites", validate("json", InviteBody), async (c) => {
    const auth = requireRole(c, "owner");
    const { email, role, monthlyCreditLimit = null } = c.req.valid("json");
    await limitOrThrow(c.env.RATE_LIMIT, `invite:${auth.workspaceId}`);
    const now = Date.now();
    const seats = await teamSeats(c.env, auth.workspaceId, now);
    if (seats === null) throw new ApiError(402, "TEAM_REQUIRED", "Inviting people needs the Team plan", { currentPlan: auth.plan });
    const existing = await c.env.DB.prepare(
      `SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?1 AND lower(u.email) = ?2`,
    )
      .bind(auth.workspaceId, email)
      .first();
    if (existing) throw new ApiError(409, "CONFLICT", "This person is already a member", { email });

    // A new invite to the same address replaces the pending one (resend).
    const pendingSame = await c.env.DB.prepare(
      `SELECT id FROM workspace_invites WHERE workspace_id = ?1 AND email = ?2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?3`,
    )
      .bind(auth.workspaceId, email, now)
      .first<{ id: string }>();
    const inUse = await seatsInUse(c.env.DB, auth.workspaceId, now);
    const used = inUse.used - (pendingSame ? 1 : 0);
    if (used >= seats) {
      // `needed`: the total seats this invite requires (open "Add seats" with it).
      throw new ApiError(402, "SEATS_REQUIRED", "Add a seat to invite another person", { seats, used, needed: used + 1 });
    }

    const id = newId("invite");
    const token = randomToken();
    const expiresAt = now + INVITE_TTL_DAYS * DAY_MS;
    const statements = [
      c.env.DB.prepare(
        `INSERT INTO workspace_invites (id, workspace_id, email, role, token_hash, invited_by, created_at, expires_at, monthly_credit_limit) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(id, auth.workspaceId, email, role, await sha256Hex(token), auth.userId, now, expiresAt, monthlyCreditLimit),
    ];
    if (pendingSame) {
      statements.unshift(c.env.DB.prepare("UPDATE workspace_invites SET revoked_at = ?2 WHERE id = ?1").bind(pendingSame.id, now));
    }
    await c.env.DB.batch(statements);
    await enqueueEmail(c.env, {
      to: email,
      template: "workspace-invite",
      data: {
        workspaceName: auth.workspace.name,
        // The inviter's name, else their email: never "A teammate" for a known sender.
        inviterName: auth.user?.name?.trim() || auth.user?.email || "",
        role,
        acceptUrl: `${authBaseUrl(c.env)}/invite/${encodeURIComponent(token)}`,
        expiresInDays: INVITE_TTL_DAYS,
      },
    });
    return c.json(
      { invite: inviteView({ id, workspace_id: auth.workspaceId, email, role, invited_by: auth.userId, created_at: now, expires_at: expiresAt, accepted_at: null, revoked_at: null, monthly_credit_limit: monthlyCreditLimit }) },
      201,
    );
  })
  /** Invite preview for the accept screen (token from the emailed link). */
  .get("/invites/lookup", validate("query", TokenQuery), async (c) => {
    const { token } = c.req.valid("query");
    await limitOrThrow(c.env.RATE_LIMIT, `invite-lookup:${c.req.header("cf-connecting-ip") ?? "0"}`);
    const row = await findInviteByToken(c.env.DB, token);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Invite not found");
    return c.json({
      workspace: { id: row.workspace_id, name: row.workspace_name },
      inviterName: row.inviter_name ?? "",
      email: row.email,
      role: row.role,
      expiresAt: row.expires_at,
      state: inviteState(row, Date.now()),
    });
  })
  .post("/invites/accept", validate("json", AcceptBody), async (c) => {
    const auth = requireUser(c);
    const { token } = c.req.valid("json");
    await limitOrThrow(c.env.RATE_LIMIT, `invite-accept:${auth.userId}`);
    const row = await findInviteByToken(c.env.DB, token);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Invite not found");
    const now = Date.now();
    const state = inviteState(row, now);
    if (state !== "pending") throw new ApiError(409, "CONFLICT", "This invite can no longer be used", { state });
    if (!auth.user?.email || auth.user.email.toLowerCase() !== row.email.toLowerCase()) {
      throw new ApiError(403, "FORBIDDEN", "This invite is for a different email address", { email: row.email });
    }
    // Accepting turns the invite's reserved seat into a member seat (D-013).
    const seats = await teamSeats(c.env, row.workspace_id, now);
    if (seats === null) throw new ApiError(402, "TEAM_REQUIRED", "This workspace is no longer on the Team plan", { currentPlan: null });
    const members = (await seatsInUse(c.env.DB, row.workspace_id, now)).members;
    if (members >= seats) throw new ApiError(402, "SEATS_REQUIRED", "This workspace has no free seat", { seats, used: members, needed: members + 1 });
    const [, updated] = await c.env.DB.batch([
      c.env.DB.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, monthly_credit_limit) VALUES (?1, ?2, ?3, ?4)").bind(
        row.workspace_id,
        auth.userId,
        row.role,
        row.monthly_credit_limit ?? null,
      ),
      c.env.DB.prepare("UPDATE workspace_invites SET accepted_at = ?2, accepted_by = ?3 WHERE id = ?1 AND accepted_at IS NULL").bind(row.id, now, auth.userId),
    ]);
    if (!updated?.meta.changes) throw new ApiError(409, "CONFLICT", "This invite can no longer be used", { state: "accepted" });
    const role = await c.env.DB.prepare("SELECT role FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2")
      .bind(row.workspace_id, auth.userId)
      .first<{ role: string }>();
    return c.json({ workspace: { id: row.workspace_id, name: row.workspace_name, kind: row.workspace_kind }, role: role?.role ?? row.role });
  })
  .delete("/invites/:id", validate("param", InviteParam), async (c) => {
    const auth = requireRole(c, "owner");
    const { id } = c.req.valid("param");
    const res = await c.env.DB.prepare(
      "UPDATE workspace_invites SET revoked_at = ?3 WHERE id = ?1 AND workspace_id = ?2 AND accepted_at IS NULL AND revoked_at IS NULL",
    )
      .bind(id, auth.workspaceId, Date.now())
      .run();
    if (!res.meta.changes) throw new ApiError(404, "NOT_FOUND", "Invite not found");
    return c.json({ ok: true });
  })
  .patch("/members/:id", validate("param", MemberParam), validate("json", MemberPatch), async (c) => {
    const auth = requireRole(c, "owner");
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const member = await c.env.DB.prepare("SELECT role, monthly_credit_limit FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2")
      .bind(auth.workspaceId, id)
      .first<{ role: string; monthly_credit_limit: number | null }>();
    if (!member) throw new ApiError(404, "NOT_FOUND", "Member not found");
    if (patch.role && patch.role !== "owner" && member.role === "owner" && (await ownerCount(c.env.DB, auth.workspaceId)) <= 1) {
      throw new ApiError(409, "CONFLICT", "A workspace needs at least one owner");
    }
    const role = patch.role ?? member.role;
    const limit = patch.monthlyCreditLimit === undefined ? member.monthly_credit_limit : patch.monthlyCreditLimit;
    await c.env.DB.prepare("UPDATE workspace_members SET role = ?3, monthly_credit_limit = ?4 WHERE workspace_id = ?1 AND user_id = ?2")
      .bind(auth.workspaceId, id, role, limit)
      .run();
    return c.json({ member: { userId: id, role, monthlyCreditLimit: limit } });
  })
  /** Owners remove members; anyone may leave (not the last owner, not their own personal workspace). */
  .delete("/members/:id", validate("param", MemberParam), async (c) => {
    const { id } = c.req.valid("param");
    const self = requireUser(c);
    const auth = id === self.userId ? self : requireRole(c, "owner");
    if (id === auth.userId && auth.workspaceId === personalWorkspaceId(auth.userId)) {
      throw new ApiError(409, "CONFLICT", "You can't leave your personal workspace");
    }
    const member = await c.env.DB.prepare("SELECT role FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2")
      .bind(auth.workspaceId, id)
      .first<{ role: string }>();
    if (!member) throw new ApiError(404, "NOT_FOUND", "Member not found");
    if (member.role === "owner" && (await ownerCount(c.env.DB, auth.workspaceId)) <= 1) {
      throw new ApiError(409, "CONFLICT", "A workspace needs at least one owner");
    }
    await c.env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2").bind(auth.workspaceId, id).run();
    return c.json({ ok: true });
  });
