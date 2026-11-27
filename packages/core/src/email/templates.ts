import { IntlMessageFormat } from 'intl-messageformat';
import { z } from 'zod';
import { EMAIL_CATALOG } from './catalog.gen';

/**
 * Email templates: plain, short, sentence case, in the recipient's language (D-023; strings in
 * `messages/<locale>/email.json`, inlined by `scripts/gen-email-catalog.mjs`). Each template has a
 * Zod schema for its data so queue messages are validated before rendering.
 */
export const EmailTemplates = {
  'sign-in-code': z.object({ code: z.string().regex(/^\d{4,10}$/), expiresInMinutes: z.number().int().positive() }),
  'workspace-invite': z.object({
    workspaceName: z.string().min(1).max(200),
    inviterName: z.string().max(200),
    role: z.enum(['editor', 'viewer']),
    acceptUrl: z.string().url(),
    expiresInDays: z.number().int().positive(),
  }),
  /** Email change (Better Auth email OTP `change-email`): sent to the new address. */
  'change-email-code': z.object({ code: z.string().regex(/^\d{4,10}$/), expiresInMinutes: z.number().int().positive() }),
  /** Account deletion confirmation code: sent to the account's address. */
  'delete-account-code': z.object({ code: z.string().regex(/^\d{4,10}$/), expiresInMinutes: z.number().int().positive() }),
  /** Settings → Account → Export my data: the bundle is ready (signed link, `DATA_EXPORT_LINK_TTL_DAYS`). */
  'data-export-ready': z.object({ downloadUrl: z.string().url(), expiresInDays: z.number().int().positive() }),
  /** Help → Send feedback, forwarded to `FEEDBACK_TO`. */
  feedback: z.object({
    id: z.string().min(1).max(80),
    kind: z.enum(['bug', 'idea', 'other']),
    message: z.string().min(1).max(5000),
    page: z.string().max(500).nullable(),
    userId: z.string().max(80).nullable(),
    userEmail: z.string().max(254).nullable(),
    diagnostics: z.string().max(4000).nullable(),
  }),
} as const;

