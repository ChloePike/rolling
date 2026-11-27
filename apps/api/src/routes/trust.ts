/**
 * Trust & safety, user side (D-026, D-028): reports from share pages, public
 * profiles and the abuse form (signed-in or not), appeals from a block or a
 * suspension, DMCA takedown notices and counter-notices, and the caller's own
 * notices and suspension. Everything lands in the admin review queue.
 */
import { Hono } from "hono";
import { z } from "zod";
import { AppealBody, CounterNoticeBody, DmcaNoticeBody, ReportBody, SUSPENDED_MESSAGE } from "@rolling/core/ops/trust";
import type { AppEnv } from "../env";
import { requireUser } from "../auth/context";
import { clientIp, limitOrThrow, sha256Hex } from "../auth/rateLimit";
import { validate } from "../lib/validate";
import { createAppeal, createCounterNotice, createDmcaNotice, createReport } from "../ops/cases";

export const trust = new Hono<AppEnv>()
  .post("/reports", validate("json", ReportBody), async (c) => {
    const auth = c.get("auth");
    await limitOrThrow(c.env.RATE_LIMIT, `report:${auth?.userId ?? (await sha256Hex(clientIp(c.req.raw))).slice(0, 24)}`);
    const body = c.req.valid("json");
    const out = await createReport(c.env, body, { userId: auth?.userId ?? null, email: auth?.user?.email ?? null });
    return c.json(out, 201);
  })
  .post("/appeals", validate("json", AppealBody), async (c) => {
    const auth = requireUser(c);
    await limitOrThrow(c.env.RATE_LIMIT, `appeal:${auth.userId}`);
    const out = await createAppeal(c.env, { userId: auth.userId, workspaceId: auth.workspaceId, email: auth.user?.email ?? null }, c.req.valid("json"));
    return c.json(out, 201);
  })
  .post("/dmca", validate("json", DmcaNoticeBody), async (c) => {
    await limitOrThrow(c.env.RATE_LIMIT, `dmca:${(await sha256Hex(clientIp(c.req.raw))).slice(0, 24)}`);
    return c.json(await createDmcaNotice(c.env, c.req.valid("json")), 201);
  })
  .post("/counter-notices", validate("json", CounterNoticeBody), async (c) => {
    const auth = requireUser(c);
    await limitOrThrow(c.env.RATE_LIMIT, `counter:${auth.userId}`);
    return c.json(await createCounterNotice(c.env, { userId: auth.userId, workspaceId: auth.workspaceId }, c.req.valid("json")), 201);
  })
  /** The caller's suspension (if any) and unread notices, for the in-app banner. */
  .get("/me", async (c) => {
    const auth = requireUser(c);
    const notices = await c.env.DB.prepare("SELECT id, kind, message, case_id, created_at FROM user_notices WHERE user_id = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT 10")
      .bind(auth.userId)
      .all<{ id: string; kind: string; message: string; case_id: string | null; created_at: number }>();
    c.header("cache-control", "no-store");
    return c.json({
      suspension: auth.suspension ? { id: auth.suspension.id, scope: auth.suspension.scope, since: auth.suspension.since, message: SUSPENDED_MESSAGE } : null,
      notices: notices.results.map((n) => ({ id: n.id, kind: n.kind, message: n.message, caseId: n.case_id, createdAt: n.created_at })),
    });
  })
  .post("/notices/:id/read", validate("param", z.object({ id: z.string().min(1).max(80) })), async (c) => {
    const auth = requireUser(c);
    await c.env.DB.prepare("UPDATE user_notices SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL").bind(Date.now(), c.req.valid("param").id, auth.userId).run();
    return c.json({ ok: true });
  });
