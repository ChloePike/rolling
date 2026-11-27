import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { useQueryClient } from '@tanstack/react-query';
import { cx, presenceProps, Skeleton, useToast, type PresenceState } from '@rolling/ui';
import { activityMatches, ACTIVITY_FILTERS, COMMENT_FILTERS, matchesFilter, type ActivityEntry, type ActivityFilter, type CommentAnchor, type CommentFilter, type ThreadView } from '@rolling/core/collab';
import {
  collabKeys,
  createReview,
  createThread,
  deleteComment,
  editComment,
  markThreadsRead,
  replyThread,
  setThreadStatus,
  updateReview,
  useActivity,
  useReviews,
} from './api';
import { isApiError } from '@/features/overlays/backend';
import { Avatar } from './CollabBar';
import type { CollabMember, CommentsState, CreateReviewBody, ReviewOwnerView } from './types';
import styles from './collab.module.css';

export type CollabTab = 'comments' | 'activity' | 'reviews';

export interface CollabPanelProps {
  state: PresenceState;
  projectId: string;
  me: string | null;
  role: 'owner' | 'editor' | 'viewer';
  comments: CommentsState | undefined;
  tab: CollabTab;
  onTab: (t: CollabTab) => void;
  focusThread: string | null;
  onFocusThread: (id: string | null) => void;
  /** Selected node ids on the canvas (anchor for a new comment, shots for a review link). */
  selection: string[];
  nodeTitle: (nodeId: string) => string | null;
  activeVersion: (nodeId: string) => string | null;
  canvasId: string | null;
  /** A canvas point picked in pin mode, waiting for its first comment. */
  pendingPoint: { x: number; y: number } | null;
  onPickPoint: () => void;
  onClearPoint: () => void;
  onShowNode: (nodeId: string) => void;
  onClose: () => void;
}

