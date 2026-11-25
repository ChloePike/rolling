import { EmailSendError, type EmailMessage, type EmailProvider, type SentEmail } from './EmailProvider';

export interface ResendOptions {
  apiKey: string;
  /** e.g. `Rolling <hello@example.com>`. */
  from: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Resend over its REST API (`POST /emails`). */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ResendOptions) {
    if (!opts.apiKey) throw new Error('ResendEmailProvider: apiKey is required');
    if (!opts.from) throw new Error('ResendEmailProvider: from is required');
    this.baseUrl = (opts.baseUrl ?? 'https://api.resend.com').replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async send(message: EmailMessage): Promise<SentEmail> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.apiKey}`,
      'content-type': 'application/json',
    };
    if (message.idempotencyKey) headers['idempotency-key'] = message.idempotencyKey.slice(0, 256);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          from: this.opts.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(message.template ? { tags: [{ name: 'template', value: message.template.replace(/[^A-Za-z0-9_-]/g, '_') }] } : {}),
        }),
      });
    } catch (err) {
      throw new EmailSendError(`Resend request failed: ${String(err)}`, true);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new EmailSendError(`Resend returned ${res.status}: ${detail.slice(0, 200)}`, res.status === 429 || res.status >= 500, res.status);
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { id: body.id ?? '' };
  }
}
