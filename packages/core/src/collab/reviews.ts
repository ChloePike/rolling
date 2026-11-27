import { z } from 'zod';
import { CommentBody } from './comments';

/**
 * Client review links (D-031). A review link shows a frozen selection of
 * media (one node version, an export, or the active versions of chosen
 * shots) to people without an account. Reviewers verify their email with a
 * one-time code, then leave time-coded comments and approve or request
 * changes. Links can expire, have a password, and be revoked.
 */

export const REVIEW_MAX_DAYS = 90;
export const REVIEW_MAX_SHOTS = 30;
export const REVIEW_PASSWORD_MIN = 6;
export const REVIEW_PASSWORD_MAX = 128;
export const REVIEW_CODE_TTL_MINUTES = 10;
export const REVIEW_CODE_MAX_ATTEMPTS = 5;
export const REVIEW_CODE_COOLDOWN_SECONDS = 30;
/** Signed access to a password-protected link lasts this long. */
export const REVIEW_PASS_TTL_SECONDS = 12 * 3600;
/** Signed media URLs on a review page. */
export const REVIEW_MEDIA_TTL_SECONDS = 3600;

const Id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

const Settings = {
  title: z.string().trim().min(1).max(120).optional(),
  /** Days from now (1–90); omitted = never expires. */
  expiresInDays: z.number().int().min(1).max(REVIEW_MAX_DAYS).optional(),
  password: z.string().min(REVIEW_PASSWORD_MIN).max(REVIEW_PASSWORD_MAX).optional(),
  /** Mature items need this explicit confirmation by an owner who may view mature content (D-005). */
  confirmMature: z.boolean().optional(),
};

export const CreateReviewInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('version'), nodeId: Id, versionId: Id.optional(), ...Settings }).strict(),
  z.object({ kind: z.literal('export'), exportId: Id, ...Settings }).strict(),
  z.object({ kind: z.literal('shots'), nodeIds: z.array(Id).min(1).max(REVIEW_MAX_SHOTS), ...Settings }).strict(),
]);
export type CreateReviewInput = z.infer<typeof CreateReviewInput>;
export type ReviewKind = CreateReviewInput['kind'];

