import { describe, expect, it } from 'vitest';
import { EmailSendError } from './EmailProvider';
import { ResendEmailProvider } from './resend';
import { renderEmail } from './templates';

describe('email templates', () => {
  it('renders the sign-in code (plain, sentence case)', () => {
    const e = renderEmail('sign-in-code', { code: '123456', expiresInMinutes: 10 });
    expect(e.subject).toBe('Your Rolling sign-in code is 123456');
    expect(e.text).toBe("Your sign-in code is 123456.\n\nIt expires in 10 minutes.\n\nIf you didn't try to sign in to Rolling, you can ignore this email.");
    expect(e.html).toContain('123456');
  });

  it('escapes HTML in invite data and validates input', () => {
    const e = renderEmail('workspace-invite', {
      workspaceName: '<b>Acme</b>',
      inviterName: 'Ada',
      role: 'viewer',
      acceptUrl: 'https://example.com/invite/abc',
      expiresInDays: 7,
    });
    expect(e.subject).toBe('Ada invited you to <b>Acme</b> on Rolling');
    expect(e.html).toContain('&lt;b&gt;Acme&lt;/b&gt;');
    expect(e.text).toContain('as a viewer');
    expect(() => renderEmail('sign-in-code', { code: 'abc', expiresInMinutes: 10 })).toThrow();
  });

  it('renders the email-change and account-deletion codes and escapes feedback', () => {
    expect(renderEmail('change-email-code', { code: '654321', expiresInMinutes: 10 }).text).toContain('654321');
    expect(renderEmail('delete-account-code', { code: '111222', expiresInMinutes: 10 }).subject).toBe('Your Rolling account deletion code is 111222');
    const f = renderEmail('feedback', { id: 'fbk_1', kind: 'bug', message: '<script>x</script> broke', page: '/home', userId: 'usr_1', userEmail: 'a@b.c', diagnostics: null });
    expect(f.subject).toBe('[Rolling feedback] bug: <script>x</script> broke');
    expect(f.html).toContain('&lt;script&gt;');
    expect(f.text).toContain('Page: /home');
  });
});

describe('legal footer', () => {
  it('renders the data export link and validates the URL', () => {
    const e = renderEmail('data-export-ready', { downloadUrl: 'https://rolling.actor/media/x?t=1&a=2', expiresInDays: 7 });
    expect(e.subject).toBe('Your Rolling data export is ready');
    expect(e.text).toContain('https://rolling.actor/media/x?t=1&a=2');
    expect(e.text).toContain('7 days');
    expect(e.html).toContain('href="https://rolling.actor/media/x?t=1&amp;a=2"');
    expect(() => renderEmail('data-export-ready', { downloadUrl: 'nope', expiresInDays: 7 })).toThrow();
  });

  it('links /terms and /privacy on user emails when the app URL is known; never on feedback', () => {
    const e = renderEmail('sign-in-code', { code: '123456', expiresInMinutes: 10 }, 'Rolling', 'https://rolling.actor/');
    expect(e.text).toContain('Terms: https://rolling.actor/terms · Privacy Policy: https://rolling.actor/privacy');
    expect(e.html).toContain('<a href="https://rolling.actor/terms"');
    expect(e.html).toContain('<a href="https://rolling.actor/privacy"');
    expect(e.html.endsWith('</body></html>')).toBe(true);
    expect(renderEmail('sign-in-code', { code: '123456', expiresInMinutes: 10 }).text).not.toContain('/terms');
    const f = renderEmail('feedback', { id: 'fbk_1', kind: 'bug', message: 'x', page: null, userId: null, userEmail: null, diagnostics: null }, 'Rolling', 'https://rolling.actor');
    expect(f.text).not.toContain('/terms');
  });
});

describe('ResendEmailProvider', () => {
  it('maps errors to retryable or not', async () => {
    for (const [status, retryable] of [[429, true], [500, true], [422, false]] as const) {
      const p = new ResendEmailProvider({ apiKey: 'k', from: 'a@b.c', fetch: (async () => new Response('x', { status })) as unknown as typeof fetch });
      const err = await p.send({ to: 'x@y.z', subject: 's', text: 't', html: 'h' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmailSendError);
      expect((err as EmailSendError).retryable).toBe(retryable);
    }
  });
});

describe('CloudflareEmailProvider', () => {
  it('parses display-name senders for the binding', async () => {
    const { parseAddress } = await import('./cloudflare');
    expect(parseAddress('Rolling <no-reply@rolling.actor>')).toEqual({ email: 'no-reply@rolling.actor', name: 'Rolling' });
    expect(parseAddress('"Rolling Team" <a@b.co>')).toEqual({ email: 'a@b.co', name: 'Rolling Team' });
    expect(parseAddress('<a@b.co>')).toBe('a@b.co');
    expect(parseAddress(' a@b.co ')).toBe('a@b.co');
  });
});
