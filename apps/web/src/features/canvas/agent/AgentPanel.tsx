import { cx, presenceProps, type PresenceState } from '@rolling/ui';
import { useState } from 'react';
import { Paywall } from '@/features/overlays';
import { checkoutPlan } from '../api';
import { FormattedMessage, useIntl } from 'react-intl';
import { CanvasIcon } from '../icons';
import { MOCK_AGENT } from '../mocks';
import styles from './agent.module.css';

export type AgentPlan = (typeof MOCK_AGENT)['plan'];

interface Message {
  role: 'user' | 'agent';
  text: string;
  fresh?: boolean;
}

interface AgentPanelProps {
  state: PresenceState;
  onClose: () => void;
  /** Build on canvas: applies the plan proposal as nodes (free). Returns how many nodes were added. */
  onBuild: (plan: AgentPlan) => number;
  /** Using the agent needs an active plan (D-007). Non-members can type; sending opens the join paywall. */
  isMember: boolean;
  onJoined: () => void;
}

/**
 * Canvas agent panel: conversation, plan option card with cost and
 * "Build on canvas", composer with the LLM pill and Auto. The agent only
 * proposes; building nodes is free and nothing runs until the user runs it.
 */
export function AgentPanel({ state, onClose, onBuild, isMember, onJoined }: AgentPanelProps) {
  const [paywall, setPaywall] = useState(false);
  const intl = useIntl();
  const [messages, setMessages] = useState<Message[]>(MOCK_AGENT.messages);
  const [draft, setDraft] = useState('');
  const [built, setBuilt] = useState<number | null>(null);
  const plan = MOCK_AGENT.plan;

  const deliver = (text: string) => {
    setMessages((m) => [...m, { role: 'user', text, fresh: true }]);
    setDraft('');
  };
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    // NO_PLAN: keep the draft and send it once checkout completes.
    if (!isMember) {
      setPaywall(true);
      return;
    }
    deliver(text);
  };

  return (
    <aside aria-label={intl.formatMessage({ id: 'canvas.agent.label' })} className={cx(styles.panel, 'rl-panel')} {...presenceProps(state)}>
      <div className={styles.head}>
        <span className={styles.title}>
          <FormattedMessage id="canvas.agent.label" />
        </span>
        <span className={styles.skill}>{MOCK_AGENT.skill}</span>
        <span className={styles.spacer} />
        <button type="button" className={styles.close} aria-label={intl.formatMessage({ id: 'canvas.agent.hide' })} onClick={onClose}>
          <CanvasIcon name="close" size={16} />
        </button>
      </div>
      <div className={styles.thread} aria-live="polite">
        {messages.slice(0, 2).map((m, i) => (
          <div key={i} className={m.role === 'user' ? styles.user : styles.agent}>
            {m.text}
          </div>
        ))}
        <div className={styles.plan} data-testid="plan-card">
          <div className={styles.planHead}>
            <span>{plan.title}</span>
            <span className={styles.planCost}>
              <FormattedMessage id="canvas.agent.estimate" values={{ n: plan.estimate }} />
            </span>
          </div>
          {plan.shots.map((s) => (
            <div key={s.n} className={styles.shot}>
              <span className={styles.shotN} style={{ background: s.tone }}>
                {s.n}
              </span>
              <span>
                <FormattedMessage id="canvas.agent.shot" values={{ title: s.title, seconds: s.seconds, visual: s.visual }} />
              </span>
            </div>
          ))}
          {built === null ? (
            <div className={styles.planActions}>
              <button type="button" className={cx(styles.build, 'rl-press')} onClick={() => setBuilt(onBuild(plan))}>
                <FormattedMessage id="canvas.agent.build" />
              </button>
              <button type="button" className={styles.shuffle}>
                <FormattedMessage id="canvas.agent.shuffle" />
              </button>
            </div>
          ) : (
            <span className={cx(styles.built, styles.msgIn)} data-motion="" role="status">
              <FormattedMessage id="canvas.agent.built" values={{ n: built }} />
            </span>
          )}
        </div>
        {messages.slice(2).map((m, i) => (
          <div key={i + 2} className={cx(m.role === 'user' ? styles.user : styles.agent, m.fresh && styles.msgIn)} data-motion="">
            {m.text}
          </div>
        ))}
      </div>
      <div className={styles.composerWrap}>
        <div className={styles.composer}>
          <label htmlFor="canvas-ask" className="rl-visually-hidden">
            <FormattedMessage id="canvas.agent.ask" />
          </label>
          <textarea
            id="canvas-ask"
            rows={2}
            className={styles.textarea}
            placeholder={intl.formatMessage({ id: 'canvas.agent.placeholder' })}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className={styles.controls}>
            <button type="button" className={styles.plus} aria-label={intl.formatMessage({ id: 'canvas.agent.add' })}>
              <CanvasIcon name="plus" size={14} strokeWidth={2.2} />
            </button>
            <button type="button" className={styles.pill}>
              <CanvasIcon name="cube" size={13} />
              <FormattedMessage id="canvas.agent.llm" />
              <CanvasIcon name="caret" size={12} strokeWidth={2.4} className={styles.caret} />
            </button>
            <button type="button" className={cx(styles.pill, styles.pillOn)}>
              <CanvasIcon name="cube" size={13} />
              <FormattedMessage id="canvas.agent.auto" />
              <CanvasIcon name="caret" size={12} strokeWidth={2.4} className={styles.caret} />
            </button>
            <span className={styles.spacer} />
            <button type="button" className={cx(styles.send, 'rl-press')} aria-label={intl.formatMessage({ id: 'canvas.agent.send' })} onClick={send}>
              <CanvasIcon name="arrowUp" size={14} strokeWidth={2.8} />
            </button>
          </div>
        </div>
      </div>
      <Paywall
        open={paywall}
        onOpenChange={setPaywall}
        variant="join"
        onContinue={(option) => {
          void checkoutPlan(option.id).then(() => {
            setPaywall(false);
            onJoined();
            const text = draft.trim();
            if (text) deliver(text);
          });
        }}
      />
    </aside>
  );
}
