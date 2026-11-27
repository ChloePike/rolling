import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommentAnchor, ThreadView } from '@rolling/core/collab';
import { apiFetch, isMockApi } from '@/features/overlays/backend';
import { subscribeProjectMessages } from '@/features/canvas/api';
import { mockData } from '@/lib/api/mode';
import type { ActivityPage, CommentsState, CreateReviewBody, ReviewOwnerView, ReviewPageData, ReviewSettings } from './types';

/**
 * Collaboration client (D-031): comments, activity and review links of a
 * project (`/api/projects/:id/...`), the public review page
 * (`/api/review/:token/...`), and live updates from the project channel
 * (`comment.thread`, `comment.deleted`, `activity.added`, `review.updated`).
 * Mock mode uses the in-memory store in `./mocks` (through `mockData()`).
 */

const mock = () => mockData().collab.mockCollab();

export const collabKeys = {
  comments: (projectId: string) => ['collab', 'comments', projectId] as const,
  activity: (projectId: string) => ['collab', 'activity', projectId] as const,
  reviews: (projectId: string) => ['collab', 'reviews', projectId] as const,
};

// ------------------------------------------------------------ comments

export async function listComments(projectId: string): Promise<CommentsState> {
  if (isMockApi()) return mock().comments();
  return apiFetch<CommentsState>(`/projects/${projectId}/comments`);
}

export async function createThread(projectId: string, input: { anchor: CommentAnchor; body: string; mentions: string[] }): Promise<ThreadView> {
  if (isMockApi()) return mock().create(input.anchor, input.body, input.mentions);
  return (await apiFetch<{ thread: ThreadView }>(`/projects/${projectId}/comments`, { method: 'POST', body: input })).thread;
}

export async function replyThread(projectId: string, threadId: string, input: { body: string; mentions: string[] }): Promise<ThreadView> {
  if (isMockApi()) return mock().reply(threadId, input.body, input.mentions);
  return (await apiFetch<{ thread: ThreadView }>(`/projects/${projectId}/comments/${threadId}/replies`, { method: 'POST', body: input })).thread;
}

export async function setThreadStatus(projectId: string, threadId: string, status: 'open' | 'resolved'): Promise<ThreadView> {
  if (isMockApi()) return mock().setStatus(threadId, status);
  return (await apiFetch<{ thread: ThreadView }>(`/projects/${projectId}/comments/${threadId}`, { method: 'PATCH', body: { status } })).thread;
}

export async function editComment(projectId: string, threadId: string, commentId: string, body: string, mentions: string[]): Promise<ThreadView> {
  if (isMockApi()) return mock().edit(threadId, commentId, body);
  return (await apiFetch<{ thread: ThreadView }>(`/projects/${projectId}/comments/${threadId}/${commentId}`, { method: 'PATCH', body: { body, mentions } })).thread;
}

export async function deleteComment(projectId: string, threadId: string, commentId: string): Promise<ThreadView | null> {
  if (isMockApi()) return mock().remove(threadId, commentId);
  return (await apiFetch<{ thread: ThreadView | null }>(`/projects/${projectId}/comments/${threadId}/${commentId}`, { method: 'DELETE' })).thread;
}

export async function markThreadsRead(projectId: string, threadIds: string[]): Promise<number> {
  if (!threadIds.length) return 0;
  if (isMockApi()) return mock().markRead(threadIds);
  return (await apiFetch<{ unread: number }>(`/projects/${projectId}/comments/read`, { method: 'POST', body: { threadIds } })).unread;
}

// ------------------------------------------------------------ activity

export async function listActivity(projectId: string, before?: number): Promise<ActivityPage> {
  if (isMockApi()) return mock().listActivity();
  return apiFetch<ActivityPage>(`/projects/${projectId}/activity`, { query: { before, limit: 50 } });
}

// ------------------------------------------------------------ review links (owner side)

export async function listReviews(projectId: string): Promise<ReviewOwnerView[]> {
  if (isMockApi()) return mock().reviews;
  return (await apiFetch<{ reviews: ReviewOwnerView[] }>(`/projects/${projectId}/reviews`)).reviews;
}

export async function createReview(projectId: string, body: CreateReviewBody, settings: ReviewSettings): Promise<ReviewOwnerView> {
  if (isMockApi()) return mock().createReview(body, settings);
  return (await apiFetch<{ review: ReviewOwnerView }>(`/projects/${projectId}/reviews`, { method: 'POST', body: { ...body, ...settings } })).review;
}

export async function updateReview(projectId: string, reviewId: string, patch: { expiresInDays?: number | null; password?: string | null; revoke?: true }): Promise<ReviewOwnerView> {
  if (isMockApi()) return mock().updateReview(reviewId, patch);
  return (await apiFetch<{ review: ReviewOwnerView }>(`/projects/${projectId}/reviews/${reviewId}`, { method: 'PATCH', body: patch })).review;
}

// ------------------------------------------------------------ hooks

