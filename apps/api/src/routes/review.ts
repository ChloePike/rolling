/**
 * Public review page API (D-031), mounted at `/api/review`. Reviewers need no
 * account: a password-protected link first trades the password for a pass
 * (`x-review-pass`), then the reviewer confirms their email with a one-time
 * code and gets a reviewer token (`x-reviewer-token`) for comments and the
 * decision. Signed-in members of any workspace may open a link too; only a
 * signed-in, mature-allowed viewer sees mature items of a link the owner
 * confirmed as mature.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { ReviewCodeInput, ReviewCommentInput, ReviewDecisionInput, ReviewUnlockInput, ReviewVerifyInput } from "@rolling/core/collab";
import type { AppEnv } from "../env";
import { clientIp, limitOrThrow, sha256Hex } from "../auth/rateLimit";
import { validate } from "../lib/validate";
import { activeLink, decide, publicView, requireAccess, requireReviewer, reviewerComment, reviewerFor, sendCode, unlock, verifyCode } from "../collab/reviews";

const TokenParam = z.object({ token: z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/) });

function waiter(c: Context<AppEnv>): { waitUntil(p: Promise<unknown>): void } | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/** The link, checked for state and password. */
async function open(c: Context<AppEnv>, token: string) {
  const link = await activeLink(c.env, token);
  await requireAccess(c.env, link, c.req.header("x-review-pass"));
  return link;
}

export const review = new Hono<AppEnv>()
  .use("*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
    c.header("x-robots-tag", "noindex");
  })
  /** 200 page data; 401 `PASSWORD_REQUIRED { title }`; 404; 410 `LINK_EXPIRED { state }`. */
  .get("/:token", validate("param", TokenParam), async (c) => {
    await limitOrThrow(c.env.RATE_LIMIT, `review-view:${clientIp(c.req.raw)}`);
    const link = await open(c, c.req.valid("param").token);
    const reviewer = await reviewerFor(c.env, link, c.req.header("x-reviewer-token"));
    return c.json(await publicView(c.env, link, { auth: c.get("auth") ?? null, reviewer }));
  })
  /** `{ password }` → `{ pass }` (send it as `x-review-pass`; valid 12 h or until the password changes). */
  .post("/:token/unlock", validate("param", TokenParam), validate("json", ReviewUnlockInput), async (c) => {
    const link = await activeLink(c.env, c.req.valid("param").token);
    await limitOrThrow(c.env.AUTH_RATE_LIMIT, `review-unlock:${link.id}:${clientIp(c.req.raw)}`, "Too many tries. Try again in a minute.");
    return c.json({ pass: await unlock(c.env, link, c.req.valid("json").password) });
  })
  /** `{ name, email }` → 202; emails a 6-digit code (10 minutes, 5 tries, 30 s between sends). */
  .post("/:token/code", validate("param", TokenParam), validate("json", ReviewCodeInput), async (c) => {
    const link = await open(c, c.req.valid("param").token);
    const input = c.req.valid("json");
    await limitOrThrow(c.env.AUTH_RATE_LIMIT, `review-code:${clientIp(c.req.raw)}`, "Too many codes. Try again in a minute.");
    await limitOrThrow(c.env.AUTH_RATE_LIMIT, `review-code-email:${await sha256Hex(input.email)}`, "Too many codes. Try again in a minute.");
    return c.json(await sendCode(c.env, link, input), 202);
  })
  /** `{ email, code }` → `{ reviewer, reviewerToken }`. */
  .post("/:token/verify", validate("param", TokenParam), validate("json", ReviewVerifyInput), async (c) => {
    const link = await open(c, c.req.valid("param").token);
    await limitOrThrow(c.env.AUTH_RATE_LIMIT, `review-verify:${clientIp(c.req.raw)}`, "Too many tries. Try again in a minute.");
    return c.json(await verifyCode(c.env, link, c.req.valid("json")));
  })
  /** `{ itemId, at?, body, threadId? }` with `x-reviewer-token` → 201 `{ thread }`. */
  .post("/:token/comments", validate("param", TokenParam), validate("json", ReviewCommentInput), async (c) => {
    const link = await open(c, c.req.valid("param").token);
    const reviewer = await requireReviewer(c.env, link, c.req.header("x-reviewer-token"));
    await limitOrThrow(c.env.RATE_LIMIT, `review-comment:${reviewer.id}`);
    const thread = await reviewerComment(c.env, link, reviewer, c.req.valid("json"), waiter(c));
    return c.json({ thread }, 201);
  })
  /** `{ decision: 'approved' | 'changes_requested', note? }` with `x-reviewer-token` → `{ status }`. */
  .post("/:token/decision", validate("param", TokenParam), validate("json", ReviewDecisionInput), async (c) => {
    const link = await open(c, c.req.valid("param").token);
    const reviewer = await requireReviewer(c.env, link, c.req.header("x-reviewer-token"));
    await limitOrThrow(c.env.RATE_LIMIT, `review-decision:${reviewer.id}`);
    await decide(c.env, link, reviewer, c.req.valid("json"), waiter(c));
    const view = await publicView(c.env, link, { auth: c.get("auth") ?? null, reviewer });
    return c.json({ status: view.link.status, me: view.me });
  });

