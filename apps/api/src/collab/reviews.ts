/**
 * Client review links (D-031), D1 side: create / list / update / revoke for
 * the project's editors, and the public review page for reviewers without an
 * account (password, one-time code, time-coded comments, decision).
 * Reviewer comments are stored in the project's ProjectRoom (threads with a
 * `review` anchor); decisions in `review_decisions`.
 *
 * Mature rule (D-005, D-031): items rated mature (asset flag, review-pending
 * clip, suggestive/explicit version rating, or a node marked mature) need the
 * owner's explicit confirmation, and an owner who may view mature content.
 * On such a link the mature items are shown only to signed-in, mature-allowed
 * viewers; every anonymous reviewer sees them withheld. An item that becomes
 * mature after the link was made is withheld unless the link was confirmed.
 */
import {
  hashPassword,
  linkState,
  matureCreateCheck,
  mayViewMatureItem,
  randomCode,
  randomToken,
  REVIEW_CODE_COOLDOWN_SECONDS,
  REVIEW_CODE_MAX_ATTEMPTS,
  REVIEW_CODE_TTL_MINUTES,
  REVIEW_MEDIA_TTL_SECONDS,
  reviewStatus,
  signReviewPass,
  verifyPassword,
  verifyReviewPass,
  type CreateReviewInput,
  type ReviewDecision,
  type ReviewItem,
  type ThreadView,
  type UpdateReviewInput,
} from "@rolling/core/collab";
import { newId } from "@rolling/core/ids";
import type { AuthContext, ProjectAccess } from "../lib/access";
import { projectRoom } from "../lib/access";
import { ApiError } from "../lib/errors";
import { assetMeta, mediaSigningKey, mediaUrlFor, reviewPending, type AssetRow } from "../lib/mediaUrls";
import { orFail, unwrap } from "../lib/room";
import { sha256Hex } from "../auth/rateLimit";
import type { CollabCaller } from "../do/ProjectRoom";
import { appUrl, notifyInApp, sendCollabEmail, emailUsers } from "./notify";

