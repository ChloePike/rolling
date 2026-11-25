import { cx, presenceProps, type PresenceState } from '@rolling/ui';
import { useMemo, useRef, useState } from 'react';
import { AUTO_MODEL, ModelPicker, mockModels, Paywall, catalogToOptions } from '@/features/overlays';
import { ReferencePicker, useSkills, type RefItem } from '@/features/prompt';
import { checkoutPlan } from '@/lib/session';
import { useAgentAllowance } from '@/lib/session/agentAllowance';
import { pickerModels, useModels } from '@/lib/models';
import { ModelIcon, modelIcon } from '@/lib/modelIcons';
import { FormattedMessage, useIntl } from 'react-intl';
import { agentPlanOptions, sendAgentMessage, type GraphProposal } from '../api';
import { CanvasIcon } from '../icons';
import { MenuPopover } from '../layers/Menu';
import { MOCK_AGENT, type AgentPlanOption } from '../mocks';
import { readLocal, writeLocal } from '../storage';
import styles from './agent.module.css';

export type AgentPlan = AgentPlanOption;

interface Message {
  role: 'user' | 'agent';
  text: string;
  fresh?: boolean;
  proposal?: GraphProposal;
  /** Proposal outcome once the user acted on it. */
  outcome?: 'applied' | 'discarded' | 'stale';
}

interface AgentPanelProps {
  state: PresenceState;
  onClose: () => void;
  /** Build on canvas: applies the plan proposal as nodes (free). Returns how many nodes were added. */
  onBuild: (plan: AgentPlan) => number;
  /** Using the agent needs an active plan (D-007). Non-members can type; sending opens the join paywall. */
  isMember: boolean;
  /** Apply a graph-patch proposal as the user. False when it no longer applies. */
  onApplyProposal: (proposal: GraphProposal) => boolean;
  /** Nodes the open proposal changes (outlined on the canvas), or null. */
  onPreview: (nodeIds: string[] | null) => void;
}

/** Agent LLM choice (D-009), remembered per browser until `PATCH /api/me/prefs` carries it. */
export const AGENT_LLM_KEY = 'rolling.agent.llm';
/** Generation model the agent proposes for new nodes; `auto` uses the classifier (D-009). */
export const AGENT_MODEL_KEY = 'rolling.agent.model';

/**
 * Canvas agent panel: conversation, plan option card with cost and
 * "Build on canvas", composer with the LLM pill and Auto. The agent only
 * proposes; building nodes is free and nothing runs until the user runs it.
 */
