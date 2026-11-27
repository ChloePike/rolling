import { cx } from '@rolling/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import type { PlanOption, Proposal, ThreadSummary } from '@/features/overlays/agent';
import { MenuPopover } from '@/features/canvas/layers/Menu';
import { modelLabel, useModels } from '@/lib/models';
import { ModelIcon, modelIcon } from '@/lib/modelIcons';
import { PromptIcon } from '@/features/prompt';
import { openPlanId, parseAgentText, toolLabelKey, type Inline, type ThreadMsg } from './thread';
import styles from './HomeThread.module.css';

export interface HomeThreadViewProps {
  messages: ThreadMsg[];
  busy: boolean;
  /** Selected agent LLM (public id and name, D-009) and its allowance line (D-012). */
  llm: { id: string | null; name: string; allowance: string | null };
  /** "Agent allowance for this month is used up · resets …", when it is. */
  notice: string | null;
  building: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onRetry: (msgId: string) => void;
  onBuild: (proposal: Proposal, optionIndex: number) => void;
  onDiscard: (proposal: Proposal) => void;
  onNew: () => void;
  /** The user's other recent Home conversations (server, any device); the switcher shows when there is one. */
  recent?: { items: ThreadSummary[]; currentId: string | null; onOpen: () => void; onPick: (threadId: string) => void };
}

/** “Recent” in the thread header: the user's other Home conversations, newest first. */
function RecentConversations({ recent, disabled }: { recent: NonNullable<HomeThreadViewProps['recent']>; disabled: boolean }) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const others = recent.items.filter((t) => t.id !== recent.currentId);
  if (!others.length) return null;
  return (
    <MenuPopover
      open={open}
      onOpenChange={(o) => {
        if (o) recent.onOpen();
        setOpen(o);
      }}
      label={intl.formatMessage({ id: 'home.agent.recentLabel' })}
      title={intl.formatMessage({ id: 'home.agent.recentLabel' })}
      align="end"
      trigger={(t) => (
        <button {...t} type="button" className={styles.ghost} disabled={disabled} data-testid="home-agent-recent">
          <FormattedMessage id="home.agent.recent" />
        </button>
      )}
      entries={others.map((t) => ({
        key: t.id,
        label: t.title,
        meta: intl.formatDate(t.updatedAt, { month: 'short', day: 'numeric' }),
        onSelect: () => recent.onPick(t.id),
      }))}
    />
  );
}

/** Pixels from the bottom within which the thread keeps following new text. */
const STICK_PX = 48;

function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : p.code ? <code key={i}>{p.text}</code> : <span key={i}>{p.text}</span>))}
    </>
  );
}

function AgentText({ text }: { text: string }) {
  return (
    <>
      {parseAgentText(text).map((b, i) =>
        b.type === 'p' ? (
          <p key={i}>
            <Inlines parts={b.parts} />
          </p>
        ) : b.type === 'ul' ? (
          <ul key={i}>
            {b.items.map((it, j) => (
              <li key={j}>
                <Inlines parts={it} />
              </li>
            ))}
          </ul>
        ) : (
          <ol key={i}>
            {b.items.map((it, j) => (
              <li key={j}>
                <Inlines parts={it} />
              </li>
            ))}
          </ol>
        ),
      )}
    </>
  );
}

/**
 * Home Agent mode conversation (agent panel patterns, Canvas.dc.html): user
 * and agent messages, streaming text with a typing indicator, plan proposals
 * with Build on canvas / Edit / Discard (the approval gate: the agent never
 * spends), inline errors with Retry, and a follow-up composer.
 */