function upsertThread(state: CommentsState | undefined, thread: ThreadView, me: string | null): CommentsState | undefined {
  if (!state) return state;
  const prev = state.threads.find((t) => t.id === thread.id);
  const last = [...thread.comments].reverse().find((c) => !c.deleted);
  const byOther = !!last && !(last.author.kind === 'member' && last.author.id === me);
  const grew = !prev || thread.comments.length > prev.comments.length;
  const next: ThreadView = {
    ...thread,
    unread: grew ? byOther || (prev?.unread ?? false) : (prev?.unread ?? false),
    mentionsMe: me ? thread.comments.some((c) => c.mentions.includes(me)) : false,
  };
  const threads = [next, ...state.threads.filter((t) => t.id !== thread.id)].sort((a, b) => b.updatedAt - a.updatedAt);
  return { ...state, threads, unread: threads.filter((t) => t.unread).length };
}

/**
 * Comments of a project, kept live from the project channel (real mode) or
 * the mock store. `me` is the signed-in user's id (unread on live events).
 */
export function useComments(projectId: string, me: string | null) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: collabKeys.comments(projectId), queryFn: () => listComments(projectId), staleTime: 30_000 });
  useEffect(() => {
    const apply = (type: string, payload: unknown) => {
      if (type === 'comment.thread') {
        const { thread } = payload as { thread: ThreadView };
        qc.setQueryData<CommentsState>(collabKeys.comments(projectId), (s) => upsertThread(s, thread, me));
      } else if (type === 'comment.deleted') {
        const { threadId } = payload as { threadId: string };
        qc.setQueryData<CommentsState>(collabKeys.comments(projectId), (s) => {
          if (!s) return s;
          const threads = s.threads.filter((t) => t.id !== threadId);
          return { ...s, threads, unread: threads.filter((t) => t.unread).length };
        });
      } else if (type === 'activity.added') {
        void qc.invalidateQueries({ queryKey: collabKeys.activity(projectId) });
      } else if (type === 'review.updated') {
        void qc.invalidateQueries({ queryKey: collabKeys.reviews(projectId) });
      } else if (type === 'hello') {
        // Reconnected: catch up on what the transient events may have missed.
        void qc.invalidateQueries({ queryKey: ['collab'] });
      }
    };
    if (isMockApi()) return mock().on(apply);
    return subscribeProjectMessages(projectId, (msg) => apply(msg.type, msg.payload));
  }, [projectId, me, qc]);
  return query;
}

export function useActivity(projectId: string, enabled: boolean) {
  return useQuery({ queryKey: collabKeys.activity(projectId), queryFn: () => listActivity(projectId), enabled, staleTime: 10_000 });
}

export function useReviews(projectId: string, enabled: boolean) {
  return useQuery({ queryKey: collabKeys.reviews(projectId), queryFn: () => listReviews(projectId), enabled, staleTime: 10_000 });
}

// ------------------------------------------------------------ public review page

export interface ReviewAccess {
  pass?: string | null;
  reviewerToken?: string | null;
}

function reviewHeaders(a: ReviewAccess): Record<string, string> {
  return { ...(a.pass ? { 'x-review-pass': a.pass } : {}), ...(a.reviewerToken ? { 'x-reviewer-token': a.reviewerToken } : {}) };
}

/** Plain fetch: the review page has no session; errors keep the API envelope. */
async function reviewFetch<T>(path: string, access: ReviewAccess, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/review/${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    credentials: 'include',
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...reviewHeaders(access) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; data?: Record<string, unknown> } } | null)?.error;
    throw new ReviewError(e?.code ?? 'INTERNAL', e?.message ?? res.statusText, res.status, e?.data ?? {});
  }
  return json as T;
}

export class ReviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

export function getReviewPage(token: string, access: ReviewAccess): Promise<ReviewPageData> {
  if (isMockApi()) return Promise.resolve(mockData().collab.mockReviewPage());
  return reviewFetch<ReviewPageData>(encodeURIComponent(token), access);
}

export async function unlockReview(token: string, password: string): Promise<string> {
  return (await reviewFetch<{ pass: string }>(`${encodeURIComponent(token)}/unlock`, {}, { body: { password } })).pass;
}

export function sendReviewCode(token: string, access: ReviewAccess, input: { name: string; email: string }): Promise<{ expiresInMinutes: number }> {
  return reviewFetch(`${encodeURIComponent(token)}/code`, access, { body: input });
}

export function verifyReviewCode(token: string, access: ReviewAccess, input: { email: string; code: string }): Promise<{ reviewer: { id: string; name: string; email: string }; reviewerToken: string }> {
  return reviewFetch(`${encodeURIComponent(token)}/verify`, access, { body: input });
}

export async function postReviewComment(token: string, access: ReviewAccess, input: { itemId: string; at: number | null; body: string; threadId?: string }): Promise<ThreadView> {
  return (await reviewFetch<{ thread: ThreadView }>(`${encodeURIComponent(token)}/comments`, access, { body: input })).thread;
}

export function postReviewDecision(token: string, access: ReviewAccess, input: { decision: 'approved' | 'changes_requested'; note?: string }) {
  return reviewFetch<{ status: string; me: ReviewPageData['me'] }>(`${encodeURIComponent(token)}/decision`, access, { body: input });
}
