/**
 * Provider webhooks (M4). `POST /api/hooks/hyperouter`: Standard Webhooks
 * signature (`HYPEROUTER_WEBHOOK_SECRET`), dedupe on `webhook-id`, then the
 * job's status is fetched (the payload carries only `data.id`, D-002) and sent
 * to its GenerateWorkflow instance as `provider-done`. The workflow also polls,
 * so a missed webhook only delays a job.
 */
import { Hono } from "hono";
import { hyperouter } from "@rolling/core";
import type { AppEnv } from "../env";
import { errorResponse } from "../lib/errors";
import { fetchProviderStatus } from "../runs/jobs";
import { PROVIDER_DONE, type ProviderDoneEvent } from "../workflows/Generate";

export const hooks = new Hono<AppEnv>().post("/hyperouter", async (c) => {
  const secret = c.env.HYPEROUTER_WEBHOOK_SECRET;
  if (!secret) return errorResponse(c, 503, "INTERNAL", "Webhooks are not configured");
  const body = await c.req.text();
  let verified: hyperouter.VerifiedWebhook;
  try {
    verified = await hyperouter.verifyWebhook({ body, headers: c.req.raw.headers, secret });
  } catch (err) {
    if (err instanceof hyperouter.WebhookVerificationError) {
      return errorResponse(c, err.reason === "malformed_payload" ? 400 : 401, "UNAUTHENTICATED", "Invalid webhook signature", { reason: err.reason });
    }
    throw err;
  }
  const { webhookId, event } = verified;
  const seen = await c.env.DB.prepare("SELECT id FROM webhook_events WHERE id = ?").bind(webhookId).first();
  if (seen) return c.json({ ok: true, duplicate: true });

  const externalId = event.data.id;
  const record = () =>
    c.env.DB.prepare("INSERT OR IGNORE INTO webhook_events (id, provider, event_type, external_id, received_at) VALUES (?, 'hyperouter', ?, ?, ?)")
      .bind(webhookId, event.type, externalId, Date.now())
      .run();

  const job = await c.env.DB.prepare("SELECT id, status FROM jobs WHERE provider = 'hyperouter' AND external_id = ?").bind(externalId).first<{ id: string; status: string }>();
  if (!job || !/^(video|image)\./.test(event.type)) {
    await record();
    return c.json({ ok: true, ignored: job ? "event type" : "unknown job" });
  }
  if (job.status === "succeeded" || job.status === "failed" || job.status === "canceled") {
    await record();
    return c.json({ ok: true, ignored: "job finished" });
  }
  // A failure here answers 500 so the gateway retries the delivery.
  const status = await fetchProviderStatus(c.env, event.type, externalId);
  const payload: ProviderDoneEvent = { externalId, status };
  try {
    const instance = await c.env.GENERATE.get(job.id);
    await instance.sendEvent({ type: PROVIDER_DONE, payload });
  } catch (err) {
    console.warn(JSON.stringify({ msg: "hooks: sendEvent failed", jobId: job.id, error: String(err) }));
    return errorResponse(c, 500, "INTERNAL", "Could not deliver the event");
  }
  await record();
  return c.json({ ok: true });
});
