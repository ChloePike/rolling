import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canDeleteComment,
  canResolve,
  CreateReviewInput,
  CreateThreadInput,
  excerpt,
  hashPassword,
  initialsOf,
  isUnread,
  linkState,
  matchesFilter,
  matureCreateCheck,
  mayViewMatureItem,
  PresencePayload,
  reviewStatus,
  signReviewPass,
  throttle,
  validMentions,
  verifyPassword,
  verifyReviewPass,
  activityMatches,
} from './index';

describe('presence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('validates payloads and caps the selection', () => {
    expect(PresencePayload.safeParse({ projectId: 'prj_1', cursor: { x: 1, y: 2 }, selection: ['node_a'] }).success).toBe(true);
    expect(PresencePayload.parse({ projectId: 'prj_1' }).key).toBe('tab');
    expect(PresencePayload.safeParse({ projectId: 'prj_1', selection: Array.from({ length: 51 }, (_, i) => `n${i}`) }).success).toBe(false);
    expect(PresencePayload.safeParse({ projectId: 'prj_1', cursor: { x: Number.NaN, y: 0 } }).success).toBe(false);
  });

  it('throttles to one call per window and keeps the latest', () => {
    const calls: number[] = [];
    let now = 0;
    const t = throttle((n: number) => calls.push(n), 50, () => now);
    t(1);
    t(2);
    t(3);
    expect(calls).toEqual([1]);
    now = 50;
    vi.advanceTimersByTime(50);
    expect(calls).toEqual([1, 3]);
    t.cancel();
  });

  it('makes initials', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('maya')).toBe('M');
    expect(initialsOf('  ')).toBe('?');
  });
});

describe('comments', () => {
  it('accepts every anchor kind and rejects bad ranges', () => {
    for (const anchor of [
      { kind: 'node', nodeId: 'node_1' },
      { kind: 'version', nodeId: 'node_1', versionId: 'ver_1' },
      { kind: 'timeline', canvasId: 'cnv_1', start: 1, end: 3.5 },
      { kind: 'canvas', x: 10, y: -4 },
    ]) {
      expect(CreateThreadInput.safeParse({ anchor, body: 'Looks good' }).success, anchor.kind).toBe(true);
    }
    expect(CreateThreadInput.safeParse({ anchor: { kind: 'timeline', canvasId: 'cnv_1', start: 4, end: 2 }, body: 'x' }).success).toBe(false);
    expect(CreateThreadInput.safeParse({ anchor: { kind: 'node', nodeId: 'n' }, body: '   ' }).success).toBe(false);
  });

  it('applies role rules', () => {
    expect(canResolve('viewer')).toBe(false);
    expect(canResolve('editor')).toBe(true);
    expect(canDeleteComment('viewer', 'u1', 'u1')).toBe(true);
    expect(canDeleteComment('editor', 'u1', 'u2')).toBe(false);
    expect(canDeleteComment('owner', 'u1', 'u2')).toBe(true);
  });

  it('keeps only member mentions, once, never the author', () => {
    expect(validMentions(['u2', 'u2', 'x', 'u1'], new Set(['u1', 'u2']), 'u1')).toEqual(['u2']);
  });

  it('computes unread for others only', () => {
    const c = (id: string, at: number) => ({ author: { kind: 'member' as const, id, name: id }, createdAt: at, deleted: false });
    expect(isUnread([c('me', 10)], 'me', null)).toBe(false);
    expect(isUnread([c('me', 10), c('you', 20)], 'me', 15)).toBe(true);
    expect(isUnread([c('you', 20)], 'me', 25)).toBe(false);
  });

  it('filters threads', () => {
    const t = { status: 'open' as const, createdBy: { kind: 'member' as const, id: 'a', name: 'a' }, comments: [], unread: true, mentionsMe: false, reviewId: null };
    expect(matchesFilter(t, 'open', 'a')).toBe(true);
    expect(matchesFilter(t, 'resolved', 'a')).toBe(false);
    expect(matchesFilter(t, 'unread', 'a')).toBe(true);
    expect(matchesFilter(t, 'reviews', 'a')).toBe(false);
  });

  it('shortens excerpts', () => {
    expect(excerpt('a\n b')).toBe('a b');
    expect(excerpt('x'.repeat(200), 10)).toHaveLength(10);
  });
});