const fmtSeconds = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Comments, Activity and Review links of a project (D-031): a side panel on the canvas. */
export function CollabPanel(p: CollabPanelProps) {
  const intl = useIntl();
  return (
    <section className={cx(styles.panel, 'rl-panel')} aria-label={intl.formatMessage({ id: 'collab.panel.title' })} data-testid="collab-panel" {...presenceProps(p.state)}>
      <div className={styles.panelHead}>
        <div className={styles.tabs} role="tablist">
          {(['comments', 'activity', 'reviews'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={p.tab === t} className={styles.tab} data-testid={`collab-tab-${t}`} onClick={() => p.onTab(t)}>
              <FormattedMessage id={`collab.tab.${t}`} />
              {t === 'comments' && (p.comments?.unread ?? 0) > 0 ? <span className={styles.dot} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
        <button type="button" className={styles.iconBtn} aria-label={intl.formatMessage({ id: 'collab.panel.close' })} onClick={p.onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18 M6 6l12 12" />
          </svg>
        </button>
      </div>
      {p.tab === 'comments' ? <CommentsTab {...p} /> : p.tab === 'activity' ? <ActivityTab projectId={p.projectId} members={p.comments?.members ?? []} onShowNode={p.onShowNode} onOpenThread={(id) => { p.onTab('comments'); p.onFocusThread(id); }} /> : <ReviewsTab {...p} />}
    </section>
  );
}

// ---------------------------------------------------------------- comments

function anchorLabel(intl: ReturnType<typeof useIntl>, a: CommentAnchor, nodeTitle: (id: string) => string | null): string {
  switch (a.kind) {
    case 'node':
      return nodeTitle(a.nodeId) ?? intl.formatMessage({ id: 'collab.anchor.removedNode' });
    case 'version':
      return intl.formatMessage({ id: 'collab.anchor.version' }, { title: nodeTitle(a.nodeId) ?? intl.formatMessage({ id: 'collab.anchor.removedNode' }) });
    case 'timeline':
      return intl.formatMessage({ id: 'collab.anchor.timeline' }, { start: fmtSeconds(a.start), end: fmtSeconds(a.end) });
    case 'canvas':
      return intl.formatMessage({ id: 'collab.anchor.canvas' });
    case 'review':
      return a.at === null ? intl.formatMessage({ id: 'collab.anchor.review' }) : intl.formatMessage({ id: 'collab.anchor.reviewAt' }, { at: fmtSeconds(a.at) });
  }
}

type AnchorChoice = 'node' | 'version' | 'canvas' | 'timeline';

function CommentsTab(p: CollabPanelProps) {
  const intl = useIntl();
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState<CommentFilter>('open');
  const node = p.selection[0] ?? null;
  const version = node ? p.activeVersion(node) : null;
  const [choice, setChoice] = useState<AnchorChoice>(node ? 'node' : 'canvas');
  const [range, setRange] = useState({ start: '0', end: '5' });
  useEffect(() => {
    if (p.pendingPoint) setChoice('canvas');
    else if (node) setChoice((c) => (c === 'canvas' || c === 'timeline' ? c : 'node'));
  }, [p.pendingPoint, node]);
  const threads = p.comments?.threads;
  const visible = useMemo(() => (threads ?? []).filter((t) => matchesFilter(t, filter, p.me ?? '')), [threads, filter, p.me]);
  const refresh = () => qc.invalidateQueries({ queryKey: collabKeys.comments(p.projectId) });

  const anchor = (): CommentAnchor | null => {
    if (choice === 'node' && node) return { kind: 'node', nodeId: node };
    if (choice === 'version' && node && version) return { kind: 'version', nodeId: node, versionId: version };
    if (choice === 'canvas' && p.pendingPoint) return { kind: 'canvas', x: Math.round(p.pendingPoint.x), y: Math.round(p.pendingPoint.y) };
    if (choice === 'timeline' && p.canvasId) {
      const start = Math.max(0, Number(range.start) || 0);
      const end = Math.max(start, Number(range.end) || start);
      return { kind: 'timeline', canvasId: p.canvasId, start, end };
    }
    return null;
  };

  return (
    <div className={styles.tabBody}>
      <div className={styles.composerBox} data-testid="new-comment">
        <div className={styles.anchorRow} role="radiogroup" aria-label={intl.formatMessage({ id: 'collab.new.anchor' })}>
          {(['node', 'version', 'canvas', 'timeline'] as const).map((c) => {
            const disabled = (c === 'node' && !node) || (c === 'version' && !version) || (c === 'timeline' && !p.canvasId);
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={choice === c}
                disabled={disabled}
                className={styles.chip}
                data-testid={`anchor-${c}`}
                onClick={() => {
                  setChoice(c);
                  if (c === 'canvas' && !p.pendingPoint) p.onPickPoint();
                }}
              >
                <FormattedMessage id={`collab.new.anchor.${c}`} />
              </button>
            );
          })}
        </div>
        <p className={styles.hint}>
          {choice === 'node' && node ? <FormattedMessage id="collab.new.onNode" values={{ title: p.nodeTitle(node) ?? '' }} /> : null}
          {choice === 'version' && node ? <FormattedMessage id="collab.new.onVersion" values={{ title: p.nodeTitle(node) ?? '' }} /> : null}
          {choice === 'canvas' ? <FormattedMessage id={p.pendingPoint ? 'collab.new.onPoint' : 'collab.new.pickPoint'} /> : null}
          {choice === 'node' && !node ? <FormattedMessage id="collab.new.selectNode" /> : null}
        </p>
        {choice === 'timeline' ? (
          <div className={styles.rangeRow}>
            <label>
              <FormattedMessage id="collab.new.start" />
              <input inputMode="decimal" value={range.start} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value.replace(/[^\d.]/g, '') }))} className={styles.smallInput} />
            </label>
            <label>
              <FormattedMessage id="collab.new.end" />
              <input inputMode="decimal" value={range.end} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value.replace(/[^\d.]/g, '') }))} className={styles.smallInput} />
            </label>
          </div>
        ) : null}
        <Composer
          members={p.comments?.members ?? []}
          me={p.me}
          placeholder={intl.formatMessage({ id: 'collab.new.placeholder' })}
          submitLabel={intl.formatMessage({ id: 'collab.new.submit' })}
          disabled={!anchor()}
          testId="comment-input"
          onSubmit={async (body, mentions) => {
            const a = anchor();
            if (!a) return false;
            try {
              const t = await createThread(p.projectId, { anchor: a, body, mentions });
              p.onClearPoint();
              setFilter('open');
              p.onFocusThread(t.id);
              await refresh();
              return true;
            } catch (e) {
              toast.show({ message: errorText(intl, e) });
              return false;
            }
          }}
        />
      </div>

      <div className={styles.filters} role="toolbar" aria-label={intl.formatMessage({ id: 'collab.filter.label' })}>
        {COMMENT_FILTERS.map((f) => (
          <button key={f} type="button" className={styles.chip} aria-pressed={filter === f} data-testid={`filter-${f}`} onClick={() => setFilter(f)}>
            <FormattedMessage id={`collab.filter.${f}`} />
          </button>
        ))}
      </div>

      <div className={styles.list} role="list" data-testid="thread-list">
        {!p.comments ? [0, 1].map((i) => <Skeleton key={i} width="100%" height={64} radius={12} />) : null}
        {p.comments && !visible.length ? (
          <p className={styles.empty}>
            <FormattedMessage id={filter === 'open' ? 'collab.empty.open' : 'collab.empty.filtered'} />
          </p>
        ) : null}
        {visible.map((t) => (
          <ThreadCard key={t.id} thread={t} {...p} expanded={p.focusThread === t.id} onToggle={() => p.onFocusThread(p.focusThread === t.id ? null : t.id)} refresh={refresh} />
        ))}
      </div>
    </div>
  );
}

