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
import { useTemplates } from '@/features/templates/api';
import { checkoutPlan, useSession } from '@/lib/session';
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
  const { pills, renderPillPopover, credits, run } = useHomePills(mode);
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

  const runFlow = (req: Omit<RunRequest, 'onDone'>, done: (runId: string) => void) =>
    flow.request({ ...req, viewLabel: t('overlays.run.view'), onDone: (r) => done(r.id) });

  const generate = () => {
    if (!run) return;
    const cost = credits ?? 0;
    const actionLabel = t(`home.send.${mode}`);
    const brief = text.trim();
    const snapshot = { run, refs, title: title(), cost };
    runFlow({ cost, kind: run.kind, actionLabel, meta: run.meta, subtitle: run.modelName }, (runId) =>
      setResult({
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

  const submit = () => {
    if (!text.trim() && !refs.length && !skill) {
      document.getElementById('brief')?.focus();
      toast.show({ message: t('home.send.empty') });
      return;
    }
    if (mode !== 'agent') return generate();
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
              void start();
            },
            () => {
              setPaying(false);
              toast.show({ message: t('overlays.run.paymentFailed') });
            },
          );
        }}
      />
      {flow.element}
      <HomeResult result={result} onChange={setResult} onRun={runFlow} />
      <RecentProjects />
      <Inspiration />
    </>
  );
}

function RecentProjects() {
  const intl = useIntl();
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
        <Link to="/p/$projectId" params={{ projectId: 'prj_new' }} className={styles.newProject}>
          <span className={styles.newIcon}>
            <PromptIcon name="plus" size={20} />
          </span>
          <span className={styles.newLabel}>
            <FormattedMessage id="home.projects.new" />
          </span>
        </Link>
        {projects.map((p) => (
          <Link key={p.id} to="/p/$projectId" params={{ projectId: p.id }} className={styles.project}>
            <div className={styles.projectThumb} style={{ background: p.tone }}>
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
