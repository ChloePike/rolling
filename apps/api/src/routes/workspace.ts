/**
 * Workspace members and invites (M1) for the current workspace (the
 * `x-workspace-id` header, default personal). Seats come from the plan (D-006):
 * Starter and Plus 1, Pro 10.
 */
import { Hono } from "hono";
import { z } from "zod";
import { INVITE_ROLES, ROLES } from "@rolling/core/auth/roles";
import { newId } from "@rolling/core/ids";
import { PLANS } from "@rolling/core/pricing/config";
import type { AppEnv } from "../env";
import { requireRole, requireUser, type AuthContext } from "../auth/context";
import { authBaseUrl } from "../auth/betterAuth";
import { enqueueEmail } from "../auth/email";
import { personalWorkspaceId } from "../auth/workspace";
import { limitOrThrow, sha256Hex } from "../auth/rateLimit";
import { ApiError } from "../lib/errors";
import { validate } from "../lib/validate";

export const INVITE_TTL_DAYS = 7;
const DAY_MS = 86_400_000;

const InviteBody = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(INVITE_ROLES) }).strict();
const AcceptBody = z.object({ token: z.string().min(20).max(200) }).strict();
const TokenQuery = z.object({ token: z.string().min(20).max(200) });
const MemberParam = z.object({ id: z.string().min(1).max(80) });
const InviteParam = z.object({ id: z.string().regex(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/) });
const MemberPatch = z
  .object({
    role: z.enum(ROLES),
    /** Credits per calendar month this member may spend from the shared pool; null removes the limit. */
    monthlyCreditLimit: z.number().int().min(0).max(100_000_000).nullable(),
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
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function seatLimit(auth: AuthContext): number {
  return auth.plan ? PLANS[auth.plan].seats : 1;
}

async function seatsUsed(db: D1Database, workspaceId: string, now: number): Promise<{ members: number; pending: number }> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = ?1) AS members,
              (SELECT COUNT(*) FROM workspace_invites WHERE workspace_id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2) AS pending`,
    )
    .bind(workspaceId, now)
    .first<{ members: number; pending: number }>();
  return { members: row?.members ?? 0, pending: row?.pending ?? 0 };
}

function inviteView(r: InviteRow) {
  return { id: r.id, email: r.email, role: r.role, invitedBy: r.invited_by, createdAt: r.created_at, expiresAt: r.expires_at };
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
      `SELECT i.*, w.name AS workspace_name, w.kind AS workspace_kind, u.name AS inviter_name
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

export const workspace = new Hono<AppEnv>()
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
      seats: { used: memberRows.length + ((invites?.results ?? []) as unknown[]).length, limit: seatLimit(auth) },
    });
  })
  .post("/invites", validate("json", InviteBody), async (c) => {
    const auth = requireRole(c, "owner");
    const { email, role } = c.req.valid("json");
    await limitOrThrow(c.env.RATE_LIMIT, `invite:${auth.workspaceId}`);
    if (!auth.plan) throw new ApiError(402, "NO_PLAN", "Inviting teammates needs the Pro plan", { requiredPlan: "pro" });
    const now = Date.now();
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
    const used = await seatsUsed(c.env.DB, auth.workspaceId, now);
    const limit = seatLimit(auth);
    if (used.members + used.pending - (pendingSame ? 1 : 0) >= limit) {
      throw new ApiError(403, "SEAT_LIMIT_REACHED", "Your plan has no free seats", { seats: limit, used: used.members + used.pending, requiredPlan: "pro" });
    }

    const id = newId("invite");
    const token = randomToken();
    const expiresAt = now + INVITE_TTL_DAYS * DAY_MS;
    const statements = [
      c.env.DB.prepare(
        `INSERT INTO workspace_invites (id, workspace_id, email, role, token_hash, invited_by, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(id, auth.workspaceId, email, role, await sha256Hex(token), auth.userId, now, expiresAt),
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
        inviterName: auth.user?.name ?? "",
        role,
        acceptUrl: `${authBaseUrl(c.env)}/invite/${encodeURIComponent(token)}`,
        expiresInDays: INVITE_TTL_DAYS,
      },
    });
    return c.json(
      { invite: inviteView({ id, workspace_id: auth.workspaceId, email, role, invited_by: auth.userId, created_at: now, expires_at: expiresAt, accepted_at: null, revoked_at: null }) },
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
    const [, updated] = await c.env.DB.batch([
      c.env.DB.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?1, ?2, ?3)").bind(row.workspace_id, auth.userId, row.role),
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
