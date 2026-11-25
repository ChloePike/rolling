/**
 * `POST /api/feedback` (Help → Send feedback). Signed in; rate limited (the
 * shared limiter plus 10 per hour per user). Stored in D1 `feedback` and
 * emailed to `FEEDBACK_TO` when set.
 */
import { Hono } from "hono";
import { z } from "zod";
import { newId } from "@rolling/core/ids";
import type { AppEnv } from "../env";
import { requireUser } from "../auth/context";
import { enqueueEmail } from "../auth/email";
import { limitOrThrow } from "../auth/rateLimit";
import { ApiError } from "../lib/errors";
import { validate } from "../lib/validate";

export const FEEDBACK_PER_HOUR = 10;

const FeedbackBody = z
  .object({
    message: z.string().trim().min(1).max(5000),
    page: z.string().trim().max(500).optional(),
    kind: z.enum(["bug", "idea", "other"]).default("other"),
    includeDiagnostics: z.boolean().default(false),
  })
  .strict();

export const feedback = new Hono<AppEnv>().post("/", validate("json", FeedbackBody), async (c) => {
  const auth = requireUser(c);
  const body = c.req.valid("json");
  await limitOrThrow(c.env.RATE_LIMIT, `feedback:${auth.userId}`);
  const now = Date.now();
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND created_at > ?").bind(auth.userId, now - 3_600_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= FEEDBACK_PER_HOUR) throw new ApiError(429, "RATE_LIMITED", "Thanks, we have your feedback. Try again later.", { retryAfter: 3600 });
  // Diagnostics are collected server-side (no client-provided blobs): browser, region, workspace and plan.
  const cf = (c.req.raw as { cf?: { country?: string; colo?: string } }).cf;
  const diagnostics = body.includeDiagnostics
    ? JSON.stringify({
        userAgent: (c.req.header("user-agent") ?? "").slice(0, 300),
        country: cf?.country ?? null,
        colo: cf?.colo ?? null,
        workspaceId: auth.workspaceId,
        workspaceKind: auth.workspace.kind,
        role: auth.role,
        plan: auth.plan,
        language: auth.prefs.language,
        at: new Date(now).toISOString(),
      })
    : null;
  const id = newId("feedback");
  await c.env.DB.prepare("INSERT INTO feedback (id, user_id, workspace_id, kind, message, page, diagnostics, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, auth.userId, auth.workspaceId, body.kind, body.message, body.page ?? null, diagnostics, now)
    .run();
  const to = (c.env.FEEDBACK_TO ?? "").trim();
  if (to) {
    await enqueueEmail(c.env, {
      to,
      template: "feedback",
      data: { id, kind: body.kind, message: body.message, page: body.page ?? null, userId: auth.userId, userEmail: auth.user?.email ?? null, diagnostics },
    }).catch((err: unknown) => console.error(JSON.stringify({ msg: "feedback: email enqueue failed", id, error: String(err) })));
  }
  return c.json({ id, received: true }, 201);
});
