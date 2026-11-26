/**
 * Email delivery: producers enqueue on `notify-email`; the queue consumer renders
 * the template and sends through the configured provider.
 */
import { z } from "zod";
import { RecordingEmailProvider } from "@rolling/core/email/recording";
import { ResendEmailProvider } from "@rolling/core/email/resend";
import { TestInboxEmailProvider } from "./testInbox";
import { EmailSendError, type EmailProvider } from "@rolling/core/email/EmailProvider";
import { isEmailTemplateId, renderEmail, type EmailTemplateData, type EmailTemplateId } from "@rolling/core/email/templates";

/** `notify-email` queue message. `to` or `userId` (resolved from `users.email`) is required. */
export const NotifyEmailMessage = z
  .object({
    to: z.string().email().optional(),
    userId: z.string().optional(),
    template: z.string().min(1),
    data: z.record(z.unknown()).default({}),
  })
  .refine((m) => m.to || m.userId, { message: "to or userId is required" });
export type NotifyEmailMessage = z.infer<typeof NotifyEmailMessage>;

export async function enqueueEmail<T extends EmailTemplateId>(
  env: Env,
  message: { to?: string; userId?: string; template: T; data: EmailTemplateData<T> },
): Promise<void> {
  await env.NOTIFY_EMAIL_QUEUE.send(message, { contentType: "json" });
}

let override: EmailProvider | null = null;

/** Test seam: force a provider (null restores the env-based choice). */
export function setEmailProviderForTests(provider: EmailProvider | null): void {
  override = provider;
}

export type EmailProviderName = "resend" | "recording" | "test-inbox";

/**
 * The configured provider name. `EMAIL_PROVIDER` picks one explicitly; empty means
 * Resend when `RESEND_API_KEY` is set, else (development only) the recording provider.
 * Throws for an unknown name and for `test-inbox` / `recording` in production.
 */
export function emailProviderName(env: Env): EmailProviderName {
  const raw = (env.EMAIL_PROVIDER ?? "").trim();
  let name: EmailProviderName | null = null;
  if (raw === "resend" || raw === "recording" || raw === "test-inbox") name = raw;
  else if (raw === "") name = env.RESEND_API_KEY ? "resend" : env.ENVIRONMENT === "development" ? "recording" : null;
  if (!name) throw new Error(raw ? `EMAIL_PROVIDER "${raw}" is not supported` : "RESEND_API_KEY is not set");
  if (env.ENVIRONMENT === "production" && name !== "resend") {
    throw new Error(`EMAIL_PROVIDER "${name}" is refused in production`);
  }
  return name;
}

/**
 * The provider for `emailProviderName(env)`. The recording provider also logs
 * messages in development so the sign-in code is visible in the console.
 */
export function emailProvider(env: Env): EmailProvider {
  if (override) return override;
  const name = emailProviderName(env);
  if (name === "test-inbox") return new TestInboxEmailProvider(env.DB);
  if (name === "resend") {
    if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
    return new ResendEmailProvider({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM || "Rolling <onboarding@resend.dev>" });
  }
  return new RecordingEmailProvider({ log: env.ENVIRONMENT === "development" && env.EMAIL_LOG !== "off" });
}

/**
 * `notify-email` consumer: validate, render, send. Invalid messages (bad shape,
 * unknown template, bad data, unknown user) are acked and logged; retryable
 * provider errors retry with backoff, then go to the dead-letter queue.
 */
export async function handleNotifyEmail(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const provider = emailProvider(env);
  for (const msg of batch.messages) {
    const parsed = NotifyEmailMessage.safeParse(msg.body);
    if (!parsed.success || !isEmailTemplateId(parsed.data.template)) {
      console.warn(JSON.stringify({ queue: "notify-email", msg: "invalid message dropped", id: msg.id }));
      msg.ack();
      continue;
    }
    const { template, data, userId } = parsed.data;
    let to = parsed.data.to;
    try {
      if (!to && userId) {
        const row = await env.DB.prepare("SELECT email FROM users WHERE id = ?1").bind(userId).first<{ email: string }>();
        to = row?.email;
      }
      if (!to) {
        console.warn(JSON.stringify({ queue: "notify-email", msg: "no recipient, dropped", id: msg.id, template }));
        msg.ack();
        continue;
      }
      let rendered;
      try {
        rendered = renderEmail(template, data, env.APP_NAME || "Rolling", env.PUBLIC_APP_URL || undefined);
      } catch {
        console.warn(JSON.stringify({ queue: "notify-email", msg: "template data invalid, dropped", id: msg.id, template }));
        msg.ack();
        continue;
      }
      await provider.send({ to, ...rendered, template, data, idempotencyKey: `email:${msg.id}` });
      msg.ack();
    } catch (err) {
      const retryable = !(err instanceof EmailSendError) || err.retryable;
      console.error(JSON.stringify({ queue: "notify-email", msg: "send failed", id: msg.id, template, retryable, error: String(err).slice(0, 300) }));
      if (retryable) msg.retry({ delaySeconds: Math.min(300, 10 * 2 ** Math.max(0, msg.attempts - 1)) });
      else msg.ack();
    }
  }
}
