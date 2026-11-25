import type { EmailMessage, EmailProvider, SentEmail } from './EmailProvider';

/**
 * Development and test provider: keeps messages in memory (per isolate) instead
 * of sending. `log: true` also prints recipient, subject and text (development
 * only, so the sign-in code can be read from the console).
 */
export class RecordingEmailProvider implements EmailProvider {
  readonly name = 'recording';
  static readonly outbox: (EmailMessage & { id: string; sentAt: number })[] = [];
  private static seq = 0;

  constructor(private readonly opts: { log?: boolean } = {}) {}

  async send(message: EmailMessage): Promise<SentEmail> {
    const id = `dev_${++RecordingEmailProvider.seq}`;
    RecordingEmailProvider.outbox.push({ ...message, id, sentAt: Date.now() });
    if (this.opts.log) {
      console.log(JSON.stringify({ msg: 'email (dev, not sent)', to: message.to, subject: message.subject, text: message.text }));
    }
    return { id };
  }

  /** Messages to one address, oldest first. */
  static to(address: string): (EmailMessage & { id: string; sentAt: number })[] {
    const a = address.toLowerCase();
    return RecordingEmailProvider.outbox.filter((m) => m.to.toLowerCase() === a);
  }

  static clear(): void {
    RecordingEmailProvider.outbox.length = 0;
  }
}