export interface LinkRow {
  id: string;
  token: string;
  project_id: string;
  workspace_id: string;
  kind: "version" | "export" | "shots";
  title: string;
  items: string;
  mature: number;
  password_hash: string | null;
  password_version: number;
  expires_at: number | null;
  revoked_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface DecisionRow {
  id: string;
  link_id: string;
  reviewer_id: string;
  decision: ReviewDecision;
  note: string | null;
  created_at: number;
  name?: string;
  email?: string;
}

const DAY_MS = 86_400_000;

export function reviewUrl(env: Env, token: string): string {
  return appUrl(env, `/review/${token}`);
}

function items(row: LinkRow): ReviewItem[] {
  try {
    return JSON.parse(row.items) as ReviewItem[];
  } catch {
    return [];
  }
}

const MATURE_RATINGS = new Set(["suggestive", "explicit"]);

async function assetsById(env: Env, ids: string[]): Promise<Map<string, AssetRow>> {
  const out = new Map<string, AssetRow>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    if (!chunk.length) continue;
    const rows = await env.DB.prepare(`SELECT * FROM assets WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<AssetRow>();
    for (const r of rows.results) out.set(r.id, r);
  }
  return out;
}

function assetIsMature(a: AssetRow): boolean {
  return a.mature === 1 || reviewPending(a) || MATURE_RATINGS.has(a.rating ?? "");
}

function mediaKind(kind: string): ReviewItem["kind"] | null {
  return kind === "image" || kind === "video" || kind === "audio" ? kind : null;
}

/** Freezes the items a new link shows (node versions or an export of this project). */
async function resolveItems(env: Env, caller: CollabCaller, projectId: string, input: CreateReviewInput): Promise<{ items: ReviewItem[]; title: string }> {
  const room = projectRoom(env, projectId);
  if (input.kind === "export") {
    const row = await env.DB.prepare("SELECT id, asset_id, status FROM exports WHERE id = ? AND project_id = ?").bind(input.exportId, projectId).first<{ id: string; asset_id: string | null; status: string }>();
    if (!row) throw new ApiError(404, "NOT_FOUND", "Export not found");
    if (row.status !== "done" || !row.asset_id) throw new ApiError(409, "CONFLICT", "This export has not finished yet");
    const asset = (await assetsById(env, [row.asset_id])).get(row.asset_id);
    if (!asset) throw new ApiError(404, "NOT_FOUND", "Export not found");
    return {
      items: [{ id: "i1", kind: mediaKind(asset.kind) ?? "video", title: "Export", assetId: asset.id, nodeId: null, versionId: null, exportId: row.id, mature: assetIsMature(asset) }],
      title: "Export",
    };
  }
  const graph = orFail(await room.getGraph(caller));
  const nodeIds = input.kind === "version" ? [input.nodeId] : [...new Set(input.nodeIds)];
  const picked: Array<{ nodeId: string; title: string; mature: boolean; versionId: string; assetId: string; rating: string | null; n: number }> = [];
  for (const nodeId of nodeIds) {
    const node = graph.state.nodes.find((n) => n.id === nodeId);
    if (!node) throw new ApiError(404, "NOT_FOUND", "Node not found", { nodeId });
    const { versions, activeVersionId } = unwrap(await room.listVersions(caller, nodeId));
    const wanted = input.kind === "version" && input.versionId ? input.versionId : activeVersionId;
    const v = versions.find((x) => x.id === wanted);
    if (!v || !v.assetId) throw new ApiError(409, "CONFLICT", input.kind === "version" && input.versionId ? "That version has no media" : "This node has no result yet", { nodeId });
    picked.push({ nodeId, title: node.title, mature: node.params.mature === true, versionId: v.id, assetId: v.assetId, rating: v.rating, n: v.n });
  }
  const assets = await assetsById(env, picked.map((p) => p.assetId));
  const out: ReviewItem[] = picked.map((p, i) => {
    const a = assets.get(p.assetId);
    const kind = a ? mediaKind(a.kind) : null;
    if (!a || !kind || a.workspace_id !== caller.workspaceId) throw new ApiError(409, "CONFLICT", "This result can't be put on a review link", { nodeId: p.nodeId });
    return { id: `i${i + 1}`, kind, title: p.title, assetId: a.id, nodeId: p.nodeId, versionId: p.versionId, exportId: null, mature: p.mature || MATURE_RATINGS.has(p.rating ?? "") || assetIsMature(a) };
  });
  const first = picked[0]!;
  return { items: out, title: input.kind === "version" ? `${first.title} · v${first.n}` : `${picked.length} shots` };
}

async function decisionsOf(env: Env, linkIds: string[]): Promise<Map<string, DecisionRow[]>> {
  const out = new Map<string, DecisionRow[]>();
  for (let i = 0; i < linkIds.length; i += 50) {
    const chunk = linkIds.slice(i, i + 50);
    if (!chunk.length) continue;
    const rows = await env.DB.prepare(
      `SELECT d.*, r.name, r.email FROM review_decisions d LEFT JOIN review_reviewers r ON r.id = d.reviewer_id WHERE d.link_id IN (${chunk.map(() => "?").join(",")}) ORDER BY d.created_at`,
    )
      .bind(...chunk)
      .all<DecisionRow>();
    for (const r of rows.results) out.set(r.link_id, [...(out.get(r.link_id) ?? []), r]);
  }
  return out;
}

/** Latest decision per reviewer. */
function latestDecisions(rows: DecisionRow[]) {
  const latest = new Map<string, DecisionRow>();
  for (const r of rows) latest.set(r.reviewer_id, r);
  return [...latest.values()].map((r) => ({ reviewerId: r.reviewer_id, name: r.name ?? "", email: r.email ?? null, decision: r.decision, note: r.note, createdAt: r.created_at }));
}

export function ownerView(env: Env, row: LinkRow, decisions: DecisionRow[]) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    url: reviewUrl(env, row.token),
    state: linkState({ expiresAt: row.expires_at, revokedAt: row.revoked_at }),
    status: reviewStatus(decisions.map((d) => ({ reviewerId: d.reviewer_id, decision: d.decision, createdAt: d.created_at }))),
    mature: row.mature === 1,
    hasPassword: row.password_hash !== null,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    items: items(row).map((i) => ({ id: i.id, kind: i.kind, title: i.title, nodeId: i.nodeId, versionId: i.versionId, exportId: i.exportId, mature: i.mature })),
    decisions: latestDecisions(decisions),
  };
}
export type ReviewOwnerView = ReturnType<typeof ownerView>;

export async function createReview(env: Env, input: { auth: AuthContext; acc: ProjectAccess; caller: CollabCaller; input: CreateReviewInput }): Promise<ReviewOwnerView> {
  const { acc, caller } = input;
  const body = input.input;
  const { items: list, title } = await resolveItems(env, caller, acc.project.id, body);
  const check = matureCreateCheck({ items: list, confirmMature: body.confirmMature === true, creatorIsOwner: acc.role === "owner", creatorMatureAllowed: acc.matureAllowed });
  if (!check.ok) {
    const matureItems = list.filter((i) => i.mature).map((i) => i.id);
    if (check.code === "MATURE_CONFIRM_REQUIRED") throw new ApiError(409, "MATURE_CONFIRM_REQUIRED", "This selection has mature content. Confirm to put it on a review link.", { items: matureItems });
    throw new ApiError(403, "FORBIDDEN", "Only an owner with mature content on can put mature content on a review link", { reason: "MATURE_NOT_ALLOWED", items: matureItems });
  }
  const now = Date.now();
  const row: LinkRow = {
    id: newId("review"),
    token: randomToken(24),
    project_id: acc.project.id,
    workspace_id: acc.project.workspace_id,
    kind: body.kind,
    title: body.title ?? title,
    items: JSON.stringify(list),
    mature: check.mature ? 1 : 0,
    password_hash: body.password ? await hashPassword(body.password) : null,
    password_version: body.password ? 1 : 0,
    expires_at: body.expiresInDays ? now + body.expiresInDays * DAY_MS : null,
    revoked_at: null,
    created_by: caller.userId,
    created_at: now,
    updated_at: now,
  };
  await env.DB.prepare(
    `INSERT INTO review_links (id, token, project_id, workspace_id, kind, title, items, mature, password_hash, password_version, expires_at, revoked_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  )
    .bind(row.id, row.token, row.project_id, row.workspace_id, row.kind, row.title, row.items, row.mature, row.password_hash, row.password_version, row.expires_at, row.created_by, now, now)
    .run();
  await projectRoom(env, acc.project.id).reviewEvent({ kind: "review.created", actor: { kind: "member", id: caller.userId, name: caller.name }, data: { reviewId: row.id, title: row.title, items: list.length } });
  return ownerView(env, row, []);
}

export async function listReviews(env: Env, projectId: string): Promise<ReviewOwnerView[]> {
  const rows = await env.DB.prepare("SELECT * FROM review_links WHERE project_id = ? ORDER BY created_at DESC LIMIT 100").bind(projectId).all<LinkRow>();
  const decisions = await decisionsOf(env, rows.results.map((r) => r.id));
  return rows.results.map((r) => ownerView(env, r, decisions.get(r.id) ?? []));
}

async function linkOfProject(env: Env, projectId: string, reviewId: string): Promise<LinkRow> {
  const row = await env.DB.prepare("SELECT * FROM review_links WHERE id = ? AND project_id = ?").bind(reviewId, projectId).first<LinkRow>();
  if (!row) throw new ApiError(404, "NOT_FOUND", "Review link not found");
  return row;
}

export async function reviewDetail(env: Env, projectId: string, reviewId: string): Promise<{ review: ReviewOwnerView; threads: ThreadView[] }> {
  const row = await linkOfProject(env, projectId, reviewId);
  const decisions = (await decisionsOf(env, [row.id])).get(row.id) ?? [];
  const { threads } = await projectRoom(env, projectId).reviewThreads(row.id);
  return { review: ownerView(env, row, decisions), threads };
}

export async function updateReview(env: Env, input: { projectId: string; reviewId: string; caller: CollabCaller; patch: UpdateReviewInput }): Promise<ReviewOwnerView> {
  const row = await linkOfProject(env, input.projectId, input.reviewId);
  const now = Date.now();
  const p = input.patch;
  if (row.revoked_at !== null && !p.revoke) throw new ApiError(409, "CONFLICT", "This review link was revoked");
  const next = { ...row, updated_at: now };
  if (p.expiresInDays !== undefined) next.expires_at = p.expiresInDays === null ? null : now + p.expiresInDays * DAY_MS;
  if (p.password !== undefined) {
    next.password_hash = p.password === null ? null : await hashPassword(p.password);
    next.password_version = row.password_version + 1;
  }
  if (p.revoke && row.revoked_at === null) next.revoked_at = now;
  await env.DB.prepare("UPDATE review_links SET expires_at = ?, password_hash = ?, password_version = ?, revoked_at = ?, updated_at = ? WHERE id = ?")
    .bind(next.expires_at, next.password_hash, next.password_version, next.revoked_at, now, row.id)
    .run();
  if (p.revoke && row.revoked_at === null) {
    await projectRoom(env, input.projectId).reviewEvent({ kind: "review.revoked", actor: { kind: "member", id: input.caller.userId, name: input.caller.name }, data: { reviewId: row.id, title: row.title } });
  }
  const decisions = (await decisionsOf(env, [row.id])).get(row.id) ?? [];
  return ownerView(env, next, decisions);
}

/** Project deleted: its review links stop working (reviewers and codes go with them). */
export async function revokeReviewsForProject(env: Env, projectId: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE review_links SET revoked_at = ?1, updated_at = ?1 WHERE project_id = ?2 AND revoked_at IS NULL").bind(now, projectId),
    env.DB.prepare("DELETE FROM review_codes WHERE link_id IN (SELECT id FROM review_links WHERE project_id = ?1)").bind(projectId),
    env.DB.prepare("DELETE FROM review_reviewers WHERE link_id IN (SELECT id FROM review_links WHERE project_id = ?1)").bind(projectId),
  ]);
}

