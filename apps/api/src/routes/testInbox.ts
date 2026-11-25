/**
 * `GET /api/test/inbox?to=<email>` — latest messages stored by the `test-inbox`
 * email provider, for end-to-end sign-up tests on staging. 404 unless
 * EMAIL_PROVIDER=test-inbox (never in production) and TEST_INBOX_TOKEN is set;
 * 401 without the right `authorization: Bearer <TEST_INBOX_TOKEN>`.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/errors";
import { validate } from "../lib/validate";
import { readTestInbox } from "../auth/testInbox";

const InboxQuery = z.object({
  to: z.string().trim().toLowerCase().email().max(254),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

/** Constant-time comparison (hashing first makes the lengths equal). */
async function tokenMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = (await Promise.all([digest(given), digest(expected)])).map((d) => new Uint8Array(d)) as [Uint8Array, Uint8Array];
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function testInboxEnabled(env: Env): boolean {
  return env.ENVIRONMENT !== "production" && (env.EMAIL_PROVIDER ?? "").trim() === "test-inbox" && !!env.TEST_INBOX_TOKEN;
}

export const testInbox = new Hono<AppEnv>().get("/inbox", async (c, next) => {
  if (!testInboxEnabled(c.env)) throw new ApiError(404, "NOT_FOUND", "Route not found", { path: c.req.path });
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !(await tokenMatches(token, c.env.TEST_INBOX_TOKEN!))) {
    throw new ApiError(401, "UNAUTHENTICATED", "Invalid test inbox token");
  }
  return next();
}, validate("query", InboxQuery), async (c) => {
  const { to, limit } = c.req.valid("query");
  c.header("cache-control", "no-store");
  return c.json({ messages: await readTestInbox(c.env.DB, to, limit) });
});
