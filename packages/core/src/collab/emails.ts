import { z } from 'zod';

/**
 * Collaboration emails (D-031): plain, short, sentence case, English. Each has
 * a Zod schema; `renderCollabEmail` throws a ZodError on bad data.
 */
export const CollabEmails = {
  /** Someone @mentioned the recipient in a comment. */
  'comment-mention': z.object({
    authorName: z.string().min(1).max(200),
    projectTitle: z.string().min(1).max(200),
    excerpt: z.string().min(1).max(400),
    url: z.string().url(),
  }),
  /** A reviewer approved or asked for changes on a review link the recipient created. */
  'review-decision': z.object({
    reviewerName: z.string().min(1).max(200),
    linkTitle: z.string().min(1).max(200),
    decision: z.enum(['approved', 'changes_requested']),
    note: z.string().max(2000).nullable(),
    url: z.string().url(),
  }),
  /** One-time code for a reviewer without an account. */
  'review-code': z.object({
    code: z.string().regex(/^\d{6}$/),
    linkTitle: z.string().min(1).max(200),
    expiresInMinutes: z.number().int().positive(),
  }),
} as const;

export type CollabEmailId = keyof typeof CollabEmails;
export type CollabEmailData<T extends CollabEmailId> = z.infer<(typeof CollabEmails)[T]>;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(paragraphs: string[]): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join('');
  return `<!doctype html><html lang="en"><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${body}</body></html>`;
}

export function renderCollabEmail<T extends CollabEmailId>(id: T, data: unknown, appName = 'Rolling'): { subject: string; text: string; html: string } {
  switch (id) {
    case 'comment-mention': {
      const d = CollabEmails['comment-mention'].parse(data);
      return {
        subject: `${d.authorName} mentioned you in ${d.projectTitle}`,
        text: [`${d.authorName} mentioned you in a comment on ${d.projectTitle}:`, `“${d.excerpt}”`, `Open the comment: ${d.url}`].join('\n\n'),
        html: page([
          `${escapeHtml(d.authorName)} mentioned you in a comment on <strong>${escapeHtml(d.projectTitle)}</strong>:`,
          `“${escapeHtml(d.excerpt)}”`,
          `<a href="${escapeHtml(d.url)}">Open the comment</a>`,
        ]),
      };
    }
    case 'review-decision': {
      const d = CollabEmails['review-decision'].parse(data);
      const verb = d.decision === 'approved' ? 'approved' : 'asked for changes on';
      const lines = [`${d.reviewerName} ${verb} ${d.linkTitle}.`, ...(d.note ? [`“${d.note}”`] : [])];
      return {
        subject: d.decision === 'approved' ? `${d.reviewerName} approved ${d.linkTitle}` : `${d.reviewerName} asked for changes on ${d.linkTitle}`,
        text: [...lines, `See the review: ${d.url}`].join('\n\n'),
        html: page([...lines.map(escapeHtml), `<a href="${escapeHtml(d.url)}">See the review</a>`]),
      };
    }
    case 'review-code': {
      const d = CollabEmails['review-code'].parse(data);
      return {
        subject: `${d.code} is your ${appName} review code`,
        text: [`Your code to review ${d.linkTitle}: ${d.code}`, `It expires in ${d.expiresInMinutes} minutes.`, 'If you did not ask for it, ignore this email.'].join('\n\n'),
        html: page([
          `Your code to review ${escapeHtml(d.linkTitle)}: <strong style="font-size:20px;letter-spacing:2px">${d.code}</strong>`,
          `It expires in ${d.expiresInMinutes} minutes.`,
          'If you did not ask for it, ignore this email.',
        ]),
      };
    }
  }
  throw new Error(`Unknown collaboration email ${String(id)}`);
}
