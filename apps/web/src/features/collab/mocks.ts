import { isUnread, type ActivityEntry, type CommentAnchor, type ThreadView } from '@rolling/core/collab';
import type { ActivityPage, CollabMember, CommentsState, CreateReviewBody, ReviewOwnerView, ReviewPageData, ReviewSettings } from './types';

/**
 * Mock-mode collaboration backend (D-031): one in-memory project's comments,
 * activity and review links, plus a review page. Read only through
 * `mockData().collab` (lib/api/mockData.ts).
 */

export const MOCK_ME = 'usr_mock_me';

export const MOCK_MEMBERS: CollabMember[] = [
  { userId: MOCK_ME, name: 'Alex Rivera', image: null, role: 'owner' },
  { userId: 'usr_mock_maya', name: 'Maya Chen', image: null, role: 'editor' },
  { userId: 'usr_mock_sam', name: 'Sam Ortiz', image: null, role: 'viewer' },
];

type Listener = (type: string, payload: unknown) => void;

let seq = 0;
const id = (p: string) => `${p}_mock${Date.now().toString(36)}${++seq}`;

export class MockCollab {
  threads: ThreadView[] = [];
  activity: ActivityEntry[] = [];
  reviews: ReviewOwnerView[] = [];
  reads = new Map<string, number>();
  private listeners = new Set<Listener>();

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(type: string, payload: unknown) {
    for (const l of this.listeners) l(type, payload);
  }

  private me() {
    return MOCK_MEMBERS[0]!;
  }

  private view(t: ThreadView): ThreadView {
    return { ...t, unread: isUnread(t.comments, MOCK_ME, this.reads.get(t.id) ?? null), mentionsMe: t.comments.some((c) => c.mentions.includes(MOCK_ME)) };
  }

  comments(): CommentsState {
    const threads = this.threads.map((t) => this.view(t)).sort((a, b) => b.updatedAt - a.updatedAt);
    return { threads, members: MOCK_MEMBERS, unread: threads.filter((t) => t.unread).length, canResolve: true };
  }

  private record(kind: ActivityEntry['kind'], data: Record<string, unknown>, actor: ActivityEntry['actor'] = { kind: 'member', id: MOCK_ME, name: this.me().name }) {
    const now = Date.now();
    const entry: ActivityEntry = { id: id('act'), kind, actor, data, createdAt: now, updatedAt: now };
    this.activity.unshift(entry);
    this.emit('activity.added', { entry });
  }

  create(anchor: CommentAnchor, body: string, mentions: string[], author = this.me()): ThreadView {
    const now = Date.now();
    const threadId = id('cth');
    const t: ThreadView = {
      id: threadId,
      anchor,
      status: 'open',
      createdBy: { kind: 'member', id: author.userId, name: author.name },
      createdAt: now,
      updatedAt: now,
      resolvedBy: null,
      resolvedAt: null,
      reviewId: anchor.kind === 'review' ? anchor.reviewId : null,
      comments: [{ id: id('cmt'), threadId, author: { kind: 'member', id: author.userId, name: author.name }, body, mentions, createdAt: now, editedAt: null, deleted: false }],
      unread: false,
      mentionsMe: false,
    };
    this.threads.push(t);
    if (author.userId === MOCK_ME) this.reads.set(threadId, now);
    this.emit('comment.thread', { thread: t });
    this.record('comment', { threadId, excerpt: body.slice(0, 120), anchor: anchor.kind });
    return this.view(t);
  }

  reply(threadId: string, body: string, mentions: string[], author = this.me()): ThreadView {
    const t = this.find(threadId);
    const now = Date.now();
    t.comments.push({ id: id('cmt'), threadId, author: { kind: 'member', id: author.userId, name: author.name }, body, mentions, createdAt: now, editedAt: null, deleted: false });
    t.updatedAt = now;
    t.status = 'open';
    t.resolvedAt = null;
    t.resolvedBy = null;
    if (author.userId === MOCK_ME) this.reads.set(threadId, now);
    this.emit('comment.thread', { thread: t });
    this.record('comment', { threadId, excerpt: body.slice(0, 120) });
    return this.view(t);
  }

  setStatus(threadId: string, status: 'open' | 'resolved'): ThreadView {
    const t = this.find(threadId);
    t.status = status;
    t.resolvedBy = status === 'resolved' ? MOCK_ME : null;
    t.resolvedAt = status === 'resolved' ? Date.now() : null;
    t.updatedAt = Date.now();
    this.emit('comment.thread', { thread: t });
    this.record(status === 'resolved' ? 'comment.resolved' : 'comment.reopened', { threadId });
    return this.view(t);
  }

