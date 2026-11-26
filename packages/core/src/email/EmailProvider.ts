/**
 * Outgoing email. Implementations: `CloudflareEmailProvider` (production), `ResendEmailProvider` (fallback) and
 * `RecordingEmailProvider` (development and tests). Callers enqueue through the
 * `notify-email` queue; only its consumer calls a provider.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Provider idempotency key (e.g. the queue message id). */
  idempotencyKey?: string;
  /** Template id, for logs and tags. */
  template?: string;
  /** Template data (not sent; the test inbox keeps `code` from it). */
  data?: Record<string, unknown>;
}

export interface SentEmail {
  /** Provider message id. */
  id: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<SentEmail>;
}

export class EmailSendError extends Error {
  constructor(
    message: string,
    /** True when retrying may succeed (network, 429, 5xx). */
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}
