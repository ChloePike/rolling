import { cx, Skeleton, staggerStyle, useIndicator, useToast } from '@rolling/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { Suspense, useEffect, useRef, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import {
  COMMAND,
  CostLine,
  PromptBox,
  PromptIcon,
  useDefaultCommandGroups,
  useSkills,
  type PromptCommand,
  type PromptIconName,
  type PromptMode,
  type RefItem,
} from '@/features/prompt';
import { useRunFlow, type RunRequest } from '@/features/overlays';
import { UpgradeGate } from '@/lib/upgrade/store';
import { uploadReferences } from '@/features/prompt';
import { useTemplates } from '@/features/templates/api';
import { useCheckoutResume, useSession } from '@/lib/session';
import { useQueryClient } from '@tanstack/react-query';
import { agentFailure, type AgentFailure } from '@/features/overlays/agent';
import { isMockApi, savePendingAction, takePendingAction } from '@/features/overlays/backend';
import { retryRun, type PromptSpec } from '@/features/overlays/runs';
import { downloadAsset } from '@/features/overlays/media';
import { noteFinishedVideo } from '@/lib/pwa/install';
import { useSendToCanvas } from '@/features/canvas/target';
import { useToolQuote } from '@/features/tools/shared/useToolQuote';
import { useAgentAllowance } from '@/lib/session/agentAllowance';
import type { TemplateSummary } from '@/features/templates/types';
import { useCreateProject, useRecentProjects } from './api';
import { ProjectCard } from './ProjectCard';
import { downloadPoster, HomeResult, nextVersion, type HomeResultState, type PendingHomeResult } from './HomeResult';
import type { ResultActionId } from '@/features/overlays';
import type { HomeRunSpec } from './useHomePills';
import { formatSeconds, formatWhen } from './format';
import { HOME_MODES, type HomeModeId } from './modes';
import { useHomePills } from './useHomePills';
import styles from './HomePage.module.css';
import type { ProjectSummary } from './types';
import { coverStyle } from '@/features/templates/cover';
import { TemplateMedia } from '@/features/templates/TemplateMedia';
import { LoadError } from '@/lib/loading';
import { HomeRunList } from './runs/HomeRunList';
import { isActive, type CardStatus, type HomeRunCard } from './runs/model';
import { useHomeRuns } from './runs/useHomeRuns';
import { useHomeThread, type SendInput } from './agent/useHomeThread';
import { lazyComponent, lazyLayer, preloadWhenIdle } from '@/lib/lazy';

/** The agent conversation loads on demand (bundle splitting): at once in agent mode, else when idle. */
const HomeThreadView = lazyComponent(() => import('./agent/HomeThread'), (m) => m.HomeThreadView);

/** Loaded on demand (bundle splitting): opens on a template click. */
const TemplatePreview = lazyLayer(
  () => import('@/features/templates/TemplatePreview'),
  (m) => m.TemplatePreview,
  (p) => p.template != null,
);

const ENTRIES: Array<{ key: string; to: string; icon: PromptIconName }> = [
  { key: 'blank', to: '/p/prj_new', icon: 'frame' },
  { key: 'template', to: '/templates', icon: 'bolt' },
  { key: 'original', to: '/create/remix', icon: 'video' },
  { key: 'avatar', to: '/create/avatar', icon: 'person' },
  { key: 'character', to: '/create/character', icon: 'spark' },
];

/** A Home generation a paywall interrupted (`home.run`), replayed after checkout. */
interface PendingHomeRun {
  mode: HomeModeId;
  brief: string;
  title: string;
  cost: number;
  actionLabel: string;
  run: Omit<HomeRunSpec, 'spec'>;
  refs: RefItem[];
  spec?: PromptSpec;
}

const FEED_CATS = ['forYou', 'product', 'talking', 'drama', 'holiday'] as const;
type FeedCat = (typeof FEED_CATS)[number];

/** Inspiration tiles while templates load (design cover shapes). */
const FEED_SKELETON = ['9/16', '3/4', '9/16', '1/1', '9/16', '3/4', '1/1', '9/16', '3/4', '9/16'];
/** Inspiration placeholder tones (Main.dc.html `tones`): a cover's fill until its image loads. */
const FEED_TONES = ['var(--c-tone-plum)', 'var(--c-tone-teal)', 'var(--c-tone-indigo)', 'var(--c-tone-ochre)', 'var(--c-tone-neutral)', 'var(--c-tone-pine)'];

