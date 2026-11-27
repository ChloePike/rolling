import { describe, expect, it } from 'vitest';
import { EmailSendError } from './EmailProvider';
import { ResendEmailProvider } from './resend';
import { EMAIL_CATALOG } from './catalog.gen';
import { emailLocale, renderEmail } from './templates';

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

describe('email localization (D-023)', () => {
  it.each([
    [null, 'en'],
    ['ja', 'ja'],
    ['ja-JP', 'ja'],
    ['ko-KR', 'ko'],
    ['zh', 'zh-CN'],
    ['zh-CN', 'zh-CN'],
    ['zh-Hans-HK', 'zh-CN'],
    ['zh-TW', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['zh-Hant', 'zh-TW'],
    ['de', 'en'],
    ['', 'en'],
  ])('locale for %s is %s', (tag, want) => {
    expect(emailLocale(tag)).toBe(want);
  });

  const samples = {
    'sign-in-code': { code: '123456', expiresInMinutes: 10 },
    'workspace-invite': { workspaceName: 'A & B', inviterName: '', role: 'viewer', acceptUrl: 'https://rolling.actor/invite/x', expiresInDays: 1 },
    'change-email-code': { code: '654321', expiresInMinutes: 10 },
    'delete-account-code': { code: '111222', expiresInMinutes: 10 },
    'data-export-ready': { downloadUrl: 'https://rolling.actor/media/x?t=1&a=2', expiresInDays: 7 },
  } as const;

  it.each(Object.keys(EMAIL_CATALOG))('every template renders in %s with no ICU left over', (locale) => {
    for (const [template, data] of Object.entries(samples)) {
      const e = renderEmail(template as keyof typeof samples, data, 'Rolling', 'https://rolling.actor', locale);
      for (const part of [e.subject, e.text, e.html]) expect(part).not.toMatch(/\{|\}|<b>/);
      expect(e.html).toContain(`<html lang="${emailLocale(locale)}">`);
      if ('code' in data) expect(e.text).toContain(data.code);
      if ('acceptUrl' in data) expect(e.text).toContain(data.acceptUrl);
      // Values are escaped in HTML.
      if (template === 'workspace-invite') expect(e.html).toContain('A &amp; B');
    }
  });

  it('falls back to English per key and formats plurals in the locale', () => {
    const saved = EMAIL_CATALOG.ja;
    EMAIL_CATALOG.ja = { 'email.signInCode.expires': '{minutes, plural, other {#分}}で期限切れになります。' };
    try {
      const e = renderEmail('sign-in-code', { code: '123456', expiresInMinutes: 1 }, 'Rolling', undefined, 'ja');
      expect(e.text).toContain('1分で期限切れになります。');
      expect(e.subject).toBe('Your Rolling sign-in code is 123456');
      expect(renderEmail('sign-in-code', { code: '123456', expiresInMinutes: 1 }).text).toContain('It expires in 1 minute.');
    } finally {
      if (saved) EMAIL_CATALOG.ja = saved;
      else delete EMAIL_CATALOG.ja;
    }
  });
});