// ---------------------------------------------------------------- public side

export interface ReviewerRow {
  id: string;
  link_id: string;
  email: string;
  name: string;
}

/** An active link by its URL token: 404 unknown, 410 `LINK_EXPIRED { state }` when revoked or expired. */
export async function activeLink(env: Env, token: string): Promise<LinkRow> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new ApiError(404, "NOT_FOUND", "Review link not found");
  const row = await env.DB.prepare("SELECT * FROM review_links WHERE token = ?").bind(token).first<LinkRow>();
  if (!row) throw new ApiError(404, "NOT_FOUND", "Review link not found");
  const state = linkState({ expiresAt: row.expires_at, revokedAt: row.revoked_at });
  if (state !== "active") throw new ApiError(410, "LINK_EXPIRED", state === "revoked" ? "This review link was turned off" : "This review link has expired", { state });
  return row;
}

/** Password-protected links need a valid pass (`x-review-pass`, from `unlock`): else 401 `PASSWORD_REQUIRED`. */
export async function requireAccess(env: Env, link: LinkRow, pass: string | null | undefined): Promise<void> {
  if (!link.password_hash) return;
  if (await verifyReviewPass(mediaSigningKey(env), link.id, link.password_version, pass)) return;
  throw new ApiError(401, "PASSWORD_REQUIRED", "Enter the password to open this review", { title: link.title });
}

