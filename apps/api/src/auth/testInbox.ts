/**
 * `test-inbox` email provider (EMAIL_PROVIDER=test-inbox): stores messages in D1
 * (`test_inbox`, 24 h TTL) instead of sending, so end-to-end sign-up tests on
 * staging can read the code from `GET /api/test/inbox`. Refused in production.
 */
import type { EmailMessage, EmailProvider, SentEmail } from "@rolling/core/email/EmailProvider";
import { newId } from "@rolling/core/ids";

export const TEST_INBOX_TTL_MS = 24 * 3_600_000;

export class TestInboxEmailProvider implements EmailProvider {
  readonly name = "test-inbox";
  constructor(private readonly db: D1Database) {}

  async send(message: EmailMessage): Promise<SentEmail> {
    const id = newId("event");
    const now = Date.now();
    const code = typeof message.data?.code === "string" ? message.data.code : null;
    await this.db.batch([
      this.db.prepare("DELETE FROM test_inbox WHERE sent_at < ?1").bind(now - TEST_INBOX_TTL_MS),
      this.db
        .prepare("INSERT INTO test_inbox (id, to_email, subject, text, code, template, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
        .bind(id, message.to.toLowerCase(), message.subject, message.text, code, message.template ?? null, now),
    ]);
    return { id };
  }
}

export interface TestInboxMessage {
  to: string;
  subject: string;
  text: string;
  code: string | null;
  template: string | null;
  sentAt: number;
}

/** Latest messages to `to` (newest first) within the TTL. */
export async function readTestInbox(db: D1Database, to: string, limit = 10): Promise<TestInboxMessage[]> {
  const now = Date.now();
  await db.prepare("DELETE FROM test_inbox WHERE sent_at < ?1").bind(now - TEST_INBOX_TTL_MS).run();
  const { results } = await db
    .prepare("SELECT to_email, subject, text, code, template, sent_at FROM test_inbox WHERE to_email = ?1 ORDER BY sent_at DESC, id DESC LIMIT ?2")
    .bind(to.toLowerCase(), limit)
    .all<{ to_email: string; subject: string; text: string; code: string | null; template: string | null; sent_at: number }>();
  return results.map((r) => ({ to: r.to_email, subject: r.subject, text: r.text, code: r.code, template: r.template, sentAt: r.sent_at }));
}