export function HomeThreadView(p: HomeThreadViewProps) {
  const intl = useIntl();
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const stick = useRef(true);
  const open = openPlanId(p.messages);
  const last = p.messages[p.messages.length - 1];

  // Follow new text while the reader is at the bottom; leave them where they are when they scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [p.messages, last?.text, last?.status]);
  useEffect(() => {
    // A new message the user sent always brings the thread to the bottom.
    if (last?.role === 'agent' && last.status === 'streaming' && !last.text) stick.current = true;
  }, [last?.id, last?.role, last?.status, last?.text]);

  // A plan that arrives below the fold scrolls into view (with its Build on canvas button); plans that were
  // already there on load (a restored thread) don't move the page.
  const panelRef = useRef<HTMLElement>(null);
  const seenPlans = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = p.messages.flatMap((m) => (m.proposal ? [m.proposal.id] : []));
    if (seenPlans.current === null) {
      seenPlans.current = new Set(ids);
      return;
    }
    const fresh = ids.filter((id) => !seenPlans.current!.has(id));
    for (const id of fresh) seenPlans.current.add(id);
    if (!fresh.length) return;
    const cards = panelRef.current?.querySelectorAll<HTMLElement>('[data-testid="home-plan"]');
    const card = cards?.[cards.length - 1];
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    card?.scrollIntoView?.({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [p.messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text || p.busy) return;
    p.onSend(text);
    setDraft('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter breaks the line; Enter while an IME is composing confirms the candidate.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  };
  // Autosize the follow-up box up to six lines.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 6 * 21 + 12)}px`;
  }, [draft]);

  return (
    <section ref={panelRef} className={cx(styles.panel, 'rl-pop')} data-state="open" aria-label={intl.formatMessage({ id: 'home.agent.label' })} data-testid="home-agent">
      <header className={styles.head}>
        <span className={styles.title}>
          <FormattedMessage id="home.agent.title" />
        </span>
        <span className={styles.llm} data-testid="home-agent-llm" title={intl.formatMessage({ id: 'home.agent.llmTitle' })}>
          {p.llm.id && modelIcon(p.llm.id) ? <ModelIcon modelId={p.llm.id} size={12} /> : <PromptIcon name="cube" size={12} />}
          <span>{p.llm.name}</span>
          {p.llm.allowance ? <span className={styles.allowance}>· {p.llm.allowance}</span> : null}
        </span>
        <span className={styles.spacer} />
        {p.recent ? <RecentConversations recent={p.recent} disabled={p.busy} /> : null}
        <button type="button" className={styles.ghost} onClick={p.onNew} disabled={p.busy}>
          <FormattedMessage id="home.agent.new" />
        </button>
      </header>
      <div
        ref={scroller}
        className={styles.thread}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label={intl.formatMessage({ id: 'home.agent.log' })}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        }}
      >
        {p.messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className={cx(styles.user, styles.msgIn)} data-testid="home-agent-user">
              {m.text}
            </div>
          ) : (
            <div key={m.id} className={cx(styles.agent, styles.msgIn, m.status === 'error' && styles.agentError)} data-testid="home-agent-reply" data-status={m.status}>
              {m.text ? (
                <div className={styles.text}>
                  <AgentText text={m.text} />
                  {m.status === 'streaming' ? <span className={styles.caret} aria-hidden="true" /> : null}
                </div>
              ) : null}
              {m.status === 'streaming' && !m.text ? (
                <span className={styles.typing} role="status" data-testid="home-agent-typing">
                  <span className={styles.dots} aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <FormattedMessage id={`home.agent.tool.${toolLabelKey(m.tool) ?? 'thinking'}`} />
                </span>
              ) : null}
              {m.status === 'error' ? (
                <div className={styles.errorRow}>
                  {m.retryable !== false && m.retryText ? (
                    <button type="button" className={styles.ghost} onClick={() => p.onRetry(m.id)} disabled={p.busy}>
                      <FormattedMessage id="home.agent.retry" />
                    </button>
                  ) : null}
                </div>
              ) : null}
              {m.proposal ? (
                <PlanCard
                  proposal={m.proposal}
                  open={m.proposal.id === open}
                  building={p.building === m.proposal.id}
                  onBuild={(i) => p.onBuild(m.proposal!, i)}
                  onDiscard={() => p.onDiscard(m.proposal!)}
                  onEdit={(o) => {
                    setDraft(intl.formatMessage({ id: 'home.agent.editPrefix' }, { title: o.title }));
                    requestAnimationFrame(() => {
                      const el = input.current;
                      if (!el) return;
                      el.focus();
                      el.setSelectionRange(el.value.length, el.value.length);
                    });
                  }}
                />
              ) : null}
            </div>
          ),
        )}
      </div>
      {p.notice ? (
        <p role="status" className={styles.notice}>
          {p.notice}
        </p>
      ) : null}
      <div className={styles.composer}>
        <label htmlFor="home-agent-reply" className="rl-visually-hidden">
          <FormattedMessage id="home.agent.replyLabel" />
        </label>
        <textarea
          ref={input}
          id="home-agent-reply"
          rows={1}
          className={styles.textarea}
          placeholder={intl.formatMessage({ id: 'home.agent.replyPlaceholder' })}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {p.busy ? (
          <button type="button" className={cx(styles.send, 'rl-press')} onClick={p.onStop} aria-label={intl.formatMessage({ id: 'home.agent.stop' })}>
            <span className={styles.stopIcon} aria-hidden="true" />
          </button>
        ) : (
          <button type="button" className={cx(styles.send, 'rl-press')} onClick={submit} disabled={!draft.trim()} aria-label={intl.formatMessage({ id: 'home.agent.send' })}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </section>
  );
}

