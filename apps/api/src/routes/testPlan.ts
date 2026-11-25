/**
 * `POST /api/test/plan` — staging-only: give the caller's workspace an active
 * plan without Stripe, so end-to-end tests can exercise members-only flows
 * (agent, generation). Same gate as the test inbox: 404 unless the test inbox is
 * enabled (never in production), 401 without `authorization: Bearer
 * <TEST_INBOX_TOKEN>`. Requires a signed-in caller (session cookie); acts on the
 * caller's active workspace only.
 *
 * Body: `{ planId, interval?, seats?, extraCredits? }`. Writes a `subscriptions`
 * row with a `test_` id and grants the period's plan credits through
 * CreditAccount like `invoice.paid` would; `extraCredits` adds purchased credits.
 */
import { Hono } from "hono";
import { z } from "zod";
import { PLAN_ORDER } from "@rolling/core";
import type { AppEnv } from "../env";
import { requireUser } from "../auth/context";
import { upsertSubscription } from "../billing/stripe";
import { creditAccount, unwrapLedger } from "../billing/credits";
import { ApiError } from "../lib/errors";
import { validate } from "../lib/validate";
import { testInboxEnabled, testTokenMatches } from "./testInbox";

const Body = z.object({
  planId: z.enum(PLAN_ORDER as unknown as [string, ...string[]]),
  interval: z.enum(["month", "year"]).default("month"),
  seats: z.number().int().min(1).max(200).default(1),
  extraCredits: z.number().int().min(0).max(1_000_000).default(0),
});

const DAY = 24 * 60 * 60 * 1000;

export const testPlan = new Hono<AppEnv>().post(
  "/plan",
  async (c, next) => {
    if (!testInboxEnabled(c.env)) throw new ApiError(404, "NOT_FOUND", "Route not found", { path: c.req.path });
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token || !(await testTokenMatches(token, c.env.TEST_INBOX_TOKEN!))) {
      throw new ApiError(401, "UNAUTHENTICATED", "Invalid test token");
    }
    return next();
  },
  validate("json", Body),
  async (c) => {
    const auth = requireUser(c);
    const { planId, interval, seats, extraCredits } = c.req.valid("json");
    const now = Date.now();
    const periodStart = now;
    const periodEnd = now + (interval === "year" ? 365 : 30) * DAY;
    const subId = `test_${auth.workspaceId}`;
    await upsertSubscription(c.env, {
      id: subId,
      workspaceId: auth.workspaceId,
      planId: planId as (typeof PLAN_ORDER)[number],
      interval,
      status: "active",
      periodStart,
      periodEnd,
      cancelAtPeriodEnd: false,
      priceId: `test_${planId}_${interval}`,
      seats: planId === "team" ? seats : 1,
      baseItemId: `test_base_${planId}`,
      seatItemId: planId === "team" ? `test_seat_${planId}` : null,
    });
    const account = creditAccount(c.env, auth.workspaceId);
    unwrapLedger(
      await account.grant(
        { planId: planId as (typeof PLAN_ORDER)[number], interval, start: periodStart, end: periodEnd, ...(planId === "team" ? { seats } : {}) },
        `test-grant:${subId}:${periodStart}`,
      ),
    );
    if (extraCredits > 0) unwrapLedger(await account.purchase(extraCredits, `test_${now}`, `test-purchase:${subId}:${now}`));
    const balance = await account.balance();
    c.header("cache-control", "no-store");
    return c.json({ subscriptionId: subId, planId, interval, seats, periodEnd, balance });
  },
);
