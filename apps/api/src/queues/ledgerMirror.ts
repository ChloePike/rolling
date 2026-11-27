/**
 * `ledger-mirror` consumer: copies CreditAccount ledger lines into D1
 * `ledger_lines` for Activity, invoices and GraphQL `ledger`. Idempotent:
 * line ids are primary keys (`INSERT OR IGNORE`), so redelivered messages and
 * outbox re-sends are harmless. A D1 failure retries the message.
 */
import { z } from "zod";

const Line = z.object({
  id: z.string().min(1),
  kind: z.enum(["grant", "purchase", "hold", "settle", "release", "refund", "expire", "adjust"]),
  bucket: z.enum(["plan", "purchased", "trial"]),
  amount: z.number().int(),
  userId: z.string().nullable(),
  runId: z.string().nullable(),
  jobId: z.string().nullable(),
  stripeRef: z.string().nullable(),
  note: z.string().nullable().optional(),
  createdAt: z.number().int(),
});

export const LedgerMirrorMessage = z.object({ workspaceId: z.string().min(1), lines: z.array(Line).max(500) });
export type LedgerMirrorMessage = z.infer<typeof LedgerMirrorMessage>;

export async function writeLedgerLines(env: Env, msg: LedgerMirrorMessage): Promise<void> {
  if (msg.lines.length === 0) return;
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO ledger_lines (id, workspace_id, user_id, kind, bucket, amount, run_id, job_id, stripe_ref, created_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await env.DB.batch(
    msg.lines.map((l) => stmt.bind(l.id, msg.workspaceId, l.userId, l.kind, l.bucket, l.amount, l.runId, l.jobId, l.stripeRef, l.createdAt, l.note ?? null)),
  );
}

export async function handleLedgerMirror(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const parsed = LedgerMirrorMessage.safeParse(msg.body);
    if (!parsed.success) {
      console.error(JSON.stringify({ queue: "ledger-mirror", msg: "invalid message dropped", id: msg.id }));
      msg.ack();
      continue;
    }
    try {
      await writeLedgerLines(env, parsed.data);
      msg.ack();
    } catch (e) {
      console.error(JSON.stringify({ queue: "ledger-mirror", msg: "write failed, retrying", id: msg.id, error: String(e) }));
      msg.retry({ delaySeconds: Math.min(60, 2 ** msg.attempts) });
    }
  }
}
