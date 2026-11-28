import { cx, presenceProps, Skeleton, useToast, type PresenceState } from '@rolling/ui';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { AUTO_MODEL, ModelPicker, Paywall, catalogToOptions } from '@/features/overlays';
import { mockData } from '@/lib/api/mode';
import { useSkills, type RefItem } from '@/features/prompt';
import { useAssetPicker } from '@/features/picker';
import { UpgradeGate } from '@/lib/upgrade/store';
import { useAgentAllowance } from '@/lib/session/agentAllowance';
import { pickerModels, useModels } from '@/lib/models';
import { ModelIcon, modelIcon } from '@/lib/modelIcons';
import { FormattedMessage, useIntl } from 'react-intl';
import {
  agentFailure,
  attachThread,
  existingThread,
  getThread,
  projectThreads,
  recentThreads,
  rememberThread,
  undoAuto,
  type AutoRun,
  type AutoTurn,
  type Thread,
  type TurnSettings,
} from '@/features/overlays/agent';
import { AgentModeSwitch, AutoSummary, useAgentMode } from '@/features/agent-mode';
import { isMockApi, savePendingAction, takePendingAction } from '@/features/overlays/backend';
import { agentPlanOptions, applyAgentProposal, discardAgentProposal, graphProposalFrom, planOptionsFrom, sendAgentMessage, type GraphProposal } from '../api';
import type { GraphNode } from '@rolling/core/graph';
import { CanvasIcon } from '../icons';
import { MenuPopover } from '../layers/Menu';
import type { AgentPlanOption } from '../mocks';
import { readLocal, writeLocal } from '../storage';
import { parseAgentText, type Inline } from './agentText';
import { peekHandoff, startedFromHome, takeHandoff, type AgentHandoff } from './handoff';
import styles from './agent.module.css';

export type AgentPlan = AgentPlanOption;

interface Message {
  role: 'user' | 'agent';
  text: string;
  fresh?: boolean;
  /** User messages: names of the `@` references sent with it (a brief from Home). */
  refNames?: string[];
  /** Agent messages: the plan proposal this reply made (the plan card shows under it while it is the open one). */
  planId?: string;
  proposal?: GraphProposal;
  /** Proposal outcome once the user acted on it. */
  outcome?: 'applied' | 'discarded' | 'stale';
  /** D-021 Auto turns: what the agent changed and ran, against the turn budget. */
  auto?: AutoTurn;
}

interface AgentPanelProps {
  state: PresenceState;
  onClose: () => void;
  /** Build on canvas: applies the plan proposal as nodes (free). Returns how many nodes were added. */
  onBuild: (plan: AgentPlan) => number;
  /** Using the agent needs an active plan (D-007). Non-members can type; sending opens the join paywall. */
  isMember: boolean;
  /** Apply a graph-patch proposal as the user. False when it no longer applies. */
  onApplyProposal: (proposal: GraphProposal) => boolean | Promise<boolean>;
  /** Real mode: the project whose canvas thread this panel talks to. */
  projectId?: string;
  /** Selected node ids (sent with the turn) and the current nodes (to describe patches). */
  selection?: string[];
  nodes?: GraphNode[];
  /** Nodes the open proposal changes (outlined on the canvas), or null. */
  onPreview: (nodeIds: string[] | null) => void;
  /** D-021: a run Auto left for approval goes through the normal run flow (quote, confirm per threshold). */
  onRunNodes?: (nodeIds: string[]) => void;
  /** Mock mode: undo the change Auto applied locally. */
  onUndoLocal?: () => void;
}

/** What a turn carries beyond the text: a brief from Home sets them all (D-038); the composer uses the panel's own. */
interface DeliverExtra {
  refs?: string[];
  refNames?: string[];
  skill?: string | null;
  llm?: string | null;
  settings?: TurnSettings;
  mode?: AgentHandoff['mode'];
  autoBudget?: number;
}

