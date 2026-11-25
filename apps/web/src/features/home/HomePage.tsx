import { cx, staggerStyle, useIndicator, useToast } from '@rolling/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
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
import { Paywall, useRunFlow, type RunRequest } from '@/features/overlays';
import { uploadReferences } from '@/features/prompt';
import { useTemplates } from '@/features/templates/api';
import { checkoutPlan, useCheckoutResume, useSession } from '@/lib/session';
import { useQueryClient } from '@tanstack/react-query';
import { agentFailure, applyProposal, createThread, rememberThread, sendTurn, skillId } from '@/features/overlays/agent';
import { isMockApi, savePendingAction, takePendingAction } from '@/features/overlays/backend';
import { resolveAssetId } from '@/lib/transfers';
import { HomeAgent, type HomeAgentState } from './HomeAgent';

/** Agent LLM picked in the canvas panel (public id, D-009), shared with Home. */
function getAgentLlm(): string | null {
  try {
    return localStorage.getItem('rolling.agent.llm');
  } catch {
    return null;
  }
}
import { useAgentAllowance } from '@/lib/session/agentAllowance';
import type { TemplateSummary } from '@/features/templates/types';
import { useCreateProject, useRecentProjects } from './api';
import { HomeResult, nextVersion, type HomeResultState } from './HomeResult';
import { formatSeconds, formatWhen } from './format';
import { HOME_MODES, type HomeModeId } from './modes';
import { FEED_TONES } from './mocks';
import { useHomePills } from './useHomePills';
import styles from './HomePage.module.css';
import type { ProjectSummary } from './types';

const ENTRIES: Array<{ key: string; to: string; icon: PromptIconName }> = [
  { key: 'blank', to: '/p/prj_new', icon: 'frame' },
  { key: 'template', to: '/templates', icon: 'bolt' },
  { key: 'original', to: '/create/remix', icon: 'video' },
  { key: 'avatar', to: '/create/avatar', icon: 'person' },
  { key: 'character', to: '/create/character', icon: 'spark' },
];

const FEED_CATS = ['forYou', 'product', 'talking', 'drama', 'holiday'] as const;
type FeedCat = (typeof FEED_CATS)[number];