function ThreadCard({ thread: t, expanded, onToggle, refresh, ...p }: CollabPanelProps & { thread: ThreadView; expanded: boolean; onToggle: () => void; refresh: () => Promise<void> }) {
  const intl = useIntl();
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const first = t.comments.find((c) => !c.deleted) ?? t.comments[0]!;
  const replies = t.comments.filter((c) => !c.deleted).length - 1;
  const canResolve = p.role !== 'viewer';
  useEffect(() => {
    if (!expanded) return;
    ref.current?.scrollIntoView({ block: 'nearest' });
    if (t.unread) void markThreadsRead(p.projectId, [t.id]).then(refresh);
  }, [expanded, t.unread, t.id, p.projectId, refresh]);
  const anchorNode = t.anchor.kind === 'node' || t.anchor.kind === 'version' ? t.anchor.nodeId : null;
  return (
    <div ref={ref} role="listitem" className={styles.thread} data-status={t.status} data-unread={t.unread || undefined} data-testid="thread">
      <button type="button" className={styles.threadHead} aria-expanded={expanded} onClick={onToggle}>
        <span className={styles.threadMeta}>
          {t.unread ? <span className={styles.dot} aria-label={intl.formatMessage({ id: 'collab.thread.unread' })} /> : null}
          <span className={styles.anchorTag}>{anchorLabel(intl, t.anchor, p.nodeTitle)}</span>
          {t.reviewId ? <span className={styles.tag}><FormattedMessage id="collab.thread.client" /></span> : null}
          {t.status === 'resolved' ? <span className={styles.tag}><FormattedMessage id="collab.thread.resolved" /></span> : null}
        </span>
        <span className={styles.threadFirst}>
          <strong>{first.author.name}</strong> {first.body}
        </span>
        {!expanded && replies > 0 ? (
          <span className={styles.threadReplies}>
            <FormattedMessage id="collab.thread.replies" values={{ n: replies }} />
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className={styles.threadBody}>
          {t.comments.map((c) => (
            <div key={c.id} className={styles.comment} data-testid="comment">
              <Avatar name={c.author.name} image={null} size={22} />
              <div className={styles.commentMain}>
                <div className={styles.commentHead}>
                  <strong>{c.author.name}</strong>
                  {c.author.kind === 'reviewer' ? <span className={styles.tag}><FormattedMessage id="collab.thread.client" /></span> : null}
                  <time dateTime={new Date(c.createdAt).toISOString()}>{intl.formatTime(c.createdAt, { hour: 'numeric', minute: '2-digit' })}</time>
                  {c.editedAt ? <span className={styles.muted}><FormattedMessage id="collab.comment.edited" /></span> : null}
                </div>
                {c.deleted ? (
                  <p className={styles.muted}><FormattedMessage id="collab.comment.deleted" /></p>
                ) : editing === c.id ? (
                  <Composer
                    members={p.comments?.members ?? []}
                    me={p.me}
                    initial={c.body}
                    initialMentions={c.mentions}
                    submitLabel={intl.formatMessage({ id: 'collab.comment.save' })}
                    placeholder=""
                    onCancel={() => setEditing(null)}
                    onSubmit={async (body, mentions) => {
                      try {
                        await editComment(p.projectId, t.id, c.id, body, mentions);
                        setEditing(null);
                        await refresh();
                        return true;
                      } catch (e) {
                        toast.show({ message: errorText(intl, e) });
                        return false;
                      }
                    }}
                  />
                ) : (
                  <p className={styles.commentText}>{c.body}</p>
                )}
                {!c.deleted && editing !== c.id && c.author.kind === 'member' && (c.author.id === p.me || p.role === 'owner') ? (
                  <div className={styles.commentActions}>
                    {c.author.id === p.me ? (
                      <button type="button" className={styles.linkBtn} onClick={() => setEditing(c.id)}>
                        <FormattedMessage id="collab.comment.edit" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={styles.linkBtn}
                      onClick={() =>
                        void deleteComment(p.projectId, t.id, c.id).then(
                          () => refresh(),
                          (e: unknown) => toast.show({ message: errorText(intl, e) }),
                        )
                      }
                    >
                      <FormattedMessage id="collab.comment.delete" />
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          <Composer
            members={p.comments?.members ?? []}
            me={p.me}
            placeholder={intl.formatMessage({ id: 'collab.reply.placeholder' })}
            submitLabel={intl.formatMessage({ id: 'collab.reply.submit' })}
            testId="reply-input"
            onSubmit={async (body, mentions) => {
              try {
                await replyThread(p.projectId, t.id, { body, mentions });
                await refresh();
                return true;
              } catch (e) {
                toast.show({ message: errorText(intl, e) });
                return false;
              }
            }}
          />
          <div className={styles.threadActions}>
            {anchorNode ? (
              <button type="button" className={styles.linkBtn} onClick={() => p.onShowNode(anchorNode)}>
                <FormattedMessage id="collab.thread.show" />
              </button>
            ) : null}
            {canResolve ? (
              <button
                type="button"
                className={styles.secondaryBtn}
                data-testid="thread-resolve"
                onClick={() =>
                  void setThreadStatus(p.projectId, t.id, t.status === 'open' ? 'resolved' : 'open').then(
                    () => {
                      toast.show({ message: intl.formatMessage({ id: t.status === 'open' ? 'collab.toast.resolved' : 'collab.toast.reopened' }) });
                      return refresh();
                    },
                    (e: unknown) => toast.show({ message: errorText(intl, e) }),
                  )
                }
              >
                <FormattedMessage id={t.status === 'open' ? 'collab.thread.resolve' : 'collab.thread.reopen'} />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Text box with @mentions: typing `@` lists the project's members; picked people are mentioned. */
function Composer({
  members,
  me,
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  initial = '',
  initialMentions = [],
  disabled,
  testId,
}: {
  members: CollabMember[];
  me: string | null;
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string, mentions: string[]) => Promise<boolean>;
  onCancel?: () => void;
  initial?: string;
  initialMentions?: string[];
  disabled?: boolean;
  testId?: string;
}) {
  const intl = useIntl();
  const [text, setText] = useState(initial);
  const [mentions, setMentions] = useState<string[]>(initialMentions);
  const [busy, setBusy] = useState(false);
  const [caret, setCaret] = useState(0);
  const query = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))?.[1];
  const options = query === undefined ? [] : members.filter((m) => m.userId !== me && m.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6);
  const area = useRef<HTMLTextAreaElement>(null);
  const pick = (m: CollabMember) => {
    const before = text.slice(0, caret).replace(/@([^\s@]*)$/, `@${m.name} `);
    const next = before + text.slice(caret);
    setText(next);
    setMentions((x) => (x.includes(m.userId) ? x : [...x, m.userId]));
    setCaret(before.length);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(before.length, before.length);
    });
  };
  const submit = async () => {
    const body = text.trim();
    if (!body || busy || disabled) return;
    setBusy(true);
    // Only people still named in the text are mentioned.
    const kept = mentions.filter((id) => {
      const m = members.find((x) => x.userId === id);
      return m && body.includes(`@${m.name}`);
    });
    const ok = await onSubmit(body, kept);
    setBusy(false);
    if (ok) {
      setText('');
      setMentions([]);
    }
  };
  return (
    <div className={styles.composer}>
      <textarea
        ref={area}
        className={styles.textarea}
        value={text}
        rows={2}
        maxLength={4000}
        placeholder={placeholder}
        aria-label={placeholder || submitLabel}
        data-testid={testId}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
        }}
        onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Enter' && options.length) {
            e.preventDefault();
            pick(options[0]!);
          } else if (e.key === 'Escape' && onCancel) onCancel();
        }}
      />
      {options.length ? (
        <div className={styles.mentions} role="listbox" aria-label={intl.formatMessage({ id: 'collab.mention.label' })}>
          {options.map((m) => (
            <button key={m.userId} type="button" role="option" aria-selected={false} className={styles.mentionOption} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m)}>
              <Avatar name={m.name} image={m.image} size={20} />
              {m.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.composerActions}>
        {onCancel ? (
          <button type="button" className={styles.linkBtn} onClick={onCancel}>
            <FormattedMessage id="collab.cancel" />
          </button>
        ) : null}
        <button type="button" className={styles.primaryBtn} disabled={!text.trim() || busy || disabled} onClick={() => void submit()} data-testid={testId ? `${testId}-submit` : undefined}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- activity

function activityText(intl: ReturnType<typeof useIntl>, e: ActivityEntry, members: CollabMember[]): ReactNode {
  const name = e.actor.name ?? members.find((m) => m.userId === e.actor.id)?.name ?? intl.formatMessage({ id: 'collab.activity.someone' });
  const d = e.data as { count?: number; title?: string | null; refunded?: number; excerpt?: string; decision?: string };
  const title = d.title ?? intl.formatMessage({ id: 'collab.anchor.removedNode' });
  switch (e.kind) {
    case 'edit':
      return intl.formatMessage({ id: e.actor.kind === 'agent' ? 'collab.activity.agentEdit' : 'collab.activity.edit' }, { name, n: d.count ?? 1 });
    case 'run.started':
      return intl.formatMessage({ id: 'collab.activity.runStarted' }, { title });
    case 'run.done':
      return intl.formatMessage({ id: 'collab.activity.runDone' }, { title });
    case 'run.failed':
      return intl.formatMessage({ id: 'collab.activity.runFailed' }, { title, n: d.refunded ?? 0 });
    case 'comment':
      return intl.formatMessage({ id: 'collab.activity.comment' }, { name, text: d.excerpt ?? '' });
    case 'comment.resolved':
      return intl.formatMessage({ id: 'collab.activity.resolved' }, { name });
    case 'comment.reopened':
      return intl.formatMessage({ id: 'collab.activity.reopened' }, { name });
    case 'review.created':
      return intl.formatMessage({ id: 'collab.activity.reviewCreated' }, { name, title: d.title ?? '' });
    case 'review.revoked':
      return intl.formatMessage({ id: 'collab.activity.reviewRevoked' }, { name, title: d.title ?? '' });
    case 'review.comment':
      return intl.formatMessage({ id: 'collab.activity.reviewComment' }, { name, text: d.excerpt ?? '' });
    case 'review.decision':
      return intl.formatMessage({ id: d.decision === 'approved' ? 'collab.activity.approved' : 'collab.activity.changes' }, { name, title: d.title ?? '' });
  }
}

function ActivityTab({ projectId, members, onShowNode, onOpenThread }: { projectId: string; members: CollabMember[]; onShowNode: (id: string) => void; onOpenThread: (id: string) => void }) {
  const intl = useIntl();
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const q = useActivity(projectId, true);
  const entries = (q.data?.entries ?? []).filter((e) => activityMatches(e.kind, filter));
  return (
    <div className={styles.tabBody}>
      <div className={styles.filters} role="toolbar" aria-label={intl.formatMessage({ id: 'collab.filter.label' })}>
        {ACTIVITY_FILTERS.map((f) => (
          <button key={f} type="button" className={styles.chip} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            <FormattedMessage id={`collab.activity.filter.${f}`} />
          </button>
        ))}
      </div>
      <div className={styles.list} role="list" data-testid="activity-list">
        {q.isLoading ? [0, 1, 2].map((i) => <Skeleton key={i} width="100%" height={40} radius={10} />) : null}
        {!q.isLoading && !entries.length ? (
          <p className={styles.empty}>
            <FormattedMessage id="collab.activity.empty" />
          </p>
        ) : null}
        {entries.map((e) => {
          const nodeId = typeof e.data.nodeId === 'string' ? e.data.nodeId : null;
          const threadId = typeof e.data.threadId === 'string' ? e.data.threadId : null;
          return (
            <div key={e.id} role="listitem" className={styles.activityRow} data-kind={e.kind} data-testid="activity-row">
              <span className={styles.activityText}>{activityText(intl, e, members)}</span>
              <span className={styles.activityMeta}>
                <time dateTime={new Date(e.updatedAt).toISOString()}>{intl.formatDate(e.updatedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
                {nodeId ? (
                  <button type="button" className={styles.linkBtn} onClick={() => onShowNode(nodeId)}>
                    <FormattedMessage id="collab.thread.show" />
                  </button>
                ) : null}
                {threadId ? (
                  <button type="button" className={styles.linkBtn} onClick={() => onOpenThread(threadId)}>
                    <FormattedMessage id="collab.activity.openThread" />
                  </button>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- review links

const EXPIRY = [0, 1, 7, 30] as const;

function ReviewsTab(p: CollabPanelProps) {
  const intl = useIntl();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useReviews(p.projectId, true);
  const canCreate = p.role !== 'viewer';
  const [title, setTitle] = useState('');
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]>(7);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [mature, setMature] = useState<'confirm' | 'refused' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: collabKeys.reviews(p.projectId) });
  const body = (): CreateReviewBody | null => {
    if (p.selection.length > 1) return { kind: 'shots', nodeIds: p.selection.slice(0, 30) };
    const n = p.selection[0];
    if (n) return { kind: 'version', nodeId: n, ...(p.activeVersion(n) ? { versionId: p.activeVersion(n)! } : {}) };
    return null;
  };
  const submit = async (confirmMature = false) => {
    const b = body();
    if (!b || busy) return;
    setBusy(true);
    try {
      const r = await createReview(p.projectId, b, { ...(title.trim() ? { title: title.trim() } : {}), ...(expiry ? { expiresInDays: expiry } : {}), ...(password ? { password } : {}), ...(confirmMature ? { confirmMature: true } : {}) });
      setMature(null);
      setTitle('');
      setPassword('');
      await copy(r.url);
      await refresh();
    } catch (e) {
      if (isApiError(e) && (e.code as string) === 'MATURE_CONFIRM_REQUIRED') setMature('confirm');
      else if (isApiError(e) && (e.data as { reason?: string } | undefined)?.reason === 'MATURE_NOT_ALLOWED') setMature('refused');
      else toast.show({ message: errorText(intl, e) });
    } finally {
      setBusy(false);
    }
  };
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.show({ message: intl.formatMessage({ id: 'collab.review.copied' }) });
    } catch {
      toast.show({ message: intl.formatMessage({ id: 'collab.review.copyFailed' }, { url }) });
    }
  };
  const target = body();
  return (
    <div className={styles.tabBody}>
      {canCreate ? (
        <div className={styles.composerBox} data-testid="new-review">
          <p className={styles.hint}>
            {target?.kind === 'shots' ? (
              <FormattedMessage id="collab.review.forShots" values={{ n: target.nodeIds.length }} />
            ) : target?.kind === 'version' ? (
              <FormattedMessage id="collab.review.forVersion" values={{ title: p.nodeTitle(target.nodeId) ?? '' }} />
            ) : (
              <FormattedMessage id="collab.review.selectFirst" />
            )}
          </p>
          <input className={styles.input} value={title} maxLength={120} placeholder={intl.formatMessage({ id: 'collab.review.titlePlaceholder' })} aria-label={intl.formatMessage({ id: 'collab.review.title' })} onChange={(e) => setTitle(e.target.value)} />
          <div className={styles.rangeRow}>
            <label>
              <FormattedMessage id="collab.review.expires" />
              <select className={styles.select} value={expiry} onChange={(e) => setExpiry(Number(e.target.value) as (typeof EXPIRY)[number])}>
                {EXPIRY.map((d) => (
                  <option key={d} value={d}>
                    {d ? intl.formatMessage({ id: 'collab.review.days' }, { n: d }) : intl.formatMessage({ id: 'collab.review.never' })}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <FormattedMessage id="collab.review.password" />
              <input className={styles.smallInput} type="password" autoComplete="new-password" value={password} minLength={6} placeholder={intl.formatMessage({ id: 'collab.review.optional' })} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </div>
          {mature === 'confirm' ? (
            <div className={styles.notice} role="alert" data-testid="review-mature-confirm">
              <FormattedMessage id="collab.review.matureConfirm" />
              <button type="button" className={styles.secondaryBtn} onClick={() => void submit(true)} disabled={busy}>
                <FormattedMessage id="collab.review.matureConfirmButton" />
              </button>
            </div>
          ) : null}
          {mature === 'refused' ? (
            <p className={styles.notice} role="alert">
              <FormattedMessage id="collab.review.matureRefused" />
            </p>
          ) : null}
          <div className={styles.composerActions}>
            <button type="button" className={styles.primaryBtn} disabled={!target || busy || (password.length > 0 && password.length < 6)} onClick={() => void submit(false)} data-testid="review-create">
              <FormattedMessage id="collab.review.create" />
            </button>
          </div>
        </div>
      ) : null}
      <div className={styles.list} role="list" data-testid="review-list">
        {q.isLoading ? <Skeleton width="100%" height={64} radius={12} /> : null}
        {!q.isLoading && !(q.data ?? []).length ? (
          <p className={styles.empty}>
            <FormattedMessage id="collab.review.empty" />
          </p>
        ) : null}
        {(q.data ?? []).map((r) => (
          <ReviewRow key={r.id} review={r} canManage={canCreate} onCopy={() => void copy(r.url)} onRevoke={() => void updateReview(p.projectId, r.id, { revoke: true }).then(refresh, (e: unknown) => toast.show({ message: errorText(intl, e) }))} />
        ))}
      </div>
    </div>
  );
}

function ReviewRow({ review: r, canManage, onCopy, onRevoke }: { review: ReviewOwnerView; canManage: boolean; onCopy: () => void; onRevoke: () => void }) {
  const intl = useIntl();
  const live = r.state === 'active';
  return (
    <div role="listitem" className={styles.review} data-testid="review-row" data-status={r.status} data-state={r.state}>
      <div className={styles.reviewHead}>
        <strong className={styles.reviewTitle}>{r.title}</strong>
        <span className={styles.status} data-status={live ? r.status : r.state}>
          <FormattedMessage id={live ? `collab.review.status.${r.status}` : `collab.review.state.${r.state}`} />
        </span>
      </div>
      <p className={styles.muted}>
        {[
          intl.formatMessage({ id: 'collab.review.items' }, { n: r.items.length }),
          r.hasPassword ? intl.formatMessage({ id: 'collab.review.hasPassword' }) : null,
          r.expiresAt ? intl.formatMessage({ id: 'collab.review.expiresOn' }, { date: intl.formatDate(r.expiresAt, { month: 'short', day: 'numeric' }) }) : null,
          r.mature ? intl.formatMessage({ id: 'collab.review.mature' }) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {r.decisions.map((d) => (
        <p key={d.reviewerId} className={styles.decision} data-decision={d.decision}>
          <FormattedMessage id={d.decision === 'approved' ? 'collab.review.decision.approved' : 'collab.review.decision.changes'} values={{ name: d.name }} />
          {d.note ? <span className={styles.muted}> “{d.note}”</span> : null}
        </p>
      ))}
      {live ? (
        <div className={styles.threadActions}>
          <button type="button" className={styles.linkBtn} onClick={onCopy}>
            <FormattedMessage id="collab.review.copy" />
          </button>
          {canManage ? (
            <button type="button" className={styles.linkBtn} onClick={onRevoke} data-testid="review-revoke">
              <FormattedMessage id="collab.review.revoke" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function errorText(intl: ReturnType<typeof useIntl>, e: unknown): string {
  if (isApiError(e) && e.code === 'FORBIDDEN') return intl.formatMessage({ id: 'collab.error.forbidden' });
  if (isApiError(e) && e.code === 'RATE_LIMITED') return intl.formatMessage({ id: 'collab.error.rate' });
  return intl.formatMessage({ id: 'collab.error.generic' });
}