export async function unlock(env: Env, link: LinkRow, password: string): Promise<string> {
  if (!link.password_hash) return "";
  if (!(await verifyPassword(password, link.password_hash))) throw new ApiError(403, "FORBIDDEN", "That password is not right", { reason: "WRONG_PASSWORD" });
  return signReviewPass(mediaSigningKey(env), link.id, link.password_version);
}

export async function reviewerFor(env: Env, link: LinkRow, token: string | null | undefined): Promise<ReviewerRow | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const row = await env.DB.prepare("SELECT id, link_id, email, name FROM review_reviewers WHERE token_hash = ? AND link_id = ?").bind(await sha256Hex(token), link.id).first<ReviewerRow>();
  if (row) await env.DB.prepare("UPDATE review_reviewers SET last_seen_at = ? WHERE id = ?").bind(Date.now(), row.id).run();
  return row;
}

export async function requireReviewer(env: Env, link: LinkRow, token: string | null | undefined): Promise<ReviewerRow> {
  const r = await reviewerFor(env, link, token);
  if (!r) throw new ApiError(401, "UNAUTHENTICATED", "Confirm your email to comment on this review");
  return r;
}

/** The page a reviewer sees: media (signed URLs, D-008; mature withheld per D-031), threads of this link, decisions. */
export async function publicView(env: Env, link: LinkRow, viewer: { auth: AuthContext | null; reviewer: ReviewerRow | null }) {
  const list = items(link);
  const assets = await assetsById(env, list.map((i) => i.assetId));
  const viewerMature = viewer.auth ? { matureAllowed: viewer.auth.matureAllowed } : null;
  const mayViewMature = mayViewMatureItem({ mature: link.mature === 1 }, viewerMature);
  const out = [];
  for (const it of list) {
    const a = assets.get(it.assetId);
    const mature = it.mature || (a ? assetIsMature(a) : false);
    let media: { url: string | null; posterUrl: string | null } | null = null;
    let withheld: "mature" | "missing" | null = null;
    if (!a || a.status === "failed") withheld = "missing";
    else if (mature && !mayViewMature) withheld = "mature";
    else {
      const ref = (key: string | null) => (key ? mediaUrlFor(env, { key, workspaceId: a.workspace_id, mature }, { mayViewMature }, REVIEW_MEDIA_TTL_SECONDS) : Promise.resolve(null));
      const thumb = assetMeta(a).thumbKey;
      media = { url: await ref(a.r2_key), posterUrl: await ref(typeof thumb === "string" ? thumb : a.kind === "image" ? a.r2_key : null) };
    }
    out.push({ id: it.id, kind: it.kind, title: it.title, mature, media, withheld });
  }
  const project = await env.DB.prepare("SELECT title FROM projects WHERE id = ?").bind(link.project_id).first<{ title: string }>();
  const workspace = await env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(link.workspace_id).first<{ name: string }>();
  const decisions = (await decisionsOf(env, [link.id])).get(link.id) ?? [];
  const { threads } = await projectRoom(env, link.project_id).reviewThreads(link.id);
  return {
    link: {
      id: link.id,
      kind: link.kind,
      title: link.title,
      projectTitle: project?.title ?? null,
      workspaceName: workspace?.name ?? null,
      expiresAt: link.expires_at,
      status: reviewStatus(decisions.map((d) => ({ reviewerId: d.reviewer_id, decision: d.decision, createdAt: d.created_at }))),
      mature: link.mature === 1,
    },
    items: out,
    threads,
    decisions: latestDecisions(decisions).map(({ email: _email, ...d }) => d),
    me: viewer.reviewer ? { id: viewer.reviewer.id, name: viewer.reviewer.name, email: viewer.reviewer.email, decision: latestDecisions(decisions).find((d) => d.reviewerId === viewer.reviewer!.id)?.decision ?? null } : null,
    viewerMatureAllowed: mayViewMature,
  };
}