/** `PATCH /api/projects/:id/reviews/:reviewId`. `password: null` removes it; `expiresInDays: null` makes it never expire. */
export const UpdateReviewInput = z
  .object({
    expiresInDays: z.number().int().min(1).max(REVIEW_MAX_DAYS).nullable(),
    password: z.string().min(REVIEW_PASSWORD_MIN).max(REVIEW_PASSWORD_MAX).nullable(),
    revoke: z.literal(true),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateReviewInput = z.infer<typeof UpdateReviewInput>;

export const ReviewUnlockInput = z.object({ password: z.string().min(1).max(REVIEW_PASSWORD_MAX) }).strict();
export const ReviewCodeInput = z.object({ name: z.string().trim().min(1).max(80), email: z.string().trim().toLowerCase().email().max(254) }).strict();
export const ReviewVerifyInput = z.object({ email: z.string().trim().toLowerCase().email().max(254), code: z.string().regex(/^\d{6}$/) }).strict();
export const ReviewCommentInput = z
  .object({
    itemId: z.string().min(1).max(64),
    /** Seconds into a video item; null for images or the whole item. */
    at: z.number().finite().min(0).max(24 * 3600).nullable().default(null),
    body: CommentBody,
    /** Reply to an existing thread of this link. */
    threadId: z.string().min(1).max(64).optional(),
  })
  .strict();
export const ReviewDecisionInput = z
  .object({ decision: z.enum(['approved', 'changes_requested']), note: z.string().trim().max(2000).optional() })
  .strict();

export type ReviewDecision = 'approved' | 'changes_requested';
export type ReviewStatus = 'pending' | 'approved' | 'changes_requested';
export type ReviewLinkState = 'active' | 'expired' | 'revoked';

/** One media item frozen on the link at creation. */
export interface ReviewItem {
  id: string;
  kind: 'image' | 'video' | 'audio';
  title: string;
  assetId: string;
  nodeId: string | null;
  versionId: string | null;
  exportId: string | null;
  mature: boolean;
}

/**
 * Status of a link from each reviewer's latest decision: any "changes
 * requested" wins, then "approved" once at least one reviewer approved, else
 * pending.
 */
export function reviewStatus(decisions: ReadonlyArray<{ reviewerId: string; decision: ReviewDecision; createdAt: number }>): ReviewStatus {
  const latest = new Map<string, { decision: ReviewDecision; createdAt: number }>();
  for (const d of decisions) {
    const prev = latest.get(d.reviewerId);
    if (!prev || d.createdAt >= prev.createdAt) latest.set(d.reviewerId, d);
  }
  if (!latest.size) return 'pending';
  const values = [...latest.values()].map((d) => d.decision);
  if (values.includes('changes_requested')) return 'changes_requested';
  return 'approved';
}

export function linkState(link: { expiresAt: number | null; revokedAt: number | null }, now = Date.now()): ReviewLinkState {
  if (link.revokedAt !== null) return 'revoked';
  if (link.expiresAt !== null && link.expiresAt <= now) return 'expired';
  return 'active';
}

/**
 * The D-031 mature rule for review links, in one place:
 * - a link with any mature item needs `confirmMature` from a creator who is
 *   an owner of the workspace and mature-allowed (D-005: active plan,
 *   preference on, workspace flag on);
 * - on such a link, mature items are shown only to a viewer who is signed in
 *   and mature-allowed; everyone else (every anonymous reviewer) sees them
 *   withheld.
 */
export function matureCreateCheck(input: { items: ReadonlyArray<Pick<ReviewItem, 'mature'>>; confirmMature: boolean; creatorIsOwner: boolean; creatorMatureAllowed: boolean }):
  | { ok: true; mature: boolean }
  | { ok: false; code: 'MATURE_CONFIRM_REQUIRED' | 'MATURE_NOT_ALLOWED' } {
  const mature = input.items.some((i) => i.mature);
  if (!mature) return { ok: true, mature: false };
  if (!input.creatorIsOwner || !input.creatorMatureAllowed) return { ok: false, code: 'MATURE_NOT_ALLOWED' };
  if (!input.confirmMature) return { ok: false, code: 'MATURE_CONFIRM_REQUIRED' };
  return { ok: true, mature: true };
}

export function mayViewMatureItem(link: { mature: boolean }, viewer: { matureAllowed: boolean } | null): boolean {
  return link.mature && viewer !== null && viewer.matureAllowed;
}

// ---------------------------------------------------------------- secrets (WebCrypto: Workers and Node)

const PBKDF2_ITERATIONS = 100_000; // workerd's maximum

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function randomToken(bytes = 24): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Six-digit one-time code. */
export function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return String(n).padStart(6, '0');
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** `pbkdf2$<iterations>$<salt>$<hash>` (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2' || !iter || !salt || !hash) return false;
  const derived = await pbkdf2(password, fromB64url(salt), Number(iter));
  return equalBytes(derived, fromB64url(hash));
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}

/**
 * Proof that the password of a link was entered: `<exp>.<hmac>` over the link
 * id and the password's version (changing the password invalidates passes).
 */
export async function signReviewPass(secret: string, linkId: string, passwordVersion: number, now = Date.now()): Promise<string> {
  const exp = Math.floor(now / 1000) + REVIEW_PASS_TTL_SECONDS;
  return `${exp}.${await hmac(secret, `review-pass:${linkId}:${passwordVersion}:${exp}`)}`;
}

export async function verifyReviewPass(secret: string, linkId: string, passwordVersion: number, pass: string | null | undefined, now = Date.now()): Promise<boolean> {
  if (!pass) return false;
  const [expRaw, sig] = pass.split('.');
  const exp = Number(expRaw);
  if (!sig || !Number.isInteger(exp) || exp * 1000 <= now) return false;
  const want = await hmac(secret, `review-pass:${linkId}:${passwordVersion}:${exp}`);
  return equalBytes(new TextEncoder().encode(want), new TextEncoder().encode(sig));
}
