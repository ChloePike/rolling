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

/** Renders a template. Throws a ZodError when `data` does not match the template's schema. */
export function renderEmail<T extends EmailTemplateId>(template: T, data: unknown, appName = 'Rolling'): RenderedEmail {
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
    default: {
      const never: never = template;
      throw new Error(`Unknown email template: ${String(never)}`);
    }
  }
}