const codeHash = (link: LinkRow, email: string, code: string) => sha256Hex(`review-code:${link.id}:${email}:${code}`);

export async function sendCode(env: Env, link: LinkRow, input: { name: string; email: string }): Promise<{ expiresInMinutes: number }> {
  const now = Date.now();
  const prev = await env.DB.prepare("SELECT created_at FROM review_codes WHERE link_id = ? AND email = ?").bind(link.id, input.email).first<{ created_at: number }>();
  if (prev && now - prev.created_at < REVIEW_CODE_COOLDOWN_SECONDS * 1000) {
    const retryAfter = Math.ceil((prev.created_at + REVIEW_CODE_COOLDOWN_SECONDS * 1000 - now) / 1000);
    throw new ApiError(429, "RATE_LIMITED", "A code was just sent. Try again in a moment.", { retryAfter });
  }
  const code = randomCode();
  await env.DB.prepare(
    `INSERT INTO review_codes (link_id, email, name, code_hash, attempts, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)
     ON CONFLICT(link_id, email) DO UPDATE SET name = excluded.name, code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at`,
  )
    .bind(link.id, input.email, input.name, await codeHash(link, input.email, code), now + REVIEW_CODE_TTL_MINUTES * 60_000, now)
    .run();
  await sendCollabEmail(env, { email: input.email }, "review-code", { code, linkTitle: link.title, expiresInMinutes: REVIEW_CODE_TTL_MINUTES });
  return { expiresInMinutes: REVIEW_CODE_TTL_MINUTES };
}

