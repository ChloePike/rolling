import { EmailSendError, type EmailMessage, type EmailProvider, type SentEmail } from './EmailProvider';

/**
 * The part of the Workers `send_email` binding (Cloudflare Email Service) this provider uses.
 * Declared here so `packages/core` does not depend on Workers types.
 */
export interface SendEmailBinding {
  send(message: {
    from: string | { email: string; name: string };
    to: string | { email: string; name: string };
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string | { email: string; name: string };
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export interface CloudflareEmailOptions {
  binding: SendEmailBinding;
  /** `Rolling <no-reply@rolling.actor>` or a bare address. */
  from: string;
  replyTo?: string;
}

/** Email Service error codes worth retrying (rate limits, onboarding in progress, transient delivery). */
const RETRYABLE_CODES = new Set([
  'E_RATE_LIMIT_EXCEEDED',
  'E_DAILY_LIMIT_EXCEEDED',
  'E_INTERNAL_SERVER_ERROR',
  'E_EMAIL_SENDING_NOT_READY',
  'E_DELIVERY_FAILED',
]);

/** Parses `Name <addr@host>` into the binding's address object; a bare address stays a string. */
export function parseAddress(value: string): string | { email: string; name: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
  if (!m) return value.trim();
  const name = m[1]!.trim();
  return name ? { email: m[2]!, name } : m[2]!;
}

/** Cloudflare Email Service through the Workers `send_email` binding (`env.EMAIL.send`). */
export class CloudflareEmailProvider implements EmailProvider {
  readonly name = 'cloudflare';
  private readonly from: string | { email: string; name: string };
  private readonly replyTo?: string | { email: string; name: string };

  constructor(private readonly opts: CloudflareEmailOptions) {
    if (!opts.binding) throw new Error('CloudflareEmailProvider: binding is required');
    if (!opts.from) throw new Error('CloudflareEmailProvider: from is required');
    this.from = parseAddress(opts.from);
    this.replyTo = opts.replyTo ? parseAddress(opts.replyTo) : undefined;
  }

  async send(message: EmailMessage): Promise<SentEmail> {
    try {
      const res = await this.opts.binding.send({
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(this.replyTo ? { replyTo: this.replyTo } : {}),
      });
      return { id: res?.messageId ?? '' };
    } catch (err) {
      // A malformed argument throws a TypeError without a code: our bug, not retryable.
      const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : null;
      const detail = err instanceof Error ? err.message : String(err);
      const retryable = code ? RETRYABLE_CODES.has(code) : !(err instanceof TypeError);
      throw new EmailSendError(`Cloudflare Email Service ${code ?? 'error'}: ${detail.slice(0, 200)}`, retryable);
    }
  }
}
