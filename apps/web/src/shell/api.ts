import { api } from '@/lib/api/client';
import { isMockApi } from '@/lib/api/mode';

export type FeedbackKind = 'bug' | 'idea' | 'other';

export interface FeedbackInput {
  message: string;
  kind: FeedbackKind;
  /** The page the user was on (path only). */
  page?: string;
  /** Lets the server attach browser, workspace and plan details. */
  includeDiagnostics?: boolean;
}

/** `POST /api/feedback` (rate limited; mock: resolves after a short delay). */
export async function sendFeedback(input: FeedbackInput): Promise<void> {
  if (isMockApi()) {
    await new Promise((r) => setTimeout(r, 300));
    return;
  }
  await api.post('/feedback', { message: input.message, kind: input.kind, ...(input.page ? { page: input.page.slice(0, 500) } : {}), includeDiagnostics: !!input.includeDiagnostics });
}