describe('reviews', () => {
  it('parses create inputs per kind', () => {
    expect(CreateReviewInput.safeParse({ kind: 'version', nodeId: 'node_1' }).success).toBe(true);
    expect(CreateReviewInput.safeParse({ kind: 'export', exportId: 'exp_1', expiresInDays: 7, password: 'secret1' }).success).toBe(true);
    expect(CreateReviewInput.safeParse({ kind: 'shots', nodeIds: [] }).success).toBe(false);
    expect(CreateReviewInput.safeParse({ kind: 'export', exportId: 'exp_1', expiresInDays: 91 }).success).toBe(false);
    expect(CreateReviewInput.safeParse({ kind: 'export', exportId: 'exp_1', password: '123' }).success).toBe(false);
  });

  it('aggregates the latest decision per reviewer', () => {
    expect(reviewStatus([])).toBe('pending');
    expect(reviewStatus([{ reviewerId: 'a', decision: 'approved', createdAt: 1 }])).toBe('approved');
    expect(
      reviewStatus([
        { reviewerId: 'a', decision: 'changes_requested', createdAt: 1 },
        { reviewerId: 'a', decision: 'approved', createdAt: 2 },
        { reviewerId: 'b', decision: 'approved', createdAt: 3 },
      ]),
    ).toBe('approved');
    expect(
      reviewStatus([
        { reviewerId: 'a', decision: 'approved', createdAt: 1 },
        { reviewerId: 'b', decision: 'changes_requested', createdAt: 2 },
      ]),
    ).toBe('changes_requested');
  });

  it('knows expired and revoked links', () => {
    expect(linkState({ expiresAt: null, revokedAt: null })).toBe('active');
    expect(linkState({ expiresAt: 10, revokedAt: null }, 11)).toBe('expired');
    expect(linkState({ expiresAt: 100, revokedAt: 5 }, 11)).toBe('revoked');
  });

  it('applies the mature rule', () => {
    const safe = [{ mature: false }];
    const adult = [{ mature: false }, { mature: true }];
    expect(matureCreateCheck({ items: safe, confirmMature: false, creatorIsOwner: false, creatorMatureAllowed: false })).toEqual({ ok: true, mature: false });
    expect(matureCreateCheck({ items: adult, confirmMature: false, creatorIsOwner: true, creatorMatureAllowed: true })).toEqual({ ok: false, code: 'MATURE_CONFIRM_REQUIRED' });
    expect(matureCreateCheck({ items: adult, confirmMature: true, creatorIsOwner: false, creatorMatureAllowed: true })).toEqual({ ok: false, code: 'MATURE_NOT_ALLOWED' });
    expect(matureCreateCheck({ items: adult, confirmMature: true, creatorIsOwner: true, creatorMatureAllowed: false })).toEqual({ ok: false, code: 'MATURE_NOT_ALLOWED' });
    expect(matureCreateCheck({ items: adult, confirmMature: true, creatorIsOwner: true, creatorMatureAllowed: true })).toEqual({ ok: true, mature: true });
    expect(mayViewMatureItem({ mature: true }, null)).toBe(false);
    expect(mayViewMatureItem({ mature: true }, { matureAllowed: false })).toBe(false);
    expect(mayViewMatureItem({ mature: true }, { matureAllowed: true })).toBe(true);
    expect(mayViewMatureItem({ mature: false }, { matureAllowed: true })).toBe(false);
  });

  it('hashes and verifies passwords', async () => {
    const stored = await hashPassword('open sesame');
    expect(stored.startsWith('pbkdf2$')).toBe(true);
    expect(await verifyPassword('open sesame', stored)).toBe(true);
    expect(await verifyPassword('open sesam', stored)).toBe(false);
  });

  it('signs passes bound to the password version and expiry', async () => {
    const now = Date.now();
    const pass = await signReviewPass('k', 'rvw_1', 1, now);
    expect(await verifyReviewPass('k', 'rvw_1', 1, pass, now)).toBe(true);
    expect(await verifyReviewPass('k', 'rvw_1', 2, pass, now)).toBe(false);
    expect(await verifyReviewPass('k', 'rvw_2', 1, pass, now)).toBe(false);
    expect(await verifyReviewPass('k', 'rvw_1', 1, pass, now + 13 * 3600_000)).toBe(false);
    expect(await verifyReviewPass('k', 'rvw_1', 1, 'garbage', now)).toBe(false);
  });
});

describe('activity', () => {
  it('filters kinds', () => {
    expect(activityMatches('run.done', 'runs')).toBe(true);
    expect(activityMatches('comment.resolved', 'comments')).toBe(true);
    expect(activityMatches('review.decision', 'edits')).toBe(false);
  });
});

describe('emails', () => {
  it('renders and escapes', async () => {
    const { renderCollabEmail } = await import('./emails');
    const m = renderCollabEmail('comment-mention', { authorName: 'Ada <x>', projectTitle: 'Ad', excerpt: 'Hi', url: 'https://rolling.actor/p/prj_1' });
    expect(m.subject).toBe('Ada <x> mentioned you in Ad');
    expect(m.html).toContain('Ada &lt;x&gt;');
    expect(renderCollabEmail('review-code', { code: '123456', linkTitle: 'Cut 1', expiresInMinutes: 10 }).text).toContain('123456');
    expect(renderCollabEmail('review-decision', { reviewerName: 'Sam', linkTitle: 'Cut 1', decision: 'changes_requested', note: null, url: 'https://x.test/r' }).subject).toBe('Sam asked for changes on Cut 1');
    expect(() => renderCollabEmail('review-code', { code: '12', linkTitle: 'x', expiresInMinutes: 1 })).toThrow();
  });
});
