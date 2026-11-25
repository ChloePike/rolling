/**
 * `POST /api/stripe/webhook`. Verifies the `Stripe-Signature` header over the
 * raw body (WebCrypto, `constructEventAsync` equivalent, 5-minute tolerance),
 * skips events already in `stripe_events`, applies the event, then records it.
 * A failure answers 500 so Stripe redelivers; every effect is idempotent.
 */
import { Hono } from "hono";
import { StripeSignatureError, verifyStripeSignature } from "@rolling/core/billing";
import type { AppEnv } from "../env";
import { stripeFor } from "../billing/stripe";
import { handleStripeEvent } from "../billing/webhook";
import { ApiError } from "../lib/errors";

export const stripeWebhook = new Hono<AppEnv>().post("/webhook", async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new ApiError(503, "INTERNAL", "Payments are not configured");
  const payload = await c.req.text();
  let event;
  try {
    event = await verifyStripeSignature(payload, c.req.header("stripe-signature"), secret);
  } catch (e) {
    if (e instanceof StripeSignatureError) throw new ApiError(400, "BAD_REQUEST", "Invalid Stripe signature", { reason: e.reason });
    throw e;
  }
  const seen = await c.env.DB.prepare("SELECT id FROM stripe_events WHERE id = ?").bind(event.id).first();
  if (seen) return c.json({ received: true, duplicate: true });

  const outcome = await handleStripeEvent(c.env, stripeFor(c.env), event);
  await c.env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, type, processed_at) VALUES (?, ?, ?)").bind(event.id, event.type, Date.now()).run();
  console.log(JSON.stringify({ msg: "stripe: event processed", id: event.id, type: event.type, ...outcome }));
  return c.json({ received: true, handled: outcome.handled });
});