  edit(threadId: string, commentId: string, body: string): ThreadView {
    const t = this.find(threadId);
    const c = t.comments.find((x) => x.id === commentId);
    if (c) {
      c.body = body;
      c.editedAt = Date.now();
    }
    this.emit('comment.thread', { thread: t });
    return this.view(t);
  }

  remove(threadId: string, commentId: string): ThreadView | null {
    const t = this.find(threadId);
    const c = t.comments.find((x) => x.id === commentId);
    if (c) {
      c.deleted = true;
      c.body = '';
    }
    if (!t.comments.some((x) => !x.deleted)) {
      this.threads = this.threads.filter((x) => x.id !== threadId);
      this.emit('comment.deleted', { threadId });
      return null;
    }
    this.emit('comment.thread', { thread: t });
    return this.view(t);
  }

  markRead(ids: string[]): number {
    const now = Date.now();
    for (const i of ids) this.reads.set(i, now);
    return this.comments().unread;
  }

  listActivity(): ActivityPage {
    return { entries: this.activity.slice(0, 50), next: null };
  }

  createReview(body: CreateReviewBody, settings: ReviewSettings): ReviewOwnerView {
    const now = Date.now();
    const token = id('tok').replace(/_/g, '');
    const items =
      body.kind === 'shots'
        ? body.nodeIds.map((n, i) => ({ id: `i${i + 1}`, kind: 'video' as const, title: `Shot ${i + 1}`, nodeId: n, versionId: null, exportId: null, mature: false }))
        : [{ id: 'i1', kind: 'video' as const, title: body.kind === 'export' ? 'Export' : 'Shot', nodeId: body.kind === 'version' ? body.nodeId : null, versionId: null, exportId: body.kind === 'export' ? body.exportId : null, mature: false }];
    const review: ReviewOwnerView = {
      id: id('rvw'),
      kind: body.kind,
      title: settings.title ?? (body.kind === 'shots' ? `${items.length} shots` : items[0]!.title),
      url: `${typeof location === 'undefined' ? 'https://rolling.actor' : location.origin}/review/${token}`,
      state: 'active',
      status: 'pending',
      mature: false,
      hasPassword: !!settings.password,
      expiresAt: settings.expiresInDays ? now + settings.expiresInDays * 86_400_000 : null,
      revokedAt: null,
      createdAt: now,
      createdBy: MOCK_ME,
      items,
      decisions: [],
    };
    this.reviews.unshift(review);
    this.record('review.created', { reviewId: review.id, title: review.title, items: items.length });
    this.emit('review.updated', { reviewId: review.id });
    return review;
  }

  updateReview(reviewId: string, patch: { expiresInDays?: number | null; password?: string | null; revoke?: true }): ReviewOwnerView {
    const r = this.reviews.find((x) => x.id === reviewId);
    if (!r) throw new Error('Review link not found');
    if (patch.expiresInDays !== undefined) r.expiresAt = patch.expiresInDays === null ? null : Date.now() + patch.expiresInDays * 86_400_000;
    if (patch.password !== undefined) r.hasPassword = patch.password !== null;
    if (patch.revoke) {
      r.revokedAt = Date.now();
      r.state = 'revoked';
      this.record('review.revoked', { reviewId, title: r.title });
    }
    this.emit('review.updated', { reviewId });
    return r;
  }

  private find(threadId: string): ThreadView {
    const t = this.threads.find((x) => x.id === threadId);
    if (!t) throw new Error('Thread not found');
    return t;
  }
}

let instance: MockCollab | null = null;

/** The mock project's collaboration store (one per page load). */
export function mockCollab(): MockCollab {
  instance ??= new MockCollab();
  return instance;
}

/** Mock review page (`/review/mock`, and any token in mock mode). */
export function mockReviewPage(): ReviewPageData {
  return {
    link: { id: 'rvw_mock', kind: 'shots', title: 'Spring launch · cut 2', projectTitle: 'Spring launch', workspaceName: 'Northwind studio', expiresAt: null, status: 'pending', mature: false },
    items: [
      { id: 'i1', kind: 'video', title: 'Shot 1', mature: false, media: null, withheld: 'missing' },
      { id: 'i2', kind: 'image', title: 'Key art', mature: false, media: null, withheld: 'missing' },
    ],
    threads: [],
    decisions: [],
    me: null,
    viewerMatureAllowed: false,
  };
}