/** Home (Main.dc.html): prompt box with modes, quick entries, recent projects and the Inspiration feed. */
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
  const { pills, renderPillPopover, credits, run } = useHomePills(mode, { onUploadVoice: () => voiceInput.current?.click() });
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
  // D-007: sending to the agent (or generating) needs a plan. Non-members get
  // the join paywall; the brief, refs and skill stay in the prompt box and the
  // send resumes after checkout.
  const [paywall, setPaywall] = useState(false);
  const [paying, setPaying] = useState(false);
  // Image, video and avatar sends go through the shared run flow (paywalls, RunConfirm by threshold).
  const flow = useRunFlow();
  const [result, setResult] = useState<HomeResultState | null>(null);
  const [agent, setAgent] = useState<HomeAgentState | null>(null);
  const [building, setBuilding] = useState(false);
  const homeThread = useRef<string | null>(null);
  const qc = useQueryClient();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);

  const modes: PromptMode[] = HOME_MODES.map((m) => ({ id: m.id, icon: m.icon, label: intl.formatMessage({ id: `home.mode.${m.id}` }) }));

  const title = () => {
    const line = text.trim().split('\n')[0]!.slice(0, 80);
    return line || skill?.name || t('home.project.untitled');
  };
  const start = async () => {
    const { id } = await createProject({ title: title(), kind: 'canvas' });
    void navigate({ to: '/p/$projectId', params: { projectId: id } });
  };

  const runFlow = (req: Omit<RunRequest, 'onDone'>, done: (runId: string, assetId?: string | null) => void) =>
    flow.request({ ...req, viewLabel: t('overlays.run.view'), onDone: (r) => done(r.id, r.assetId) });

  const generate = () => {
    if (!run) return;
    const cost = credits ?? 0;
    const actionLabel = t(`home.send.${mode}`);
    const brief = text.trim();
    const snapshot = { run, refs, title: title(), cost };
    // Real mode: the prompt, title and `@` images (uploads resolve to asset ids in the flow) go in the spec.
    const own = refs.filter((r) => r.group !== 'pub' && /^(ast_|upl_)/.test(r.id));
    const imageRefs = own.filter((r) => r.glyph.type !== 'wave').map((r) => r.id);
    let spec = run.spec ? { ...run.spec, prompt: brief, title: snapshot.title, ...(imageRefs.length ? { inputs: { referenceAssetIds: imageRefs } } : {}) } : undefined;
    if (run.spec?.kind === 'avatar') {
      // Avatar: the first `@` picture speaks the uploaded voice track (lip sync, D-009).
      const photo = own.find((r) => r.glyph.type === 'icon' && r.glyph.icon === 'img') ?? own.find((r) => r.glyph.type !== 'wave' && !(r.glyph.type === 'icon' && r.glyph.icon === 'video'));
      const voice = own.find((r) => r.glyph.type === 'wave');
      if (!photo) return void toast.show({ message: t('home.avatar.needPhoto') });
      if (!voice) return void toast.show({ message: t('home.avatar.needVoice') });
      spec = { ...run.spec, prompt: brief, title: snapshot.title, inputs: { firstFrameAssetId: photo.id, audioAssetId: voice.id } };
    }
    runFlow({ cost, kind: run.kind, actionLabel, meta: run.meta, subtitle: run.modelName, spec }, (runId, assetId) =>
      setResult({
        spec,
        assets: { [runId]: assetId ?? null },
        title: snapshot.title,
        prompt: brief,
        kind: snapshot.run.kind,
        aspect: snapshot.run.aspect,
        modelName: snapshot.run.modelName,
        params: snapshot.run.params,
        refs: snapshot.refs,
        versions: [nextVersion([], runId)],
        versionId: runId,
        createdAt: new Date(),
        cost: snapshot.cost,
      }),
    );
  };

  /** Real mode: the brief goes to a Home agent thread; the plan proposal shows below the prompt box. */
  const askAgent = async (brief: string, refItems: RefItem[], skillName: string | null) => {
    setAgent({ brief, text: '', pending: true, plan: null, notice: null });
    try {
      // `@` uploads still in flight resolve to their asset ids first.
      const refIds = await Promise.all(refItems.map((r) => resolveAssetId(r.id)));
      const thread = await createThread({ surface: 'home', skill: skillId(skillName) });
      homeThread.current = thread.id;
      const r = await sendTurn(thread.id, { text: brief, refs: refIds.filter((id) => id.startsWith('ast_')), llm: getAgentLlm() }, {
        onDelta: (d) => setAgent((a) => (a ? { ...a, text: a.text + d } : a)),
      });
      const plan = r.proposal?.body.kind === 'plan' ? { proposalId: r.proposal.id, options: r.proposal.body.options } : null;
      const notice = r.reason === 'safety_blocked' ? t('home.agent.safety') : r.error ? t('home.agent.error') : null;
      setAgent({ brief, text: r.text, pending: false, plan, notice });
    } catch (e) {
      const f = agentFailure(e);
      if (f.kind === 'join') {
        // D-007: keep the brief; it is sent again after checkout.
        savePendingAction('home.agent', { brief, skill: skillName });
        setAgent(null);
        setPaywall(true);
        return;
      }
      const notice =
        f.kind === 'allowance'
          ? t('home.agent.allowanceUsedUp', { date: f.resetsAt ? intl.formatDate(f.resetsAt, { month: 'short', day: 'numeric' }) : '' })
          : f.kind === 'rateLimited'
            ? t('home.agent.rateLimited', { seconds: f.retryAfter ?? 0 })
            : t('home.agent.error');
      setAgent({ brief, text: '', pending: false, plan: null, notice });
    }
  };

  const build = (optionIndex: number) => {
    const plan = agent?.plan;
    if (!plan) return;
    setBuilding(true);
    const option = plan.options[optionIndex];
    applyProposal(plan.proposalId, { optionIndex, title: option?.title }).then(
      (r) => {
        setBuilding(false);
        void qc.invalidateQueries({ queryKey: ['projects'] });
        if (r.projectId) {
          // The thread moves to the new project (surface canvas): the canvas panel continues it.
          if (homeThread.current) rememberThread(`canvas:${r.projectId}`, homeThread.current);
          void navigate({ to: '/p/$projectId', params: { projectId: r.projectId } });
        }
      },
      (e: unknown) => {
        setBuilding(false);
        const f = agentFailure(e);
        if (f.kind === 'join') return setPaywall(true);
        toast.show({ message: t(f.kind === 'stale' ? 'home.agent.stale' : 'home.agent.error') });
      },
    );
  };

  // A brief interrupted by the join paywall is sent once the plan is active (after the checkout redirect).
  useCheckoutResume(() => {
    const pending = takePendingAction<{ brief: string; skill: string | null }>('home.agent');
    if (pending) void askAgent(pending.brief, [], pending.skill);
  });

  const submit = () => {
    if (!text.trim() && !refs.length && !skill) {
      document.getElementById('brief')?.focus();
      toast.show({ message: t('home.send.empty') });
      return;
    }
    if (mode !== 'agent') return generate();
    if (!isMockApi()) return void askAgent(text.trim(), refs, skill?.name ?? null);
    return isMember ? void start() : setPaywall(true);
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
            ) : credits !== null ? (
              <CostLine credits={credits} />
            ) : null
          }
          onSubmit={submit}
        />
        {mode === 'agent' && allowance.exhausted ? (
          <p role="status" className={styles.allowanceNotice}>
            <FormattedMessage id="home.agent.allowanceUsedUp" values={{ date: intl.formatDate(allowance.resetsAt, { month: 'short', day: 'numeric' }) }} />
          </p>
        ) : null}
        <nav className={styles.entries} aria-label={intl.formatMessage({ id: 'home.start.label' })}>
          {ENTRIES.map((e) => (
            <Link key={e.key} to={e.to} className={styles.entry}>
              <span className={styles.entryIcon}>
                <PromptIcon name={e.icon} size={14} />
              </span>
              <FormattedMessage id={`home.entry.${e.key}`} />
            </Link>
          ))}
        </nav>
      </section>
      <Paywall
        open={paywall}
        onOpenChange={(o) => !paying && setPaywall(o)}
        variant="join"
        busy={paying}
        onContinue={(option) => {
          setPaying(true);
          checkoutPlan(option.id).then(
            () => {
              setPaying(false);
              setPaywall(false);
              if (isMockApi()) void start();
              else {
                takePendingAction('home.agent');
                void askAgent(text.trim(), refs, skill?.name ?? null);
              }
            },
            () => {
              setPaying(false);
              toast.show({ message: t('overlays.run.paymentFailed') });
            },
          );
        }}
      />
      {flow.element}
      {agent ? <HomeAgent state={agent} building={building} onBuild={build} onDismiss={() => setAgent(null)} /> : null}
      <HomeResult result={result} onChange={setResult} onRun={runFlow} />
      <RecentProjects />
      <Inspiration />
    </>
  );
}