function PlanCard({
  proposal,
  open,
  building,
  onBuild,
  onDiscard,
  onEdit,
}: {
  proposal: Proposal;
  open: boolean;
  building: boolean;
  onBuild: (optionIndex: number) => void;
  onDiscard: () => void;
  onEdit: (o: PlanOption) => void;
}) {
  const intl = useIntl();
  const videos = useModels('video').data;
  const [pick, setPick] = useState(0);
  const options = proposal.body.kind === 'plan' ? proposal.body.options : [];
  const option = options[Math.min(pick, Math.max(0, options.length - 1))];
  if (!option) return null;
  const status = proposal.status === 'proposed' && !open ? 'replaced' : proposal.status;
  const risks = proposal.risks.map((r) => r.code).filter((c) => c === 'over_balance' || c === 'needs_confirm');
  // D-032: recurring people without a saved character: offer to make their sheet first.
  const sheetNames = (proposal.risks.find((r) => r.code === 'character_sheet_suggested')?.data.names as string[] | undefined) ?? [];
  const shown: ReactNode = (
    <ol className={styles.shots}>
      {option.shots.map((s) => (
        <li key={s.n} className={styles.shot}>
          <span className={styles.shotN}>{s.n}</span>
          <span className={styles.shotBody}>
            <span className={styles.shotHead}>
              <span className={styles.shotTitle}>{s.title}</span>
              <span className={styles.shotMeta}>
                <FormattedMessage id="home.agent.shotMeta" values={{ seconds: s.seconds, model: modelLabel(videos, s.model) }} />
              </span>
            </span>
            <span className={styles.shotVisual}>{s.visual}</span>
            {s.line ? <span className={styles.shotLine}>“{s.line}”</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
  return (
    <div className={styles.plan} data-testid="home-plan" data-status={status}>
      {options.length > 1 ? (
        <div role="radiogroup" aria-label={intl.formatMessage({ id: 'home.agent.options' })} className={styles.options}>
          {options.map((o, i) => (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={i === pick}
              className={styles.option}
              onClick={() => setPick(i)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                e.preventDefault();
                const n = (i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length;
                setPick(n);
                (e.currentTarget.parentElement?.children[n] as HTMLElement | undefined)?.focus();
              }}
              tabIndex={i === pick ? 0 : -1}
              data-testid={`home-plan-option-${i}`}
            >
              <span className={styles.optionTitle}>{o.title}</span>
              <span className={styles.optionMeta}>
                <FormattedMessage id="home.agent.optionMeta" values={{ seconds: o.seconds, ratio: o.ratio, n: o.estimate.credits }} />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className={styles.planHead}>
          <span className={styles.optionTitle}>{option.title}</span>
          <span className={styles.optionMeta}>
            <FormattedMessage id="home.agent.optionMeta" values={{ seconds: option.seconds, ratio: option.ratio, n: option.estimate.credits }} />
          </span>
        </div>
      )}
      {shown}
      <p className={styles.estimate}>
        <FormattedMessage id="home.agent.estimate" values={{ n: option.estimate.credits }} />
        {risks.includes('over_balance') ? (
          <>
            {' '}
            <FormattedMessage id="home.agent.risk.overBalance" />
          </>
        ) : null}
      </p>
      {status === 'proposed' && sheetNames.length ? (
        <p className={styles.estimate} data-testid="home-plan-sheet-suggested">
          <FormattedMessage id="characters.agent.sheetSuggested" values={{ names: intl.formatList(sheetNames, { type: 'conjunction' }), count: sheetNames.length }} />{' '}
          <Link to="/create/character">
            <FormattedMessage id="characters.agent.makeSheet" />
          </Link>
        </p>
      ) : null}
      {status === 'proposed' ? (
        <div className={styles.planActions}>
          <button type="button" className={cx(styles.primary, 'rl-press')} disabled={building} aria-busy={building || undefined} onClick={() => onBuild(Math.min(pick, options.length - 1))}>
            <FormattedMessage id={building ? 'home.agent.building' : 'home.agent.build'} />
          </button>
          <button type="button" className={styles.secondary} onClick={() => onEdit(option)} disabled={building}>
            <FormattedMessage id="home.agent.edit" />
          </button>
          <button type="button" className={styles.secondary} onClick={onDiscard} disabled={building}>
            <FormattedMessage id="home.agent.discard" />
          </button>
        </div>
      ) : (
        <p className={styles.planStatus} role="status">
          <FormattedMessage id={`home.agent.planStatus.${status}`} />
        </p>
      )}
    </div>
  );
}