let cardSeq = 0;
const cardKey = () => `hr_${Date.now().toString(36)}${(cardSeq++).toString(36)}`;

/** Home (Main.dc.html): prompt box with modes, quick entries, run cards or the agent conversation, recent projects and the Inspiration feed. */
export function HomePage() {
  const intl = useIntl();
  const navigate = useNavigate();
  const [mode, setMode] = useState<HomeModeId>('agent');
  const [text, setText] = useState('');
  const [skill, setSkill] = useState<PromptCommand | null>(null);
  const [refs, setRefs] = useState<RefItem[]>([]);
  const { data: skills } = useSkills();
  // Real mode, Avatar: the voice pill uploads a voice track; it joins the `@` references.
  const voiceInput = useRef<HTMLInputElement>(null);
  const { pills, renderPillPopover, credits, blocked, run, llm, agentSettings } = useHomePills(mode, { onUploadVoice: () => voiceInput.current?.click() });
  const allowance = useAgentAllowance();
  // Settings commands open the pill they name; a mode without that pill does not list them.
  const pillIds = {
    model: pills.some((p) => p.id === 'model') ? 'model' : undefined,
    aspect: pills.some((p) => p.id === 'ratio') ? 'ratio' : undefined,
    duration: pills.some((p) => p.id === 'duration') ? 'duration' : pills.some((p) => p.id === 'ratio') && mode === 'video' ? 'ratio' : undefined,
  };
  const allGroups = useDefaultCommandGroups(skills, pillIds);
  const commandGroups = allGroups.map((g) =>
    g.id === 'settings' ? { ...g, items: g.items.filter((c) => c.id === COMMAND.clear || c.pillId) } : g,
  );
  const { isMember } = useSession();
  const toast = useToast();
  const createProject = useCreateProject();
  const toCanvas = useSendToCanvas();
  // D-007: sending to the agent (or generating) needs a plan. Non-members get
  // the join paywall; the brief, refs and skill stay in the prompt box and the
  // send resumes after checkout.
  const [paywall, setPaywall] = useState(false);
  // Image, video and avatar sends go through the shared run flow (paywalls, RunConfirm by threshold).
  const flow = useRunFlow({ surface: 'home' });
  const runs = useHomeRuns();
  const [result, setResult] = useState<HomeResultState | null>(null);
  const [building, setBuilding] = useState<string | null>(null);
  const qc = useQueryClient();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const mock = isMockApi();

  const modes: PromptMode[] = HOME_MODES.map((m) => ({ id: m.id, icon: m.icon, label: intl.formatMessage({ id: `home.mode.${m.id}` }) }));

  const title = () => {
    const line = text.trim().split('\n')[0]!.slice(0, 80);
    return line || skill?.name || t('home.project.untitled');
  };

  /* ---------- Generations: one run card per send ---------- */

  /** Called once a card's run finishes (the result viewer's Regenerate adds the new version). */
  const onCardDone = useRef(new Map<string, (runId: string, assetId: string | null) => void>());

  /** Starts a generation as a run card under the prompt box; the run flow gates it (paywalls, RunConfirm). */
  const startRun = (g: PendingHomeRun, opts: { quote?: RunRequest['quote']; done?: (runId: string, assetId: string | null) => void; resume?: RunRequest['resume'] } = {}) => {
    const key = cardKey();
    const card: HomeRunCard = {
      key,
      runId: null,
      kind: g.run.kind,
      mode: g.mode === 'agent' ? undefined : g.mode,
      prompt: g.brief,
      title: g.title,
      modelName: g.run.modelName,
      meta: g.run.meta,
      aspect: g.run.aspect,
      params: g.run.params,
      ...(g.spec ? { spec: g.spec } : {}),
      credits: g.cost,
      status: 'starting',
      progress: null,
      createdAt: Date.now(),
      finishedAt: null,
      assetIds: [],
      spent: 0,
      refunded: 0,
      error: null,
      retryable: false,
    };
    runs.add(card);
    if (opts.done) onCardDone.current.set(key, opts.done);
    flow.request({
      cost: g.cost,
      kind: g.run.kind,
      actionLabel: g.actionLabel,
      meta: g.run.meta,
      subtitle: g.run.modelName,
      spec: g.spec,
      ...(opts.quote ? { quote: opts.quote } : {}),
      inline: true,
      resume: opts.resume ?? { kind: 'home.run', data: g },
      onStarted: (runId, held) => {
        runs.started(key, runId, card);
        runs.patch(key, (c) => ({ ...c, credits: held, status: c.status === 'starting' ? 'queued' : c.status }));
      },
      onAbort: () => {
        runs.remove(key);
        onCardDone.current.delete(key);
      },
      // Mock mode: the flow reports the end (real runs are followed by the card).
      onDone: (r) => runs.patch(key, (c) => (isActive(c) ? { ...c, status: 'done', progress: 1, finishedAt: Date.now(), spent: r.cost, assetIds: r.assetId ? [r.assetId] : c.assetIds } : c)),
      onFailed: () => {
        if (mock) runs.patch(key, (c) => (!isActive(c) ? c : { ...c, status: 'failed', progress: null, finishedAt: Date.now(), refunded: c.credits, error: t('home.run.mockError'), retryable: true }));
      },
    });
  };

  // A card's status change: the finished-video install hint, the viewer's new version, a failure toast with Retry (handoff 4).
  const seen = useRef(new Map<string, CardStatus>());
  useEffect(() => {
    for (const c of runs.cards) {
      const before = seen.current.get(c.key);
      seen.current.set(c.key, c.status);
      if (before === undefined || before === c.status || !isActive({ status: before })) continue;
      if (c.status === 'done') {
        if (c.kind === 'video') noteFinishedVideo();
        const done = onCardDone.current.get(c.key);
        onCardDone.current.delete(c.key);
        if (done && c.runId) done(c.runId, c.assetIds[0] ?? null);
      } else if (c.status === 'failed') {
        onCardDone.current.delete(c.key);
        toast.show({ message: t('home.run.failedToast', { label: c.title }), action: { label: t('home.run.retry'), onAction: () => retryCard(c) }, duration: 0 });
      }
    }
    // Only when cards change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs.cards]);

  const pendingFromCard = (c: HomeRunCard): PendingHomeRun => ({
    mode: c.mode ?? (c.kind === 'image' ? 'image' : 'video'),
    brief: c.prompt,
    title: c.title,
    cost: c.credits,
    actionLabel: t(`home.send.${c.mode ?? (c.kind === 'image' ? 'image' : 'video')}`),
    run: { kind: c.kind, meta: c.meta, modelName: c.modelName, aspect: c.aspect, params: c.params },
    refs: [],
    ...(c.spec ? { spec: c.spec } : {}),
  });
  /** Failed or canceled: the server quotes the same request again (`POST /api/runs/:id/retry`); mock: the same run. */
  function retryCard(c: HomeRunCard) {
    if (!mock && c.runId && c.retryable) startRun(pendingFromCard(c), { quote: () => retryRun(c.runId!) });
    else startRun(pendingFromCard(c));
  }

  const resultFromCard = (c: HomeRunCard): HomeResultState => {
    const id = c.runId ?? c.key;
    // A mature chain whose animation failed (D-005): the first frame is the result to open.
    const keyframe = c.status === 'failed' ? (c.chain?.keyframeAssetId ?? null) : null;
    return {
      title: c.title,
      prompt: c.prompt,
      kind: keyframe ? 'image' : c.kind,
      aspect: c.aspect,
      modelName: c.modelName,
      params: c.params,
      refs: [],
      versions: [{ ...nextVersion([], id), ...(c.expandedPrompt && !keyframe ? { expandedPrompt: c.expandedPrompt } : {}) }],
      versionId: id,
      createdAt: new Date(c.createdAt),
      cost: c.credits,
      ...(c.spec ? { spec: c.spec } : {}),
      assets: { [id]: keyframe ?? c.assetIds[0] ?? null },
    };
  };

  const cardActions = {
    onCancel: (c: HomeRunCard) => void runs.cancel(c.key).catch(() => toast.show({ message: t('overlays.run.startFailed', { label: t('home.run.cancel') }) })),
    onRetry: retryCard,
    onRunAgain: (c: HomeRunCard) => startRun(pendingFromCard(c)),
    onView: (c: HomeRunCard) => setResult(resultFromCard(c)),
    onRemove: (c: HomeRunCard) => runs.remove(c.key),
    onDownload: (c: HomeRunCard) => {
      const asset = c.assetIds[0];
      const name = c.title.replace(/[^\w.-]+/g, '-');
      toast.show({ message: t('overlays.viewer.downloading', { name: c.title }) });
      if (!mock && asset) void downloadAsset(asset, c.title).catch(() => {});
      else downloadPoster(name, 'var(--c-tone-indigo)', c.aspect);
    },
    onOpenCanvas: (c: HomeRunCard) => {
      const asset = c.assetIds[0] ?? null;
      if (!mock && !asset) return void toast.show({ message: t('home.run.noResult') });
      // A new canvas titled after the prompt, with the result as an asset node (never an empty project).
      void createProject({ title: c.title, kind: 'canvas' }).then(({ id }) =>
        toCanvas.send({ name: c.title, media: c.kind, assetId: asset, refId: asset ?? c.runId ?? c.key, source: 'generated', label: c.meta }, { projectId: id }),
      );
    },
  };

  /** The spec of the current prompt box (real mode): prompt, title and `@` inputs. A string says what is missing. */
  const buildSpec = (r: HomeRunSpec | null, brief: string, runTitle: string): PromptSpec | string | undefined => {
    if (!r?.spec) return undefined;
    // Real mode: the prompt, title and `@` images (uploads resolve to asset ids in the flow) go in the spec.
    const own = refs.filter((x) => x.group !== 'pub' && /^(ast_|upl_)/.test(x.id));
    const imageRefs = own.filter((x) => x.glyph.type !== 'wave').map((x) => x.id);
    if (r.spec.kind === 'avatar') {
      // Avatar: the first `@` picture speaks the uploaded voice track (lip sync, D-009).
      const photo = own.find((x) => x.glyph.type === 'icon' && x.glyph.icon === 'img') ?? own.find((x) => x.glyph.type !== 'wave' && !(x.glyph.type === 'icon' && x.glyph.icon === 'video'));
      const voice = own.find((x) => x.glyph.type === 'wave');
      if (!photo) return t('home.avatar.needPhoto');
      if (!voice) return t('home.avatar.needVoice');
      return { ...r.spec, prompt: brief, title: runTitle, inputs: { firstFrameAssetId: photo.id, audioAssetId: voice.id } };
    }
    return { ...r.spec, prompt: brief, title: runTitle, ...(imageRefs.length ? { inputs: { referenceAssetIds: imageRefs } } : {}) };
  };

  // Real mode: the cost line is the server's quote for exactly what Send runs (D-006), so it matches the hold.
  const liveSpec = mode !== 'agent' && !blocked && text.trim() ? buildSpec(run, text.trim(), title()) : undefined;
  const quote = useToolQuote(liveSpec ?? null, credits ?? undefined);
  const shownCredits = mock || !liveSpec || typeof liveSpec === 'string' ? credits : (quote.credits ?? (quote.loading ? null : credits));

  const generate = () => {
    if (!run) return;
    const brief = text.trim();
    const runTitle = title();
    const spec = buildSpec(run, brief, runTitle);
    if (typeof spec === 'string') return void toast.show({ message: spec });
    const { kind, meta, modelName, aspect, params } = run;
    startRun({ mode, brief, title: runTitle, cost: shownCredits ?? credits ?? 0, actionLabel: t(`home.send.${mode}`), run: { kind, meta, modelName, aspect, params }, refs, ...(spec ? { spec } : {}) });
  };

  /* ---------- Agent: a conversation under the prompt box ---------- */

  const failureText = (f: AgentFailure, input: SendInput): { text: string; retryable: boolean } | null => {
    switch (f.kind) {
      case 'join':
        // D-007: keep the brief; it is sent again after checkout.
        savePendingAction('home.agent', { brief: input.text, skill: input.skill ?? null });
        setText(input.text);
        setPaywall(true);
        return null;
      case 'allowance':
        return { text: t('home.agent.allowanceUsedUp', { date: f.resetsAt ? intl.formatDate(f.resetsAt, { month: 'short', day: 'numeric' }) : '' }), retryable: false };
      case 'rateLimited':
        return { text: t('home.agent.rateLimited', { seconds: f.retryAfter ?? 0 }), retryable: true };
      case 'busy':
        return { text: t('home.agent.busy'), retryable: true };
      case 'offline':
        return { text: t('home.agent.offline'), retryable: true };
      case 'stale':
        return { text: t('home.agent.stale'), retryable: false };
      default:
        return { text: f.message === 'safety_blocked' ? t('home.agent.safety') : t('home.agent.error'), retryable: f.message !== 'safety_blocked' };
    }
  };
  const thread = useHomeThread(failureText);
  const [newCanvas, newCanvasBusy] = useNewCanvas();
  const askAgent = (brief: string, refIds: string[], skillName: string | null) => void thread.send({ text: brief, refs: refIds, skill: skillName, llm: llm.id, settings: agentSettings });

  const build = (proposalId: string, optionIndex: number, optionTitle?: string) => {
    setBuilding(proposalId);
    if (mock) {
      // Mock: the plan becomes a project (no spend) and its canvas opens.
      void thread.build(proposalId, optionIndex).then(() =>
        createProject({ title: optionTitle ?? title(), kind: 'canvas' }).then(({ id }) => {
          setBuilding(null);
          void navigate({ to: '/p/$projectId', params: { projectId: id } });
        }),
      );
      return;
    }
    thread.build(proposalId, optionIndex, optionTitle).then(
      (r) => {
        setBuilding(null);
        void qc.invalidateQueries({ queryKey: ['projects'] });
        if (r.projectId) void navigate({ to: '/p/$projectId', params: { projectId: r.projectId } });
      },
      (e: unknown) => {
        setBuilding(null);
        const f = agentFailure(e);
        if (f.kind === 'join') return setPaywall(true);
        toast.show({ message: t(f.kind === 'stale' ? 'home.agent.stale' : 'home.agent.error') });
      },
    );
  };

  // A result viewer action (Regenerate, …) interrupted by a paywall, replayed once the viewer is open again.
  const [resumeAction, setResumeAction] = useState<{ id: ResultActionId; versionId: string } | null>(null);

  // What a paywall interrupted continues once the plan is active (also after the checkout redirect):
  // a brief for the agent, a generation, or a result viewer action.
  useCheckoutResume(() => {
    const pending = takePendingAction<{ brief: string; skill: string | null }>('home.agent');
    if (pending) {
      setText('');
      askAgent(pending.brief, [], pending.skill);
    }
    const gen = takePendingAction<PendingHomeRun>('home.run');
    if (gen) {
      setMode(gen.mode);
      setText(gen.brief);
      setRefs(gen.refs);
      startRun(gen);
    }
    const viewer = takePendingAction<PendingHomeResult>('home.result');
    if (viewer) {
      setResult({ ...viewer.result, createdAt: new Date(viewer.result.createdAt) });
      setResumeAction({ id: viewer.action, versionId: viewer.versionId });
    }
  });

  const submit = () => {
    if (!text.trim() && !refs.length && !skill) {
      document.getElementById('brief')?.focus();
      toast.show({ message: t('home.send.empty') });
      return;
    }
    if (mode !== 'agent') return generate();
    if (thread.busy) return void toast.show({ message: t('home.agent.busy') });
    // Mock non-members: the join paywall first (real mode: the API answers NO_PLAN).
    if (mock && !isMember) return setPaywall(true);
    const brief = text.trim() || skill?.name || '';
    // The message moves into the conversation; the prompt box is free for the next one.
    setText('');
    const refIds = refs.map((r) => r.id);
    setRefs([]);
    askAgent(brief, refIds, skill?.name ?? null);
  };

  const onCommand = (c: PromptCommand) => {
    if (c.id === COMMAND.canvas) void createProject({ title: title(), kind: 'canvas' }).then(({ id }) => navigate({ to: '/p/$projectId', params: { projectId: id } }));
    else if (c.id === COMMAND.character) void navigate({ to: '/create/character' });
    else if (c.id === COMMAND.voice) void navigate({ to: '/assets', search: { folder: 'voices' } as never });
    else if (c.id === COMMAND.storyboard) {
      // The storyboard is the agent's plan: switch to Agent so the next send plans the shots.
      setMode('agent');
      toast.show({ message: t('home.cmd.storyboard') });
    }
  };

  const llmAllowance = (() => {
    if (!llm.id) return null;
    if (allowance.isUnlimited(llm.id)) return t('home.agent.unlimited');
    const left = allowance.turnsLeftFor(llm.id);
    return left === null ? null : t('home.agent.turnsLeft', { count: left });
  })();
  const allowanceNotice = allowance.exhausted ? t('home.agent.allowanceUsedUp', { date: intl.formatDate(allowance.resetsAt, { month: 'short', day: 'numeric' }) }) : null;
  const showThread = mode === 'agent' && thread.messages.length > 0;
  useEffect(() => (mode === 'agent' ? void HomeThreadView.preload() : preloadWhenIdle(HomeThreadView)), [mode]);

  return (
    <>
      <section aria-label={intl.formatMessage({ id: 'home.start.label' })} className={styles.start}>
        <h1 className={styles.title}>
          <FormattedMessage id="home.title" />
        </h1>
        <input
          ref={voiceInput}
          type="file"
          accept="audio/*"
          hidden
          data-voice-track=""
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (!files.length) return;
            void uploadReferences(files, () => t('home.avatar.voiceTrack')).then((items) => {
              if (!items.length) return;
              setRefs((cur) => [...cur, ...items]);
              toast.show({ message: t('home.avatar.voiceAdded', { name: items[0]!.name }) });
            });
          }}
        />
        <PromptBox
          inputId="brief"
          value={text}
          onValueChange={setText}
          placeholder={intl.formatMessage({ id: `home.placeholder.${mode}` })}
          modes={modes}
          mode={mode}
          onModeChange={(id) => setMode(id as HomeModeId)}
          pills={pills}
          renderPillPopover={renderPillPopover}
          skill={skill}
          onSkillChange={setSkill}
          skills={skills}
          commandGroups={commandGroups}
          onCommand={onCommand}
          refs={refs}
          onRefsChange={setRefs}
          onAddAction={(a) => {
            if (a === 'assets') void navigate({ to: '/assets' });
          }}
          onUploaded={(items) => toast.show({ message: t('home.upload.added', { n: items.length }) })}
          cost={
            mode === 'agent' ? (
              <CostLine label={intl.formatMessage({ id: 'home.cost.planningFree' })} />
            ) : blocked ? (
              // Never a number when the quote is blocked: the reason instead (PROMPT-2).
              <CostLine label={blocked} />
            ) : shownCredits !== null ? (
              <CostLine credits={shownCredits} />
            ) : quote.loading ? (
              <CostLine label={intl.formatMessage({ id: 'home.cost.quoting' })} />
            ) : null
          }
          onSubmit={submit}
        />
        {mode === 'agent' && allowance.exhausted && !showThread ? (
          <p role="status" className={styles.allowanceNotice}>
            {allowanceNotice}
          </p>
        ) : null}
        {showThread ? (
          <Suspense fallback={null}>
            <HomeThreadView
              messages={thread.messages}
              busy={thread.busy}
              llm={{ id: llm.id, name: llm.name, allowance: llmAllowance }}
              notice={allowanceNotice}
              building={building}
              onSend={(reply) => {
                if (mock && !isMember) {
                  setText(reply);
                  return setPaywall(true);
                }
                askAgent(reply, [], null);
              }}
              onStop={thread.stop}
              onRetry={thread.retry}
              onBuild={(p, i) => build(p.id, i, p.body.kind === 'plan' ? p.body.options[i]?.title : undefined)}
              onDiscard={(p) => void thread.discard(p.id)}
              onNew={thread.reset}
              recent={{ items: thread.recent, currentId: thread.id, onOpen: thread.loadRecent, onPick: (id) => void thread.open(id).catch(() => toast.show({ message: intl.formatMessage({ id: 'home.agent.recentFailed' }) })) }}
            />
          </Suspense>
        ) : null}
        {mode !== 'agent' || !showThread ? <HomeRunList cards={runs.cards} actions={cardActions} onClearFinished={() => runs.cards.filter((c) => !isActive(c)).forEach((c) => runs.remove(c.key))} /> : null}
        <nav className={cx(styles.entries, (showThread || (mode !== 'agent' && runs.cards.length > 0)) && styles.entriesAfter)} aria-label={intl.formatMessage({ id: 'home.start.label' })}>
          {ENTRIES.map((e) => (
            <Link key={e.key} to={e.to} className={styles.entry} onClick={e.key === 'blank' ? newCanvas : undefined} aria-busy={e.key === 'blank' && newCanvasBusy ? true : undefined}>
              <span className={styles.entryIcon}>
                <PromptIcon name={e.icon} size={14} />
              </span>
              <FormattedMessage id={`home.entry.${e.key}`} />
            </Link>
          ))}
        </nav>
      </section>
      {/* No plan (D-007): the shared upgrade modal; the kept brief goes to the agent once the plan is active. */}
      <UpgradeGate
        open={paywall}
        reason={{ kind: 'agent' }}
        onClose={() => setPaywall(false)}
        onJoined={() => {
          takePendingAction('home.agent');
          const brief = text.trim();
          if (!brief) return;
          setText('');
          askAgent(brief, refs.map((r) => r.id), skill?.name ?? null);
        }}
      />
      {flow.element}
      {toCanvas.dialog}
      <HomeResult
        result={result}
        onChange={setResult}
        onRun={(req, done) => {
          // The viewer's Regenerate is a run card too; its result becomes the viewer's next version.
          const r = result;
          if (!r) return;
          startRun(
            {
              mode: r.kind === 'image' ? 'image' : 'video',
              brief: r.prompt,
              title: r.title,
              cost: req.cost,
              actionLabel: req.actionLabel,
              run: { kind: r.kind, meta: req.meta, modelName: r.modelName, aspect: r.aspect, params: r.params },
              refs: r.refs,
              ...(req.spec ? { spec: req.spec } : {}),
            },
            { done: (runId, assetId) => done(runId, assetId), ...(req.resume ? { resume: req.resume } : {}) },
          );
        }}
        resumeAction={resumeAction}
        onResumed={() => setResumeAction(null)}
      />
      <RecentProjects />
      <Inspiration />
    </>
  );
}