export function AgentPanel({ state, onClose, onBuild, isMember, onApplyProposal, onPreview }: AgentPanelProps) {
  const [paywall, setPaywall] = useState(false);
  const intl = useIntl();
  const [messages, setMessages] = useState<Message[]>(MOCK_AGENT.messages);
  const [draft, setDraft] = useState('');
  const [built, setBuilt] = useState<number | null>(null);
  const [option, setOption] = useState(0);
  const [pending, setPending] = useState(false);
  const [skill, setSkill] = useState(MOCK_AGENT.skill);
  const [menu, setMenu] = useState<'plus' | 'llm' | 'model' | 'refs' | null>(null);
  const [llm, setLlm] = useState<string | null>(() => readLocal(AGENT_LLM_KEY));
  const [model, setModel] = useState<string>(() => readLocal(AGENT_MODEL_KEY) ?? AUTO_MODEL);
  const autoRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const options = agentPlanOptions();
  const plan = options[option % options.length]!;
  const skills = useSkills().data ?? [];

  // Public agent LLMs only (D-009): the catalog's chat models, never gateway ids.
  const chatAll = useModels('chat').data;
  const chat = useMemo(() => pickerModels(chatAll, { featuredOnly: false }).filter((m) => m.kind === 'chat'), [chatAll]);
  const llmModel = chat.find((m) => m.id === llm) ?? chat.find((m) => m.default) ?? chat[0];
  const llmLabel = llmModel && llm ? llmModel.name : intl.formatMessage({ id: 'canvas.agent.llm' });
  // D-012: each LLM shows the turns the monthly agent allowance has left.
  const allowance = useAgentAllowance();
  const turnsLeftLabel = (id: string) => {
    const left = allowance.turnsLeftFor(id);
    return left === null ? undefined : intl.formatMessage({ id: 'canvas.agent.turnsLeft' }, { count: left });
  };

  const videoAll = useModels('video').data;
  const videoOptions = useMemo(() => {
    const fromCatalog = videoAll ? catalogToOptions(videoAll, 'video') : [];
    return fromCatalog.length ? fromCatalog : mockModels.video;
  }, [videoAll]);
  const modelLabel = model === AUTO_MODEL ? intl.formatMessage({ id: 'canvas.agent.auto' }) : (videoOptions.find((m) => m.id === model)?.name ?? intl.formatMessage({ id: 'canvas.agent.auto' }));

  const deliver = (text: string) => {
    setMessages((m) => [...m, { role: 'user', text, fresh: true }]);
    setDraft('');
    setPending(true);
    void sendAgentMessage(text, { llm: llmModel?.id ?? 'default', model }).then((reply) => {
      setPending(false);
      setMessages((m) => [...m.map((x) => (x.proposal && !x.outcome ? { ...x, outcome: 'discarded' as const } : x)), { role: 'agent', text: reply.text, fresh: true, proposal: reply.proposal }]);
      onPreview(reply.proposal ? reply.proposal.changes.map((c) => c.nodeId) : null);
    });
  };
  const settle = (index: number, outcome: 'applied' | 'discarded') => {
    const msg = messages[index];
    if (!msg?.proposal) return;
    const result = outcome === 'applied' ? (onApplyProposal(msg.proposal) ? 'applied' : 'stale') : 'discarded';
    setMessages((m) => m.map((x, i) => (i === index ? { ...x, outcome: result } : x)));
    onPreview(null);
  };
  const send = () => {
    const text = draft.trim();
    if (!text || pending) return;
    // NO_PLAN: keep the draft and send it once checkout completes.
    if (!isMember) {
      setPaywall(true);
      return;
    }
    deliver(text);
  };

  const addRefs = (items: RefItem[]) => {
    const mentions = items.map((it) => `@[${it.name}]`).join(' ');
    setDraft((d) => (d && !d.endsWith(' ') ? `${d} ${mentions} ` : `${d}${mentions} `));
    setMenu(null);
    inputRef.current?.focus();
  };

  return (
    <aside aria-label={intl.formatMessage({ id: 'canvas.agent.label' })} className={cx(styles.panel, 'rl-panel')} {...presenceProps(state)}>
      <div className={styles.head}>
        <span className={styles.title}>
          <FormattedMessage id="canvas.agent.label" />
        </span>
        {skill ? (
          <button
            type="button"
            className={styles.skill}
            aria-label={intl.formatMessage({ id: 'canvas.agent.removeSkill' }, { skill })}
            title={intl.formatMessage({ id: 'canvas.agent.removeSkill' }, { skill })}
            onClick={() => setSkill('')}
          >
            {skill}
          </button>
        ) : null}
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
        <div className={styles.plan} data-testid="plan-card" data-option={plan.id}>
          <div key={plan.id} className={cx(styles.planBody, option > 0 && styles.msgIn)} data-motion="">
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
          </div>
          {built === null ? (
            <div className={styles.planActions}>
              <button type="button" className={cx(styles.build, 'rl-press')} onClick={() => setBuilt(onBuild(plan))}>
                <FormattedMessage id="canvas.agent.build" />
              </button>
              <button
                type="button"
                className={styles.shuffle}
                aria-label={intl.formatMessage({ id: 'canvas.agent.shuffleLabel' }, { n: ((option + 1) % options.length) + 1, total: options.length })}
                onClick={() => setOption((o) => (o + 1) % options.length)}
              >
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
            {m.proposal ? (
              <div className={styles.plan} data-testid="graph-proposal" data-outcome={m.outcome ?? 'open'}>
                <div className={styles.planHead}>
                  <span>{m.proposal.summary}</span>
                  <span className={styles.planCost}>
                    <FormattedMessage id="canvas.agent.proposal.free" />
                  </span>
                </div>
                {m.proposal.changes.map((c) => (
                  <div key={c.nodeId} className={styles.change}>
                    <span className={styles.changeTitle}>{c.title}</span>
                    <span>{c.detail}</span>
                  </div>
                ))}
                {m.outcome ? (
                  <span className={styles.built} role="status">
                    <FormattedMessage id={`canvas.agent.proposal.${m.outcome}`} />
                  </span>
                ) : (
                  <div className={styles.planActions}>
                    <button type="button" className={cx(styles.build, 'rl-press')} onClick={() => settle(i + 2, 'applied')}>
                      <FormattedMessage id="canvas.agent.proposal.apply" />
                    </button>
                    <button type="button" className={styles.shuffle} onClick={() => settle(i + 2, 'discarded')}>
                      <FormattedMessage id="canvas.agent.proposal.discard" />
                    </button>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ))}
        {pending ? (
          <div className={cx(styles.agent, styles.pending, styles.msgIn)} data-motion="" role="status">
            <FormattedMessage id="canvas.agent.thinking" />
          </div>
        ) : null}
      </div>
      <div className={styles.composerWrap}>
        {menu === 'refs' ? (
          <div className={styles.refs}>
            <ReferencePicker autoFocus onAdd={addRefs} onClose={() => setMenu(null)} />
          </div>
        ) : null}
        <ModelPicker
          kind="video"
          open={menu === 'model'}
          value={model}
          models={videoOptions}
          anchorRef={autoRef}
          placement="above"
          className={styles.modelPicker}
          onClose={() => setMenu(null)}
          onValueChange={(id) => {
            setModel(id);
            writeLocal(AGENT_MODEL_KEY, id);
            setMenu(null);
          }}
        />
        {allowance.exhausted ? (
          <p role="status" className={styles.allowanceNotice}>
            <FormattedMessage id="canvas.agent.allowanceUsedUp" values={{ date: intl.formatDate(allowance.resetsAt, { month: 'short', day: 'numeric' }) }} />
          </p>
        ) : null}
        <div className={styles.composer}>
          <label htmlFor="canvas-ask" className="rl-visually-hidden">
            <FormattedMessage id="canvas.agent.ask" />
          </label>
          <textarea
            ref={inputRef}
            id="canvas-ask"
            rows={2}
            className={styles.textarea}
            placeholder={intl.formatMessage({ id: 'canvas.agent.placeholder' })}
            value={draft}
            onChange={(e) => {
              const v = e.target.value;
              setDraft(v);
              if (v.endsWith('@')) setMenu('refs');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className={styles.controls}>
            <MenuPopover
              open={menu === 'plus'}
              onOpenChange={(o) => setMenu(o ? 'plus' : null)}
              label={intl.formatMessage({ id: 'canvas.agent.add' })}
              side="top"
              entries={[
                { key: 'refs', label: intl.formatMessage({ id: 'canvas.agent.addRef' }), meta: '@', keepOpen: true, onSelect: () => setMenu('refs') },
                ...skills
                  .filter((s) => s.kind === 'skill')
                  .map((s) => ({ key: s.id, label: `/${s.name}`, checked: skill === `/${s.name}`, onSelect: () => setSkill(`/${s.name}`) })),
              ]}
              trigger={(t) => (
                <button {...t} type="button" className={styles.plus} aria-label={intl.formatMessage({ id: 'canvas.agent.add' })}>
                  <CanvasIcon name="plus" size={14} strokeWidth={2.2} />
                </button>
              )}
            />
            <MenuPopover
              open={menu === 'llm'}
              onOpenChange={(o) => setMenu(o ? 'llm' : null)}
              label={intl.formatMessage({ id: 'canvas.agent.llmLabel' })}
              title={intl.formatMessage({ id: 'canvas.agent.llmLabel' })}
              side="top"
              entries={
                chat.length
                  ? chat.map((m) => ({
                      key: m.id,
                      label: m.name,
                      meta: turnsLeftLabel(m.id),
                      checked: m.id === llmModel?.id,
                      onSelect: () => {
                        setLlm(m.id);
                        writeLocal(AGENT_LLM_KEY, m.id);
                      },
                    }))
                  : [
                      {
                        key: 'default',
                        label: intl.formatMessage({ id: 'canvas.agent.llmDefault' }),
                        checked: true,
                        onSelect: () => {},
                      },
                    ]
              }
              trigger={(t) => (
                <button {...t} type="button" className={styles.pill} aria-label={intl.formatMessage({ id: 'canvas.agent.llmPill' }, { name: llmLabel })}>
                  {modelIcon(llmModel?.id ?? 'deepseek/deepseek-v4.1-flash') ? (
                    <ModelIcon modelId={llmModel?.id ?? 'deepseek/deepseek-v4.1-flash'} size={13} />
                  ) : (
                    <CanvasIcon name="cube" size={13} />
                  )}
                  <span className={styles.pillText}>{llmLabel}</span>
                  <CanvasIcon name="caret" size={12} strokeWidth={2.4} className={styles.caret} />
                </button>
              )}
            />
            <button
              ref={autoRef}
              type="button"
              className={cx(styles.pill, styles.pillOn)}
              aria-haspopup="dialog"
              aria-expanded={menu === 'model'}
              aria-label={intl.formatMessage({ id: 'canvas.agent.modelPill' }, { name: modelLabel })}
              onClick={() => setMenu((m) => (m === 'model' ? null : 'model'))}
            >
              {model !== AUTO_MODEL && modelIcon(model) ? <ModelIcon modelId={model} size={13} /> : <CanvasIcon name="cube" size={13} />}
              <span className={styles.pillText}>{modelLabel}</span>
              <CanvasIcon name="caret" size={12} strokeWidth={2.4} className={styles.caret} />
            </button>
            <span className={styles.spacer} />
            <button
              type="button"
              className={cx(styles.send, 'rl-press')}
              aria-label={intl.formatMessage({ id: 'canvas.agent.send' })}
              aria-busy={pending || undefined}
              onClick={send}
            >
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
            const text = draft.trim();
            if (text) deliver(text);
          });
        }}
      />
    </aside>
  );
}