/** An agent reply: the small Markdown subset it writes (paragraphs, lists, bold, code), as text nodes only. */
function AgentText({ text }: { text: string }) {
  const blocks = parseAgentText(text);
  const inline = (parts: Inline[]) =>
    parts.map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : p.code ? <code key={i}>{p.text}</code> : <Fragment key={i}>{p.text}</Fragment>));
  return (
    <>
      {blocks.map((b, i) =>
        b.type === 'p' ? (
          <p key={i} className={styles.para}>
            {inline(b.parts)}
          </p>
        ) : b.type === 'ul' ? (
          <ul key={i} className={styles.list}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </ul>
        ) : (
          <ol key={i} className={styles.list}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </ol>
        ),
      )}
    </>
  );
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
export function AgentPanel({ state, onClose, onBuild, isMember, onApplyProposal, onPreview, projectId, selection, nodes, onRunNodes, onUndoLocal }: AgentPanelProps) {
  const mock = isMockApi();
  const real = !mock && !!projectId;
  // D-021: Read / Edit / Auto, remembered per project (default from Preferences).
  const agentMode = useAgentMode(projectId ? `canvas:${projectId}` : 'canvas');
  const threadId = useRef<string | null>(null);
  const [undoBusy, setUndoBusy] = useState<Set<string>>(() => new Set());
  const [undoFailed, setUndoFailed] = useState<Set<string>>(() => new Set());
  const [approved, setApproved] = useState<Set<string>>(() => new Set());
  const [liveAuto, setLiveAuto] = useState<AutoTurn | null>(null);
  const [paywall, setPaywall] = useState(false);
  const intl = useIntl();
  const toast = useToast();
  // D-038: a project a Home brief started shows no demo conversation (mock mode) and sends the brief on open.
  const [fromHome] = useState(() => startedFromHome(projectId) || peekHandoff(projectId) !== null);
  const demo = mock && !fromHome;
  const [messages, setMessages] = useState<Message[]>(() => {
    if (!demo) return [];
    const m = mockData().canvas.MOCK_AGENT;
    return m.messages.map((x, i) => (i === m.messages.length - 1 ? { ...x, planId: m.plan.id } : x));
  });
  /** The open plan proposal of the thread (Build on canvas applies one option); its card shows under the reply that made it. */
  const [planProposal, setPlanProposal] = useState<{ proposalId: string; options: AgentPlanOption[] } | null>(() =>
    demo ? { proposalId: mockData().canvas.MOCK_AGENT.plan.id, options: agentPlanOptions() } : null,
  );
  const [draft, setDraft] = useState('');
  const [built, setBuilt] = useState<number | null>(null);
  const [option, setOption] = useState(0);
  const [pending, setPending] = useState(false);
  // Real mode: the stored conversation is being read (a loading state, never demo content).
  const [restoring, setRestoring] = useState(real);
  const [skill, setSkill] = useState(() => (demo ? mockData().canvas.MOCK_AGENT.skill : (peekHandoff(projectId)?.skill ?? '')));
  const [menu, setMenu] = useState<'plus' | 'llm' | 'model' | 'history' | null>(null);
  const [llm, setLlm] = useState<string | null>(() => peekHandoff(projectId)?.llm ?? readLocal(AGENT_LLM_KEY));
  const [model, setModel] = useState<string>(() => {
    const h = peekHandoff(projectId);
    return h ? (h.settings.videoModel ?? AUTO_MODEL) : (readLocal(AGENT_MODEL_KEY) ?? AUTO_MODEL);
  });
  /** The Home pills (ratio, length) a brief from Home carried: every turn of this panel keeps sending them. */
  const turnSettings = useRef<TurnSettings | null>(peekHandoff(projectId)?.settings ?? null);
  const autoRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const options = planProposal?.options ?? [];
  const plan = options.length ? options[option % options.length]! : null;

  /** Shows a stored thread: its messages, Auto summaries and the open plan. */
  const showThread = (t: Thread) => {
    threadId.current = t.id;
    agentMode.adopt(t.mode);
    const byId = new Map(t.proposals.map((p) => [p.id, p]));
    const autoByMessage = new Map((t.auto ?? []).filter((a) => a.messageId).map((a) => [a.messageId!, a]));
    const openPlan = [...t.proposals].reverse().find((p) => p.kind === 'plan' && p.status === 'proposed');
    setMessages(
      t.messages.map((m) => {
        const auto = autoByMessage.get(m.id);
        const p = m.proposalId ? byId.get(m.proposalId) : undefined;
        // A change Auto applied shows in its summary, not as a proposal card.
        const gp = p && !(auto && p.status === 'applied') ? graphProposalFrom(p, nodes) : null;
        const outcome = p && p.status !== 'proposed' ? (p.status as Message['outcome']) : undefined;
        return {
          role: m.role === 'user' ? 'user' : 'agent',
          text: m.content,
          ...(gp ? { proposal: gp, outcome } : {}),
          ...(auto ? { auto } : {}),
          ...(openPlan && m.proposalId === openPlan.id ? { planId: openPlan.id } : {}),
        };
      }),
    );
    setPlanProposal(openPlan ? { proposalId: openPlan.id, options: planOptionsFrom(openPlan) } : null);
    setOption(0);
    setBuilt(null);
  };

  /** D-038: the brief Home handed over goes out as this thread's first message, with the prompt box's choices. */
  const sendHandoff = (h: AgentHandoff) => {
    agentMode.setMode(h.mode);
    if (h.llm) setLlm(h.llm);
    turnSettings.current = h.settings;
    deliverRef.current(h.text, { refs: h.refs, refNames: h.refNames, skill: h.skill, llm: h.llm, settings: h.settings, mode: h.mode, ...(h.autoBudget !== undefined ? { autoBudget: h.autoBudget } : {}) });
  };

  // Real mode: restore the canvas thread's conversation and its open proposals.
  useEffect(() => {
    if (!real) return;
    let live = true;
    // Only an existing thread is read here; a new one is created on the first send (members only, D-007).
    // A browser that never opened this project's thread (another device) gets its latest one from the server.
    const restore = async (): Promise<Thread | null> => {
      const t = await existingThread(`canvas:${projectId}`);
      if (t || peekHandoff(projectId)) return t;
      const [latest] = await projectThreads(projectId!, 10).catch(() => []);
      if (!latest) return null;
      const found = await getThread(latest.id).catch(() => null);
      if (found) rememberThread(`canvas:${projectId}`, found.id);
      return found;
    };
    restore().then(
      (t) => {
        if (!live) return;
        setRestoring(false);
        if (t) showThread(t);
        const handoff = takeHandoff(projectId);
        if (handoff) return sendHandoff(handoff);
        // A brief interrupted by the join paywall resumes after checkout (D-007).
        const pendingText = takePendingAction<{ projectId: string; text: string }>('canvas.agent');
        if (pendingText?.projectId === projectId && pendingText.text) deliverRef.current(pendingText.text);
      },
      () => live && setRestoring(false),
    );
    return () => {
      live = false;
    };
    // Once per project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [real, projectId]);

  // Mock mode: the brief from Home is sent once the panel is up (a timer, so a double mount sends it once).
  useEffect(() => {
    if (real) return;
    const t = setTimeout(() => {
      const handoff = takeHandoff(projectId);
      if (handoff) sendHandoff(handoff);
    }, 0);
    return () => clearTimeout(t);
    // Once per project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [real, projectId]);
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
    // Real mode: the synced catalog only (empty while it loads); mock mode falls back to the design list.
    return fromCatalog.length || !isMockApi() ? fromCatalog : mockData().overlays.mockModels.video;
  }, [videoAll]);
  const modelLabel = model === AUTO_MODEL ? intl.formatMessage({ id: 'canvas.agent.auto' }) : (videoOptions.find((m) => m.id === model)?.name ?? intl.formatMessage({ id: 'canvas.agent.auto' }));

  const [streamed, setStreamed] = useState('');
  const failText = (e: unknown): string | null => {
    const f = agentFailure(e);
    switch (f.kind) {
      case 'join':
        savePendingAction('canvas.agent', { projectId, text: lastSent.current });
        setDraft(lastSent.current);
        setMessages((m) => m.slice(0, -1));
        setPaywall(true);
        return null;
      case 'allowance':
        return intl.formatMessage({ id: 'canvas.agent.error.allowance' }, { date: f.resetsAt ? intl.formatDate(f.resetsAt, { month: 'short', day: 'numeric' }) : '' });
      case 'rateLimited':
        return intl.formatMessage({ id: 'canvas.agent.error.rateLimited' }, { seconds: f.retryAfter ?? 0 });
      case 'busy':
        return intl.formatMessage({ id: 'canvas.agent.error.busy' });
      case 'offline':
        return intl.formatMessage({ id: 'canvas.agent.error.offline' });
      default:
        return intl.formatMessage({ id: 'canvas.agent.error.generic' });
    }
  };
  const lastSent = useRef('');
  const deliver = (text: string, extra: DeliverExtra = {}) => {
    lastSent.current = text;
    setMessages((m) => [...m, { role: 'user', text, fresh: true, ...(extra.refNames?.length ? { refNames: extra.refNames } : {}) }]);
    setDraft('');
    setPending(true);
    setStreamed('');
    const mode = extra.mode ?? agentMode.mode;
    const budget = extra.autoBudget ?? agentMode.budget;
    const settings = extra.settings ?? (turnSettings.current ? { ...turnSettings.current, videoModel: model === AUTO_MODEL ? null : model } : undefined);
    setLiveAuto(null);
    void sendAgentMessage(text, {
      llm: extra.llm ?? llmModel?.id ?? 'default',
      model,
      projectId: real ? projectId : undefined,
      selection,
      nodes,
      mode,
      autoBudget: budget,
      ...(extra.refs?.length ? { refs: extra.refs } : {}),
      ...(settings ? { settings } : {}),
      skill: extra.skill !== undefined ? extra.skill : skill || null,
      onDelta: (d) => setStreamed((s) => s + d),
      onAuto: setLiveAuto,
    }).then(
      async (reply) => {
        if (reply.threadId) threadId.current = reply.threadId;
        // Mock Auto: the change applies here (the real server applied it already) and the run follows the budget.
        let auto = reply.auto ?? undefined;
        let proposal = reply.proposal;
        if (mock && mode === 'auto' && proposal) {
          const ok = await Promise.resolve(onApplyProposal(proposal));
          if (ok) {
            auto = mockAutoTurn(proposal, text, budget, nodes ?? []);
            proposal = undefined;
          }
        }
        setPending(false);
        setStreamed('');
        setLiveAuto(null);
        const replyText = reply.reason === 'safety_blocked' ? reply.text || intl.formatMessage({ id: 'canvas.agent.error.safety' }) : reply.text;
        setMessages((m) => [
          ...m.map((x) => (x.proposal && !x.outcome ? { ...x, outcome: 'discarded' as const } : x)),
          { role: 'agent', text: replyText, fresh: true, proposal, ...(auto ? { auto } : {}), ...(reply.plan ? { planId: reply.plan.proposalId } : {}) },
        ]);
        if (reply.plan) {
          setPlanProposal(reply.plan);
          setOption(0);
          // Mock Auto (D-021): the plan's first option is built without a click, as the server does.
          setBuilt(mock && mode === 'auto' && reply.plan.options[0] ? onBuild(reply.plan.options[0]) : null);
        }
        onPreview(proposal ? proposal.changes.map((c) => c.nodeId) : auto?.changes.length ? auto.changes.flatMap((c) => c.nodeIds) : null);
      },
      (e: unknown) => {
        setPending(false);
        setStreamed('');
        setLiveAuto(null);
        const t = failText(e);
        if (t) setMessages((m) => [...m, { role: 'agent', text: t, fresh: true }]);
      },
    );
  };
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;

  /* ---------- D-021 Auto: undo and approvals ---------- */
  const patchAuto = (turnId: string, fn: (a: AutoTurn) => AutoTurn) => setMessages((list) => list.map((x) => (x.auto?.turnId === turnId ? { ...x, auto: fn(x.auto) } : x)));
  const undo = (target: { changeId: string } | { turnId: string }) => {
    const owner = messages.find((x) => x.auto && ('turnId' in target ? x.auto.turnId === target.turnId : x.auto.changes.some((c) => c.id === target.changeId)))?.auto;
    if (!owner) return;
    const ids = 'turnId' in target ? owner.changes.filter((c) => c.status === 'applied').map((c) => c.id) : [target.changeId];
    if (!real || !threadId.current) {
      // Mock: the local room undoes the change Auto applied.
      for (const _ of ids) onUndoLocal?.();
      patchAuto(owner.turnId, (a) => ({ ...a, changes: a.changes.map((c) => (ids.includes(c.id) ? { ...c, status: 'undone' } : c)) }));
      return;
    }
    setUndoBusy((s) => new Set([...s, ...ids]));
    void undoAuto(threadId.current, target).then(
      (r) => {
        setUndoBusy((s) => new Set([...s].filter((id) => !ids.includes(id))));
        if (r.auto) patchAuto(owner.turnId, () => ({ ...r.auto!, turnId: owner.turnId }));
        if (r.failed.length) setUndoFailed((s) => new Set([...s, ...r.failed.map((f) => f.id)]));
      },
      () => {
        setUndoBusy((s) => new Set([...s].filter((id) => !ids.includes(id))));
        setUndoFailed((s) => new Set([...s, ...ids]));
      },
    );
  };
  const approveRun = (r: AutoRun) => {
    setApproved((s) => new Set([...s, r.id]));
    onRunNodes?.(r.nodeIds);
  };
  const settle = (index: number, outcome: 'applied' | 'discarded') => {
    const msg = messages[index];
    if (!msg?.proposal) return;
    onPreview(null);
    if (outcome === 'discarded') {
      setMessages((m) => m.map((x, i) => (i === index ? { ...x, outcome: 'discarded' } : x)));
      void discardAgentProposal(msg.proposal.id).catch(() => {});
      return;
    }
    void Promise.resolve(onApplyProposal(msg.proposal)).then(
      (ok) => setMessages((m) => m.map((x, i) => (i === index ? { ...x, outcome: ok ? 'applied' : 'stale' } : x))),
      () => setMessages((m) => m.map((x, i) => (i === index ? { ...x, outcome: 'stale' } : x))),
    );
  };
  const build = (p: AgentPlan) => {
    if (!real || !planProposal) {
      setBuilt(onBuild(p));
      return;
    }
    // The server applies the picked option's ops as the user (free); nodes arrive as graph.patched.
    const index = options.indexOf(p);
    void applyAgentProposal(planProposal.proposalId, index).then(
      // The card stays, saying what was built; the next plan replaces it.
      (r) => setBuilt(Object.keys(r.idMap ?? {}).length || p.shots.length * 2),
      (e: unknown) => {
        const t = failText(e);
        if (t) setMessages((m) => [...m, { role: 'agent', text: t, fresh: true }]);
      },
    );
  };
  const send = () => {
    const text = draft.trim();
    if (!text || pending) return;
    // NO_PLAN: keep the draft and send it once checkout completes (real mode: the API answers NO_PLAN).
    if (!real && !isMember) {
      setPaywall(true);
      return;
    }
    deliver(text);
  };

  const addRefs = (items: Array<Pick<RefItem, 'name'>>, fromTyping = false) => {
    const mentions = items.map((it) => `@[${it.name}]`).join(' ');
    setDraft((d0) => {
      // A typed `@` is replaced by the mentions.
      const d = fromTyping ? d0.replace(/@$/, '') : d0;
      return d && !d.endsWith(' ') ? `${d} ${mentions} ` : `${d}${mentions} `;
    });
    setMenu(null);
    inputRef.current?.focus();
  };
  /** References come from the shared asset picker modal (owner rule: never a cramped panel). */
  const assetPicker = useAssetPicker();
  const openRefs = (fromTyping: boolean) => {
    setMenu(null);
    void assetPicker.open({ title: intl.formatMessage({ id: 'canvas.agent.addRef' }), multiple: true }).then((picks) => {
      if (picks?.length) addRefs(picks, fromTyping);
      else inputRef.current?.focus();
    });
  };

  /** The plan option card (CanvasPlan.dc.html): cost, shots, "Build on canvas" and Shuffle. */
  const planCard = (p: AgentPlan) => (
    <div className={styles.plan} data-testid="plan-card" data-option={p.id}>
      <div key={p.id} className={cx(styles.planBody, option > 0 && styles.msgIn)} data-motion="">
        <div className={styles.planHead}>
          <span>{p.title}</span>
          <span className={styles.planCost}>
            <FormattedMessage id="canvas.agent.estimate" values={{ n: p.estimate }} />
          </span>
        </div>
        {p.shots.map((s) => (
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
          <button type="button" className={cx(styles.build, 'rl-press')} onClick={() => build(p)}>
            <FormattedMessage id="canvas.agent.build" />
          </button>
          {options.length > 1 ? (
            <button
              type="button"
              className={styles.shuffle}
              aria-label={intl.formatMessage({ id: 'canvas.agent.shuffleLabel' }, { n: ((option + 1) % options.length) + 1, total: options.length })}
              onClick={() => setOption((o) => (o + 1) % options.length)}
            >
              <FormattedMessage id="canvas.agent.shuffle" />
            </button>
          ) : null}
        </div>
      ) : (
        <span className={cx(styles.built, styles.msgIn)} data-motion="" role="status">
          <FormattedMessage id="canvas.agent.built" values={{ n: built }} />
        </span>
      )}
    </div>
  );

  /* ---------- Conversations (D-038): this project's threads and the earlier Home ones ---------- */
  const [history, setHistory] = useState<{ project: Array<{ id: string; title: string | null; updatedAt: number }>; home: Array<{ id: string; title: string; updatedAt: number }> } | null>(null);
  const loadHistory = () => {
    if (!real || !projectId) return;
    void Promise.all([projectThreads(projectId).catch(() => []), recentThreads('home', 20).catch(() => [])]).then(([project, home]) =>
      setHistory({ project, home: home.filter((t) => !t.projectId) }),
    );
  };
  const switchTo = (load: () => Promise<Thread>) => {
    if (pending || !projectId) return;
    void load().then(
      (t) => {
        rememberThread(`canvas:${projectId}`, t.id);
        showThread(t);
        onPreview(null);
      },
      () => toast.show({ message: intl.formatMessage({ id: 'canvas.agent.history.failed' }) }),
    );
  };
  const when = (ms: number) => intl.formatDate(ms, { month: 'short', day: 'numeric' });
  const historyEntries = [
    ...(history?.project ?? []).map((t) => ({
      key: t.id,
      label: t.title || intl.formatMessage({ id: 'canvas.agent.history.untitled' }),
      meta: when(t.updatedAt),
      checked: t.id === threadId.current,
      onSelect: () => (t.id === threadId.current ? undefined : switchTo(() => getThread(t.id))),
    })),
    ...(history?.home ?? []).map((t) => ({
      key: t.id,
      label: t.title || intl.formatMessage({ id: 'canvas.agent.history.untitled' }),
      meta: intl.formatMessage({ id: 'canvas.agent.history.fromHome' }, { date: when(t.updatedAt) }),
      hint: intl.formatMessage({ id: 'canvas.agent.history.moveHint' }),
      onSelect: () => switchTo(() => attachThread(t.id, projectId!)),
    })),
  ];

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
        {/* D-021: the mode switch sits in the panel head, above the agent model pill (the composer row has no room in the approved layout). */}
        <AgentModeSwitch
          mode={agentMode.mode}
          onModeChange={agentMode.setMode}
          budget={agentMode.budget}
          threshold={agentMode.threshold}
          onBudgetChange={agentMode.setBudget}
          side="bottom"
          pillClassName={styles.pill}
        />
        {real ? (
          <MenuPopover
            open={menu === 'history'}
            onOpenChange={(o) => {
              setMenu(o ? 'history' : null);
              if (o) loadHistory();
            }}
            label={intl.formatMessage({ id: 'canvas.agent.history.label' })}
            title={intl.formatMessage({ id: 'canvas.agent.history.label' })}
            side="bottom"
            align="end"
            entries={
              history === null
                ? [{ key: 'loading', label: intl.formatMessage({ id: 'canvas.agent.history.loading' }), disabled: true, onSelect: () => {} }]
                : historyEntries.length
                  ? historyEntries
                  : [{ key: 'none', label: intl.formatMessage({ id: 'canvas.agent.history.empty' }), disabled: true, onSelect: () => {} }]
            }
            trigger={(t) => (
              <button {...t} type="button" className={styles.close} aria-label={intl.formatMessage({ id: 'canvas.agent.history.label' })} title={intl.formatMessage({ id: 'canvas.agent.history.label' })}>
                <CanvasIcon name="history" size={16} />
              </button>
            )}
          />
        ) : null}
        <button type="button" className={styles.close} aria-label={intl.formatMessage({ id: 'canvas.agent.hide' })} onClick={onClose}>
          <CanvasIcon name="close" size={16} />
        </button>
      </div>
      <div className={styles.thread} aria-live="polite" aria-busy={restoring || undefined}>
        {restoring && !messages.length ? (
          // Real mode: the stored conversation loads; never demo content in its place.
          <div className={styles.loading} data-testid="agent-loading">
            <Skeleton text width="70%" height={14} />
            <Skeleton text width="90%" height={14} />
            <Skeleton text width="55%" height={14} />
          </div>
        ) : null}
        {messages.map((m, i) => (
          <Fragment key={i}>
            <div className={cx(m.role === 'user' ? styles.user : styles.agent, m.fresh && styles.msgIn)} data-motion="" data-testid={m.role === 'user' ? 'agent-user' : 'agent-reply'}>
              {m.role === 'agent' ? <AgentText text={m.text} /> : m.text}
              {m.refNames?.length ? (
                <span className={styles.refs}>
                  <FormattedMessage id="canvas.agent.refs" values={{ names: intl.formatList(m.refNames, { type: 'conjunction' }) }} />
                </span>
              ) : null}
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
                      <button type="button" className={cx(styles.build, 'rl-press')} onClick={() => settle(i, 'applied')}>
                        <FormattedMessage id="canvas.agent.proposal.apply" />
                      </button>
                      <button type="button" className={styles.shuffle} onClick={() => settle(i, 'discarded')}>
                        <FormattedMessage id="canvas.agent.proposal.discard" />
                      </button>
                    </div>
                  )}
                </div>
              ) : null}
              {m.auto ? (
                <AutoSummary
                  turn={m.auto}
                  onUndo={(changeId) => undo({ changeId })}
                  onUndoAll={(turnId) => undo({ turnId })}
                  onApproveRun={approveRun}
                  busy={undoBusy}
                  failed={undoFailed}
                  approved={approved}
                />
              ) : null}
            </div>
            {plan && planProposal && m.planId === planProposal.proposalId ? planCard(plan) : null}
          </Fragment>
        ))}
        {plan && planProposal && !messages.some((m) => m.planId === planProposal.proposalId) ? planCard(plan) : null}
        {pending ? (
          <div className={cx(styles.agent, styles.pending, styles.msgIn)} data-motion="" role="status" data-testid="agent-pending">
            {streamed ? <AgentText text={streamed} /> : <FormattedMessage id="canvas.agent.thinking" />}
            {liveAuto ? <AutoSummary turn={liveAuto} onUndo={() => {}} onUndoAll={() => {}} onApproveRun={() => {}} busy={new Set(liveAuto.changes.map((c) => c.id))} /> : null}
          </div>
        ) : null}
      </div>
      <div className={styles.composerWrap}>
        {assetPicker.element}
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
            placeholder={intl.formatMessage({ id: nodes && nodes.length === 0 ? 'canvas.agent.placeholder.empty' : 'canvas.agent.placeholder' })}
            value={draft}
            onChange={(e) => {
              const v = e.target.value;
              setDraft(v);
              if (v.endsWith('@')) openRefs(true);
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
                { key: 'refs', label: intl.formatMessage({ id: 'canvas.agent.addRef' }), meta: '@', keepOpen: true, onSelect: () => openRefs(false) },
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
      {/* No plan (D-007): the shared upgrade modal; the kept draft sends once the plan is active. */}
      <UpgradeGate
        open={paywall}
        reason={{ kind: 'agent' }}
        onClose={() => setPaywall(false)}
        onJoined={() => {
          takePendingAction('canvas.agent');
          const text = draft.trim();
          if (text) deliver(text);
        }}
      />
    </aside>
  );
}

/** Mock mode (D-021): the summary the server would send for a patch Auto applied, plus a run when the brief asks to run. */
function mockAutoTurn(proposal: GraphProposal, text: string, budget: number, nodes: GraphNode[]): AutoTurn {
  const turnId = `turn_mock_${proposal.id}`;
  const runs: AutoRun[] = [];
  let spent = 0;
  if (/\brun\b/i.test(text)) {
    const ids = proposal.changes.map((c) => c.nodeId);
    const credits = ids.reduce((s, id) => s + (nodes.find((n) => n.id === id)?.cost ?? 0), 0);
    const fits = credits > 0 && credits <= budget;
    if (fits) spent = credits;
    runs.push({ id: `${turnId}:run:1`, nodeIds: ids, credits, status: fits ? 'started' : 'needs_approval', ...(fits ? { runId: `run_mock_${proposal.id}` } : {}) });
  }
  return {
    turnId,
    budget,
    spent,
    changes: [{ id: `${turnId}:chg:1`, proposalId: proposal.id, kind: 'graphPatch', summary: proposal.summary, projectId: null, revision: proposal.baseRevision + 1, ops: proposal.ops.length, nodeIds: proposal.changes.map((c) => c.nodeId), status: 'applied' }],
    runs,
  };
}
