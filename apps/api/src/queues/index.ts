/**
 * Queue consumers. Queue names are `rolling-<env>-<base>` (e.g.
 * `rolling-staging-media-process`), so dispatch is by base name. M0 stubs: validate, log, ack.
 */
import { z } from "zod";

export const MediaProcessMessage = z.object({ assetId: z.string(), r2Key: z.string(), kind: z.string() });
export const LedgerMirrorMessage = z.object({ workspaceId: z.string(), lineIds: z.array(z.string()) });
export const NotifyEmailMessage = z.object({ userId: z.string(), template: z.string(), data: z.record(z.unknown()).default({}) });

type Handler = (batch: MessageBatch<unknown>, env: Env) => Promise<void>;

function stubConsumer(name: string, schema: z.ZodTypeAny): Handler {
  return async (batch) => {
    for (const msg of batch.messages) {
      const parsed = schema.safeParse(msg.body);
      if (!parsed.success) {
        // Malformed messages are dropped (acked) so they do not poison the queue.
        console.warn(JSON.stringify({ queue: name, msg: "invalid message dropped", id: msg.id }));
        msg.ack();
        continue;
      }
      // TODO: real processing (media-process: M3, ledger-mirror: M2, notify-email: M8).
      msg.ack();
    }
  };
}

export const queueHandlers: Record<string, Handler> = {
  "media-process": stubConsumer("media-process", MediaProcessMessage),
  "ledger-mirror": stubConsumer("ledger-mirror", LedgerMirrorMessage),
  "notify-email": stubConsumer("notify-email", NotifyEmailMessage),
};

export function baseQueueName(queue: string): string {
  return queue.replace(/^rolling-[a-z0-9]+-/, "");
}

export async function handleQueue(batch: MessageBatch<unknown>, env: Env, _ctx?: ExecutionContext): Promise<void> {
  const handler = queueHandlers[baseQueueName(batch.queue)];
  if (!handler) {
    console.error(JSON.stringify({ msg: "no consumer for queue", queue: batch.queue }));
    batch.retryAll();
    return;
  }
  await handler(batch, env);
}
