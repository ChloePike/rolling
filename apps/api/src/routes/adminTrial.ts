/**
 * `POST /api/admin/trial { email }` (D-022): grants the one-time trial to a user
 * who has none (signed up before the trial, or denied by a soft check). Once
 * per workspace; no anti-abuse checks. 404 unless the `ADMIN_TOKEN` secret is
 * set; 401 without `authorization: Bearer <ADMIN_TOKEN>`.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { adminGrantTrial } from "../auth/trial";
import { creditAccount } from "../billing/credits";
import { ApiError } from "../lib/errors";
import { validate } from "../lib/validate";
import { testTokenMatches } from "./testInbox";

export const adminTrial = new Hono<AppEnv>().post(
  "/trial",
  async (c, next) => {
    const expected = c.env.ADMIN_TOKEN;
    if (!expected) throw new ApiError(404, "NOT_FOUND", "Route not found", { path: c.req.path });
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token || !(await testTokenMatches(token, expected))) throw new ApiError(401, "UNAUTHENTICATED", "Invalid admin token");
    return next();
  },
  validate("json", z.object({ email: z.string().trim().toLowerCase().email() })),
  async (c) => {
    const { email } = c.req.valid("json");
    const user = await c.env.DB.prepare("SELECT id FROM users WHERE lower(email) = ?1").bind(email).first<{ id: string }>();
    if (!user) throw new ApiError(404, "NOT_FOUND", "No account with that email", { email });
    const out = await adminGrantTrial(c.env, user.id);
    console.log(JSON.stringify({ msg: "admin: trial grant", userId: user.id, status: out.status }));
    c.header("cache-control", "no-store");
    return c.json({ email, ...out, balance: await creditAccount(c.env, out.workspaceId).balance() });
  },
);