/**
 * Real mode: creates an untitled canvas, then opens it (mock mode follows the link to the demo canvas).
 * One project per click: repeated clicks while it is being created do nothing.
 */
function useNewCanvas(): [(e: React.MouseEvent) => void, boolean] {
  const intl = useIntl();
  const navigate = useNavigate();
  const toast = useToast();
  const createProject = useCreateProject();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const open = (e: React.MouseEvent) => {
    if (isMockApi()) return;
    e.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void createProject({ title: intl.formatMessage({ id: 'home.project.untitled' }), kind: 'canvas' })
      .then(({ id }) => navigate({ to: '/p/$projectId', params: { projectId: id } }))
      .catch(() => toast.show({ message: intl.formatMessage({ id: 'home.project.createFailed' }) }))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
      });
  };
  return [open, busy];
}

/** Cards shown before "All projects" expands the list. */
const RECENT_CARDS = 4;

function RecentProjects() {
  const intl = useIntl();
  const [all, setAll] = useState(false);
  const [newCanvas, busy] = useNewCanvas();
  const projectsQ = useRecentProjects(all);
  // An untitled canvas with no nodes (e.g. made by the nav's Canvas entry) has nothing to show: it stays off Recent.
  const untitled = intl.formatMessage({ id: 'home.project.untitled' });
  const listed = (projectsQ.data ?? []).filter((p) => !(p.nodeCount === 0 && (p.title === untitled || p.title === 'Untitled project')));
  const projects = all ? listed : listed.slice(0, RECENT_CARDS);
  const meta = (p: ProjectSummary) => {
    const when = formatWhen(intl, p.updatedAt);
    const detail =
      p.nodeCount !== undefined
        ? intl.formatMessage({ id: 'home.project.nodes' }, { n: p.nodeCount })
        : p.durationSec !== undefined
          ? formatSeconds(intl, p.durationSec)
          : null;
    return detail ? intl.formatMessage({ id: 'home.project.meta' }, { detail, when }) : when;
  };
  return (
    <section id="projects" aria-labelledby="h-recent" className={styles.recent}>
      <div className={styles.sectionHead}>
        <h2 id="h-recent" className={cx(styles.h2, styles.flex1)}>
          <FormattedMessage id="home.projects.title" />
        </h2>
        <button type="button" className={styles.allLink} aria-expanded={all} aria-controls="home-projects-grid" onClick={() => setAll((v) => !v)}>
          <FormattedMessage id={all ? 'home.projects.fewer' : 'home.projects.all'} />
        </button>
      </div>
      <div className={styles.projectGrid} id="home-projects-grid">
        <Link to="/p/$projectId" params={{ projectId: 'prj_new' }} className={styles.newProject} onClick={newCanvas} aria-busy={busy || undefined}>
          <span className={styles.newIcon}>
            <PromptIcon name="plus" size={20} />
          </span>
          <span className={styles.newLabel}>
            <FormattedMessage id="home.projects.new" />
          </span>
        </Link>
        {projectsQ.data === undefined && !projectsQ.isError
          ? [0, 1, 2].map((i) => (
              <div key={i} className={styles.project} data-testid="project-skeleton">
                <Skeleton className={styles.projectThumb} height="auto" radius={16} />
                <Skeleton text width="60%" height={16} />
                <Skeleton text width="40%" height={14} />
              </div>
            ))
          : null}
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} meta={meta(p)} />
        ))}
      </div>
      {projectsQ.isError && projectsQ.data === undefined ? <LoadError inline onRetry={() => projectsQ.refetch()} retrying={projectsQ.isFetching} /> : null}
    </section>
  );
}