function RecentProjects() {
  const intl = useIntl();
  const navigate = useNavigate();
  const createProject = useCreateProject();
  const { data: projects } = useRecentProjects();
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
        <Link to="/" hash="projects" className={styles.allLink}>
          <FormattedMessage id="home.projects.all" />
        </Link>
      </div>
      <div className={styles.projectGrid}>
        <Link
          to="/p/$projectId"
          params={{ projectId: 'prj_new' }}
          className={styles.newProject}
          onClick={(e) => {
            if (isMockApi()) return;
            // Real mode: create the project first, then open it.
            e.preventDefault();
            void createProject({ title: intl.formatMessage({ id: 'home.project.untitled' }), kind: 'canvas' }).then(({ id }) => navigate({ to: '/p/$projectId', params: { projectId: id } }));
          }}
        >
          <span className={styles.newIcon}>
            <PromptIcon name="plus" size={20} />
          </span>
          <span className={styles.newLabel}>
            <FormattedMessage id="home.projects.new" />
          </span>
        </Link>
        {projects.map((p) => (
          <Link key={p.id} to="/p/$projectId" params={{ projectId: p.id }} className={styles.project}>
            <div className={styles.projectThumb} style={p.thumbUrl ? { background: `center / cover no-repeat url("${p.thumbUrl}"), ${p.tone}` } : { background: p.tone }}>
              <span className={styles.badge}>
                <FormattedMessage id={`home.project.kind.${p.kind}`} />
              </span>
            </div>
            <span className={styles.projectName}>{p.title}</span>
            <span className={styles.projectMeta}>{meta(p)}</span>
          </Link>
        ))}
      </div>
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
  const tabsRef = useRef<HTMLDivElement>(null);
  const indicator = useIndicator(tabsRef, cat);
  const { data } = useTemplates();
  const feed = data.items.slice(0, 10).filter(CAT_FILTER[cat]);
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
      <div key={cat} className={styles.feed}>
        {feed.map((t, i) => (
          <Link
            key={t.id}
            to="/create/quick"
            search={{ template: t.id } as never}
            aria-label={intl.formatMessage({ id: 'home.inspiration.useLabel' }, { name: t.name })}
            className={cx(styles.feedCard, 'rl-stagger')}
            style={staggerStyle(i, { background: FEED_TONES[i % FEED_TONES.length], aspectRatio: t.coverAspect })}
            data-motion=""
          >
            <span className={styles.feedDur}>{formatSeconds(intl, t.durationSec)}</span>
            <div className={styles.feedFoot}>
              <span className={styles.feedName}>{t.name}</span>
              <span className={cx(styles.useBtn, 'rl-press')}>
                <FormattedMessage id="home.inspiration.use" />
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