export async function verifyCode(env: Env, link: LinkRow, input: { email: string; code: string }): Promise<{ reviewer: { id: string; name: string; email: string }; reviewerToken: string }> {
  const row = await env.DB.prepare("SELECT * FROM review_codes WHERE link_id = ? AND email = ?").bind(link.id, input.email).first<{ name: string; code_hash: string; attempts: number; expires_at: number }>();
  if (!row) throw new ApiError(400, "INVALID_CODE", "That code is not right");
  if (row.expires_at <= Date.now()) throw new ApiError(400, "CODE_EXPIRED", "That code has expired. Ask for a new one.");
  if (row.attempts >= REVIEW_CODE_MAX_ATTEMPTS) throw new ApiError(429, "TOO_MANY_ATTEMPTS", "Too many tries. Ask for a new code.");
  if ((await codeHash(link, input.email, input.code)) !== row.code_hash) {
    await env.DB.prepare("UPDATE review_codes SET attempts = attempts + 1 WHERE link_id = ? AND email = ?").bind(link.id, input.email).run();
    throw new ApiError(400, "INVALID_CODE", "That code is not right", { attemptsLeft: Math.max(0, REVIEW_CODE_MAX_ATTEMPTS - row.attempts - 1) });
  }
  const token = randomToken(32);
  const now = Date.now();
  const id = newId("reviewer");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM review_codes WHERE link_id = ? AND email = ?").bind(link.id, input.email),
    env.DB.prepare(
      `INSERT INTO review_reviewers (id, link_id, email, name, token_hash, verified_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(link_id, email) DO UPDATE SET name = excluded.name, token_hash = excluded.token_hash, verified_at = excluded.verified_at, last_seen_at = excluded.last_seen_at`,
    ).bind(id, link.id, input.email, row.name, await sha256Hex(token), now),
  ]);
  const reviewer = await env.DB.prepare("SELECT id, name, email FROM review_reviewers WHERE link_id = ? AND email = ?").bind(link.id, input.email).first<{ id: string; name: string; email: string }>();
  return { reviewer: reviewer!, reviewerToken: token };
}

type Waiter = { waitUntil(p: Promise<unknown>): void } | undefined;

/** People told about reviewer activity on a link: its creator and the project's creator. */
async function linkWatchers(env: Env, link: LinkRow): Promise<string[]> {
  const project = await env.DB.prepare("SELECT created_by FROM projects WHERE id = ?").bind(link.project_id).first<{ created_by: string }>();
  return [...new Set([link.created_by, ...(project ? [project.created_by] : [])])];
}

export async function reviewerComment(env: Env, link: LinkRow, reviewer: ReviewerRow, input: { itemId: string; at: number | null; body: string; threadId?: string }, wait?: Waiter): Promise<ThreadView> {
  if (!items(link).some((i) => i.id === input.itemId)) throw new ApiError(404, "NOT_FOUND", "Item not found");
  const res = unwrap(await projectRoom(env, link.project_id).reviewComment({ reviewId: link.id, itemId: input.itemId, at: input.at, reviewer: { id: reviewer.id, name: reviewer.name }, body: input.body, ...(input.threadId ? { threadId: input.threadId } : {}) }));
  const recipients = [...(await linkWatchers(env, link)), ...res.participants];
  await notifyInApp(env, recipients, "reviews", { kind: "review.comment", projectId: link.project_id, reviewId: link.id, threadId: res.thread.id, title: `${reviewer.name} commented on ${link.title}`, message: input.body.slice(0, 140), href: `/p/${link.project_id}?thread=${res.thread.id}` }, wait);
  return res.thread;
}

export async function decide(env: Env, link: LinkRow, reviewer: ReviewerRow, input: { decision: ReviewDecision; note?: string }, wait?: Waiter): Promise<void> {
  const now = Date.now();
  await env.DB.prepare("INSERT INTO review_decisions (id, link_id, reviewer_id, decision, note, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(newId("event"), link.id, reviewer.id, input.decision, input.note || null, now).run();
  await projectRoom(env, link.project_id).reviewEvent({ kind: "review.decision", actor: { kind: "reviewer", id: reviewer.id, name: reviewer.name }, data: { reviewId: link.id, title: link.title, decision: input.decision, note: input.note || null } });
  const watchers = await linkWatchers(env, link);
  const href = `/p/${link.project_id}?review=${link.id}`;
  const title = input.decision === "approved" ? `${reviewer.name} approved ${link.title}` : `${reviewer.name} asked for changes on ${link.title}`;
  await notifyInApp(env, watchers, "reviews", { kind: "review.decision", projectId: link.project_id, reviewId: link.id, title, message: input.note ?? "", href }, wait);
  await emailUsers(env, watchers, "reviews", "review-decision", { reviewerName: reviewer.name, linkTitle: link.title, decision: input.decision, note: input.note || null, url: appUrl(env, href) }, wait);
}
