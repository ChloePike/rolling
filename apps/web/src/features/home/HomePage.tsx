import { cx, staggerStyle, useIndicator } from '@rolling/ui';
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
import { Paywall } from '@/features/overlays';
import { useTemplates } from '@/features/templates/api';
import { checkoutPlan, useSession } from '@/lib/session';
import type { TemplateSummary } from '@/features/templates/types';
import { createProject, useRecentProjects } from './api';
import { formatSeconds, formatWhen } from './format';
import { HOME_MODES, type HomeModeId } from './modes';
import { FEED_TONES } from './mocks';
import { useHomePills } from './useHomePills';
import styles from './HomePage.module.css';
import type { ProjectSummary } from './types';

const ENTRIES: Array<{ key: string; to: string; icon: PromptIconName }> = [
  { key: 'blank', to: '/p/prj_new', icon: 'frame' },
  { key: 'template', to: '/create/quick', icon: 'bolt' },
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
  const commandGroups = useDefaultCommandGroups(skills, { model: 'model', aspect: 'ratio', duration: 'duration' });
  const { pills, renderPillPopover, credits } = useHomePills(mode);
  const { isMember } = useSession();
  // D-007: sending to the agent (or generating) needs a plan. Non-members get
  // the join paywall; the brief, refs and skill stay in the prompt box and the
  // send resumes after checkout.
  const [paywall, setPaywall] = useState(false);

  const modes: PromptMode[] = HOME_MODES.map((m) => ({ id: m.id, icon: m.icon, label: intl.formatMessage({ id: `home.mode.${m.id}` }) }));

  const start = async () => {
    const { id } = await createProject({ title: text.slice(0, 80) });
    void navigate({ to: '/p/$projectId', params: { projectId: id } });
  };
  const submit = () => (isMember ? start() : setPaywall(true));

  const onCommand = (c: PromptCommand) => {
    if (c.id === COMMAND.canvas) void navigate({ to: '/p/$projectId', params: { projectId: 'prj_new' } });
    else if (c.id === COMMAND.character) void navigate({ to: '/create/character' });
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
        onOpenChange={setPaywall}
        variant="join"
        onContinue={(option) => {
          void checkoutPlan(option.id).then(() => {
            setPaywall(false);
            void start();
          });
        }}
      />
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