export type EmailTemplateId = keyof typeof EmailTemplates;
export type EmailTemplateData<T extends EmailTemplateId> = z.infer<(typeof EmailTemplates)[T]>;

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function isEmailTemplateId(v: string): v is EmailTemplateId {
  return Object.prototype.hasOwnProperty.call(EmailTemplates, v);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Wraps paragraphs in a minimal HTML body (no images, no tracking). */
function html(paragraphs: string[]): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join('');
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${body}</body></html>`;
}

/** Locales with email translations (D-023); others fall back to English. */
export const EMAIL_LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];

/**
 * The email locale for a saved language preference or an Accept-Language tag: Chinese by script
 * then region (Hant, TW, HK, MO → zh-TW; else zh-CN), else the base language, else English.
 */
export function emailLocale(tag: string | null | undefined): EmailLocale {
  if (!tag) return 'en';
  const parts = tag.trim().split(/[-_]/);
  const lang = (parts[0] ?? '').toLowerCase();
  if (lang === 'zh') {
    const rest = parts.slice(1);
    const script = rest.find((p) => /^[A-Za-z]{4}$/.test(p))?.toLowerCase();
    const region = rest.find((p) => /^[A-Za-z]{2}$/.test(p))?.toUpperCase();
    if (script) return script === 'hant' ? 'zh-TW' : 'zh-CN';
    return region === 'TW' || region === 'HK' || region === 'MO' ? 'zh-TW' : 'zh-CN';
  }
  return lang === 'ja' || lang === 'ko' ? lang : 'en';
}

type Values = Record<string, string | number>;
const CODE_STYLE = 'font-size:20px;letter-spacing:2px';
const formatters = new Map<string, IntlMessageFormat>();

/**
 * One email string in `locale`, English per missing key. `mode: 'html'` escapes the values and
 * turns `<b>` into the styled code; `'text'` drops the tags. Message literals are our own copy.
 */
function msg(locale: EmailLocale, id: string, values: Values, mode: 'text' | 'html'): string {
  const own = EMAIL_CATALOG[locale]?.[id];
  const source = own ?? EMAIL_CATALOG.en?.[id];
  if (source === undefined) throw new Error(`Missing email message ${id}`);
  const useLocale = own === undefined ? 'en' : locale;
  const cacheKey = `${useLocale}\u0000${source}`;
  let f = formatters.get(cacheKey);
  if (!f) {
    f = new IntlMessageFormat(source, useLocale);
    formatters.set(cacheKey, f);
  }
  const vals: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) vals[k] = mode === 'html' && typeof v === 'string' ? escapeHtml(v) : v;
  vals.b = (chunks: unknown[]) => (mode === 'html' ? `<strong style="${CODE_STYLE}">${chunks.join('')}</strong>` : chunks.join(''));
  const out = f.format(vals);
  return Array.isArray(out) ? out.join('') : String(out);
}

/**
 * Renders a template. Throws a ZodError when `data` does not match the template's schema.
 * With `appUrl` (the app's public origin, e.g. `https://rolling.actor`), emails to users end
 * with links to the Terms and Privacy Policy (`/terms`, `/privacy`); internal ones (feedback) do not.
 * `locale` is the recipient's language preference (D-023, `emailLocale`); feedback stays English.
 */
export function renderEmail<T extends EmailTemplateId>(template: T, data: unknown, appName = 'Rolling', appUrl?: string, locale?: string | null): RenderedEmail {
  const lc = emailLocale(locale);
  const email = renderBody(template, data, appName, lc);
  const origin = appUrl?.replace(/\/+$/, '');
  if (!origin || template === 'feedback') return email;
  const terms = `${origin}/terms`;
  const privacy = `${origin}/privacy`;
  const termsLabel = msg(lc, 'email.footer.terms', {}, 'text');
  const privacyLabel = msg(lc, 'email.footer.privacy', {}, 'text');
  const footer = `<p style="margin:24px 0 0;font-size:12px;color:#666">${escapeHtml(appName)} · <a href="${escapeHtml(terms)}" style="color:#666">${escapeHtml(termsLabel)}</a> · <a href="${escapeHtml(privacy)}" style="color:#666">${escapeHtml(privacyLabel)}</a></p>`;
  return {
    subject: email.subject,
    text: `${email.text}\n\n--\n${appName} · ${termsLabel}: ${terms} · ${privacyLabel}: ${privacy}`,
    html: email.html.replace('</body></html>', `${footer}</body></html>`),
  };
}

/** Subject plus paragraphs; the text and HTML bodies come from the same messages. */
function localized(lc: EmailLocale, subject: [string, Values], paragraphs: ([string, Values] | { text: string; html: string })[]): RenderedEmail {
  const part = (p: [string, Values] | { text: string; html: string }, mode: 'text' | 'html') => (Array.isArray(p) ? msg(lc, p[0], p[1], mode) : p[mode]);
  return {
    subject: msg(lc, subject[0], subject[1], 'text'),
    text: paragraphs.map((p) => part(p, 'text')).join('\n\n'),
    html: html(paragraphs.map((p) => part(p, 'html'))).replace('<html>', `<html lang="${lc}">`),
  };
}

function renderBody<T extends EmailTemplateId>(template: T, data: unknown, appName: string, lc: EmailLocale): RenderedEmail {
  const app = appName;
  switch (template) {
    case 'sign-in-code': {
      const d = EmailTemplates['sign-in-code'].parse(data);
      return localized(lc, ['email.signInCode.subject', { app, code: d.code }], [
        ['email.signInCode.code', { code: d.code }],
        ['email.signInCode.expires', { minutes: d.expiresInMinutes }],
        ['email.signInCode.ignore', { app }],
      ]);
    }
    case 'workspace-invite': {
      const d = EmailTemplates['workspace-invite'].parse(data);
      const inviter = d.inviterName.trim() || msg(lc, 'email.invite.someone', {}, 'text');
      const workspace = d.workspaceName;
      const url = escapeHtml(d.acceptUrl);
      return localized(lc, ['email.invite.subject', { inviter, workspace, app }], [
        ['email.invite.body', { inviter, workspace, app, role: d.role }],
        { text: msg(lc, 'email.invite.acceptText', { url: d.acceptUrl }, 'text'), html: `<a href="${url}">${escapeHtml(msg(lc, 'email.invite.acceptLink', {}, 'text'))}</a>` },
        ['email.invite.expires', { days: d.expiresInDays }],
      ]);
    }
    case 'change-email-code': {
      const d = EmailTemplates['change-email-code'].parse(data);
      return localized(lc, ['email.changeEmail.subject', { app, code: d.code }], [
        ['email.changeEmail.body', { code: d.code, app }],
        ['email.changeEmail.expires', { minutes: d.expiresInMinutes }],
        ['email.changeEmail.ignore', {}],
      ]);
    }
    case 'delete-account-code': {
      const d = EmailTemplates['delete-account-code'].parse(data);
      return localized(lc, ['email.deleteAccount.subject', { app, code: d.code }], [
        ['email.deleteAccount.body', { code: d.code, app }],
        ['email.deleteAccount.expires', { minutes: d.expiresInMinutes }],
        ['email.deleteAccount.ignore', {}],
      ]);
    }
    case 'data-export-ready': {
      const d = EmailTemplates['data-export-ready'].parse(data);
      const url = escapeHtml(d.downloadUrl);
      return localized(lc, ['email.dataExport.subject', { app }], [
        ['email.dataExport.ready', { app }],
        { text: msg(lc, 'email.dataExport.downloadText', { url: d.downloadUrl }, 'text'), html: `<a href="${url}">${escapeHtml(msg(lc, 'email.dataExport.downloadLink', {}, 'text'))}</a>` },
        ['email.dataExport.expires', { days: d.expiresInDays }],
        ['email.dataExport.notYou', {}],
      ]);
    }
    case 'feedback': {
      const d = EmailTemplates.feedback.parse(data);
      const lines = [
        `Kind: ${d.kind}`,
        `From: ${d.userEmail ?? 'unknown'} (${d.userId ?? 'signed out'})`,
        `Page: ${d.page ?? '-'}`,
        '',
        d.message,
        ...(d.diagnostics ? ['', 'Diagnostics:', d.diagnostics] : []),
      ];
      return {
        subject: `[${appName} feedback] ${d.kind}: ${d.message.replace(/\s+/g, ' ').slice(0, 60)}`,
        text: lines.join('\n'),
        html: html(lines.filter((l) => l !== '').map(escapeHtml)),
      };
    }
    default: {
      const never: never = template;
      throw new Error(`Unknown email template: ${String(never)}`);
    }
  }
}