const CAT_FILTER: Record<FeedCat, (t: TemplateSummary) => boolean> = {
  forYou: () => true,
  product: (t) => t.category === 'product',
  talking: (t) => t.category === 'talking',
  drama: (t) => t.category === 'drama',
  holiday: (t) => t.category === 'holiday',
};

function Inspiration() {
  const intl = useIntl();
  const [cat, setCat] = useState<FeedCat>('forYou');
  const [preview, setPreview] = useState<TemplateSummary | null>(null);
  const navigate = useNavigate();
  const tabsRef = useRef<HTMLDivElement>(null);
  const indicator = useIndicator(tabsRef, cat);
  const templatesQ = useTemplates();
  const { data } = templatesQ;
  const feed = data.items.filter(CAT_FILTER[cat]).slice(0, 10);
  const loading = templatesQ.isPending && !templatesQ.isError;
  // Nothing to suggest (no templates at all): the section is left out rather than shown empty.
  if (!loading && !templatesQ.isError && !data.items.length) return null;
  return (
    <section aria-labelledby="h-insp" className={styles.insp}>
      <div className={styles.inspHead}>
        <h2 id="h-insp" className={styles.h2}>
          <FormattedMessage id="home.inspiration.title" />
        </h2>
        <div
          ref={tabsRef}
          role="tablist"
          aria-label={intl.formatMessage({ id: 'home.inspiration.categories' })}
          className={styles.cats}
        >
          <span className={styles.catIndicator} style={indicator} aria-hidden="true" />
          {FEED_CATS.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={c === cat}
              tabIndex={c === cat ? 0 : -1}
              className={styles.cat}
              onClick={() => setCat(c)}
            >
              <FormattedMessage id={`home.inspiration.cat.${c}`} />
            </button>
          ))}
        </div>
      </div>
      {templatesQ.isError && !data.items.length ? <LoadError inline onRetry={() => templatesQ.refetch()} retrying={templatesQ.isFetching} /> : null}
      <div key={cat} className={styles.feed} aria-busy={loading || undefined}>
        {loading
          ? FEED_SKELETON.map((ratio, i) => <Skeleton key={i} className={styles.feedCard} height="auto" radius={16} style={{ aspectRatio: ratio, display: 'block' }} />)
          : null}
        {feed.map((t, i) => (
          <div key={t.id} className={cx(styles.feedCard, 'rl-stagger')} style={staggerStyle(i)} data-motion="" data-template-card="" data-template={t.id}>
            {/* At rest only the poster and the duration. Hover or focus brings up a solid bar with the name and Use
                template; touch devices have no hover, so the name sits below the poster. The card opens the preview. */}
            <div className={styles.feedMedia} style={coverStyle(t.cover ? null : t.coverUrl, t.cover?.color ?? FEED_TONES[i % FEED_TONES.length]!, { aspectRatio: t.coverAspect })}>
              <TemplateMedia t={t} />
              <button
                type="button"
                className={styles.feedOpen}
                aria-haspopup="dialog"
                aria-label={intl.formatMessage({ id: 'templates.preview.open' }, { name: t.name })}
                onClick={() => setPreview(t)}
              />
              {t.durationSec > 0 ? <span className={styles.feedDur}>{formatSeconds(intl, t.durationSec)}</span> : null}
              <div className={styles.feedBar} data-testid="template-bar">
                <span className={styles.feedName}>{t.name}</span>
                <Link
                  to="/create/quick"
                  search={{ template: t.id } as never}
                  aria-label={intl.formatMessage({ id: 'home.inspiration.useLabel' }, { name: t.name })}
                  className={cx(styles.useBtn, 'rl-press')}
                >
                  <FormattedMessage id="home.inspiration.use" />
                </Link>
              </div>
            </div>
            <span className={styles.feedCaption} data-testid="template-caption" aria-hidden="true">
              {t.name}
            </span>
          </div>
        ))}
      </div>
      <TemplatePreview
        template={preview}
        items={feed}
        tone={FEED_TONES[0]!}
        onClose={() => setPreview(null)}
        onSelect={setPreview}
        onUse={(t) => {
          setPreview(null);
          void navigate({ to: '/create/quick', search: { template: t.id } as never });
        }}
      />
    </section>
  );
}
