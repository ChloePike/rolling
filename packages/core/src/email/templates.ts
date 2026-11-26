import { z } from 'zod';

/**
 * Email templates: plain, short, sentence case, English. Each template has a
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

/**
 * Renders a template. Throws a ZodError when `data` does not match the template's schema.
 * With `appUrl` (the app's public origin, e.g. `https://rolling.actor`), emails to users end
 * with links to the Terms and Privacy Policy (`/terms`, `/privacy`); internal ones (feedback) do not.
 */
export function renderEmail<T extends EmailTemplateId>(template: T, data: unknown, appName = 'Rolling', appUrl?: string): RenderedEmail {
  const email = renderBody(template, data, appName);
  const origin = appUrl?.replace(/\/+$/, '');
  if (!origin || template === 'feedback') return email;
  const terms = `${origin}/terms`;
  const privacy = `${origin}/privacy`;
  const footer = `<p style="margin:24px 0 0;font-size:12px;color:#666">${escapeHtml(appName)} · <a href="${escapeHtml(terms)}" style="color:#666">Terms</a> · <a href="${escapeHtml(privacy)}" style="color:#666">Privacy Policy</a></p>`;
  return {
    subject: email.subject,
    text: `${email.text}\n\n--\n${appName} · Terms: ${terms} · Privacy Policy: ${privacy}`,
    html: email.html.replace('</body></html>', `${footer}</body></html>`),
  };
}

function renderBody<T extends EmailTemplateId>(template: T, data: unknown, appName: string): RenderedEmail {
  const app = escapeHtml(appName);
  switch (template) {
    case 'sign-in-code': {
      const d = EmailTemplates['sign-in-code'].parse(data);
      return {
        subject: `Your ${appName} sign-in code is ${d.code}`,
        text: [
          `Your sign-in code is ${d.code}.`,
          `It expires in ${d.expiresInMinutes} minutes.`,
          `If you didn't try to sign in to ${appName}, you can ignore this email.`,
        ].join('\n\n'),
        html: html([
          `Your sign-in code is <strong style="font-size:20px;letter-spacing:2px">${d.code}</strong>.`,
          `It expires in ${d.expiresInMinutes} minutes.`,
          `If you didn't try to sign in to ${app}, you can ignore this email.`,
        ]),
      };
    }
    case 'workspace-invite': {
      const d = EmailTemplates['workspace-invite'].parse(data);
      const who = d.inviterName.trim() || 'A teammate';
      const url = escapeHtml(d.acceptUrl);
      return {
        subject: `${who} invited you to ${d.workspaceName} on ${appName}`,
        text: [
          `${who} invited you to join ${d.workspaceName} on ${appName} as ${d.role === 'editor' ? 'an editor' : 'a viewer'}.`,
          `Accept the invite: ${d.acceptUrl}`,
          `The link expires in ${d.expiresInDays} days.`,
        ].join('\n\n'),
        html: html([
          `${escapeHtml(who)} invited you to join ${escapeHtml(d.workspaceName)} on ${app} as ${d.role === 'editor' ? 'an editor' : 'a viewer'}.`,
          `<a href="${url}">Accept the invite</a>`,
          `The link expires in ${d.expiresInDays} days.`,
        ]),
      };
    }
    case 'change-email-code': {
      const d = EmailTemplates['change-email-code'].parse(data);
      return {
        subject: `Confirm your new ${appName} email: ${d.code}`,
        text: [
          `Enter ${d.code} in ${appName} to use this address for your account.`,
          `The code expires in ${d.expiresInMinutes} minutes.`,
          `If you didn't ask to change your email, you can ignore this email.`,
        ].join('\n\n'),
        html: html([
          `Enter <strong style="font-size:20px;letter-spacing:2px">${d.code}</strong> in ${app} to use this address for your account.`,
          `The code expires in ${d.expiresInMinutes} minutes.`,
          `If you didn't ask to change your email, you can ignore this email.`,
        ]),
      };
    }
    case 'delete-account-code': {
      const d = EmailTemplates['delete-account-code'].parse(data);
      return {
        subject: `Your ${appName} account deletion code is ${d.code}`,
        text: [
          `Enter ${d.code} in ${appName} to delete your account. This can't be undone.`,
          `The code expires in ${d.expiresInMinutes} minutes.`,
          `If you didn't ask to delete your account, ignore this email; nothing changes.`,
        ].join('\n\n'),
        html: html([
          `Enter <strong style="font-size:20px;letter-spacing:2px">${d.code}</strong> in ${app} to delete your account. This can't be undone.`,
          `The code expires in ${d.expiresInMinutes} minutes.`,
          `If you didn't ask to delete your account, ignore this email; nothing changes.`,
        ]),
      };
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
