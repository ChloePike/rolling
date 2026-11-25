import { useToast } from '@rolling/ui';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import type { PlanId } from '@rolling/core/pricing/config';
import { usePref } from '@/lib/prefs';
import { startMockRun, useSession } from '@/lib/session';
import type { ToolModel } from './models';
import type { ComposerPill, ComposerRef, FeedItem, MediaRun, ParamKind, PickerKind, ScriptDraft } from '../types';
import { Composer, type ComposerProps } from './Composer';
import { downloadMock } from './download';
import { FeedCard, type DraftAction } from './FeedCard';
import type { ToolIconName } from './icons';
import { ToolModelPicker, ToolParamPopover, ToolPaywall, ToolResultViewer, ToolRunConfirm } from './overlays';
import { SettingsGroup, type SettingsGroupDef } from './SettingsGroup';
import styles from './ToolLayout.module.css';
import { useFilePicker } from './useFilePicker';
import { usePresence } from './usePresence';
import { useRuns, type RunSpec } from './useRuns';

export type ToolOverlay = 'model' | 'params' | 'confirm' | 'viewer' | 'paywall';
type Filter = 'all' | 'running' | 'saved';
const FILTERS: Filter[] = ['all', 'running', 'saved'];

/** What a new run looks like in the feed; the layout adds prompt, cost and actions. */
export type RunShape = Omit<RunSpec, 'prompt' | 'cost' | 'actions'>;

export interface ToolLayoutProps {
  testId: string;
  title: string;
  /** Result count line, from the number of finished media runs in the feed. */
  count: (feed: FeedItem[]) => string;
  /** Minimum feed column width, px. */
  feedMin: number;
  feed: FeedItem[];
  /** Left panel cards shown in both modes. */
  aside: ReactNode;
  advanced: boolean;
  advGroups: SettingsGroupDef[];
  composer: Omit<ComposerProps, 'openOverlay' | 'onPill' | 'onSend' | 'onRefine' | 'onAdd' | 'refining'>;
  pickerKind: PickerKind;
  /** Picker list, from `useToolModels`. */
  models: ToolModel[];
  paramKind: ParamKind;
  /** Selected model name ("Auto" for Auto). */
  model: string;
  onModel: (name: string) => void;
  confirm: { cost: number; label: string };
  /** Shape of a run started from the composer. */
  run: RunShape;
  /** Feed card actions of new runs. */
  actions: ToolIconName[];
  viewerAspect: string;
  initialOverlay?: ToolOverlay | null;
  /** Active plan (D-007). Defaults to the session (lib/session). */
  isMember?: boolean;
  /** Plan whose resolution caps the settings popover shows (D-006). */
  plan?: PlanId;
  /** Draft "Rewrite with another persona" (Avatar): returns the rewritten draft. */
  onRewriteDraft?: (draft: ScriptDraft) => ScriptDraft;
  /** Decorates feed items at render (e.g. the draft's live persona and voice line). */
  mapItem?: (item: FeedItem) => FeedItem;
}

/** Deterministic mock of the agent's prompt refinement (members only, D-007). */
function refinePrompt(text: string): string {
  const t = text.trim().replace(/[.\s]+$/, '');
  if (!t) return t;
  return `${t}. Keep the subject, framing and lighting consistent between shots; smooth camera, no cuts mid-line.`;
}

/** Shared layout of Quick Create, Remix, Avatar and Characters: left panel, history feed, floating composer. */
export function ToolLayout(p: ToolLayoutProps) {
  const intl = useIntl();
  const toast = useToast();
  const navigate = useNavigate();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const [overlay, setOverlay] = useState<ToolOverlay | null>(p.initialOverlay ?? null);
  const [filter, setFilter] = useState<Filter>('all');
  const [viewing, setViewing] = useState<MediaRun | null>(null);
  const [extraRefs, setExtraRefs] = useState<ComposerRef[]>([]);
  const [refining, setRefining] = useState(false);
  /** A run waiting for the confirm dialog (Generate, Retry, Regenerate). */
  const pendingRun = useRef<{ prompt: string; cost: number } | null>(null);
  const adv = usePresence(p.advanced, 140);
  const pillsRef = useRef<HTMLDivElement>(null);
  const close = () => setOverlay(null);
  const session = useSession();
  const isMember = p.isMember ?? session.isMember;
  const threshold = usePref('confirmThreshold');
  const runs = useRuns(p.feed, {
    onDone: (run) =>
      toast.show({
        message: t(run.video ? 'tools.toast.doneVideo' : 'tools.toast.doneImage'),
        action: {
          label: t('tools.toast.view'),
          onAction: () => {
            setViewing(run);
            setOverlay('viewer');
          },
        },
      }),
    onFail: (run) =>
      toast.show({
        message: t('tools.toast.failed', { n: run.failed?.refunded ?? 0 }),
        action: { label: t('tools.feed.retry'), onAction: () => spend(run.prompt, run.cost ?? p.confirm.cost) },
      }),
  });

  const begin = (prompt: string, cost: number) => {
    runs.start({ ...p.run, prompt, cost, actions: p.actions });
    // Hold and settle on the shared balance (header credits); the feed card shows the job itself.
    if (!(window as unknown as { __rollingMocks?: { runFails?: boolean } }).__rollingMocks?.runFails) void startMockRun(cost).catch(() => undefined);
    setFilter((f) => (f === 'saved' ? 'all' : f));
  };

  /**
   * Generate, Retry and Regenerate: non-members get the join paywall (D-007);
   * runs quoted at or above the "Confirm before running" threshold open the
   * run confirm; smaller ones start right away (D-006, threshold 0 = always).
   */
  function spend(prompt = p.composer.text, cost = p.confirm.cost) {
    if (!isMember) return setOverlay('paywall');
    if (threshold > 0 && cost < threshold) {
      begin(prompt, cost);
      toast.show({ message: t('tools.toast.started', { n: cost }) });
      return;
    }
    pendingRun.current = { prompt, cost };
    setOverlay('confirm');
  }

  async function refine() {
    if (!isMember) return setOverlay('paywall');
    const before = p.composer.text;
    if (!before.trim()) return toast.show({ message: t('tools.toast.refineEmpty') });
    setRefining(true);
    await new Promise((r) => setTimeout(r, 600));
    setRefining(false);
    p.composer.onText(refinePrompt(before));
    toast.show({ message: t('tools.toast.refined'), action: { label: t('tools.toast.undo'), onAction: () => p.composer.onText(before) } });
  }

  const refPicker = useFilePicker('image/*,video/*,audio/*', (file) => {
    const stem = file.name.replace(/\.[^.]+$/, '').slice(0, 14) || 'Ref';
    setExtraRefs((r) => [...r, { badge: `@${stem}`, tone: 'var(--c-tone-indigo)' }]);
    toast.show({ message: t('tools.toast.refAdded', { name: file.name }) });
  });

  const toggle = (o: ToolOverlay) => setOverlay((cur) => (cur === o ? null : o));
  // The model pill opens the model picker; every other pill opens the one settings popover.
  const onPill = (_pill: ComposerPill, i: number) => toggle(i === 0 ? 'model' : 'params');

  function onAction(item: MediaRun, a: ToolIconName) {
    switch (a) {
      case 'redo':
        return spend(item.prompt, item.cost ?? p.confirm.cost);
      case 'sliders':
        p.composer.onText(item.prompt);
        return toast.show({ message: t('tools.toast.reused') });
      case 'frame':
        toast.show({ message: t('tools.toast.toCanvas') });
        return void navigate({ to: '/p/$projectId', params: { projectId: 'prj_demo' } });
      case 'save':
        return toast.show({
          message: t('tools.toast.savedCharacter'),
          action: { label: t('tools.toast.view'), onAction: () => void navigate({ to: '/assets', search: { folder: 'characters' } }) },
        });
      case 'down':
        downloadMock(item.id, item.prompt, item.video);
        return toast.show({ message: t('tools.toast.downloaded') });
      case 'star': {
        const was = runs.favorites.has(item.id);
        runs.toggleFavorite(item.id);
        return toast.show({ message: t(was ? 'tools.toast.unfavorited' : 'tools.toast.favorited') });
      }
      default:
        return undefined;
    }
  }

  function onDraft(d: ScriptDraft, a: DraftAction) {
    if (a === 'confirm') return spend(d.lines.map((l) => l.text).join(' '), p.confirm.cost);
    if (!isMember) return setOverlay('paywall');
    if (a === 'revise') {
      p.composer.onText(d.lines.map((l) => l.text).join(' '));
      document.querySelector<HTMLTextAreaElement>('[data-testid="tool-composer"] textarea')?.focus();
      return toast.show({ message: t('tools.toast.revise') });
    }
    if (p.onRewriteDraft) runs.replaceDraft(d.id, (cur) => p.onRewriteDraft!(cur));
    toast.show({ message: t('tools.toast.rewritten') });
  }

  const visible = runs.items.map((it) => (p.mapItem ? p.mapItem(it) : it)).filter((it) => {
    if (filter === 'all') return true;
    const running = it.kind === 'media' && it.progress !== undefined;
    return filter === 'running' ? running : it.kind === 'media' && !running && !it.failed;
  });

  return (
    <div className={styles.root} data-testid={p.testId} data-mode={p.advanced ? 'advanced' : 'simple'}>
      {refPicker.input}
      <aside className={styles.aside} aria-label={t('tools.aside.label')}>
        {p.aside}
        {adv.mounted && (
          <>
            <div className={`${styles.advRule} ${adv.state === 'enter' ? styles.advEnter : styles.advExit}`}>
              <FormattedMessage id="tools.adv.title" />
            </div>
            {p.advGroups.map((g, i) => (
              <SettingsGroup
                key={g.id}
                def={g}
                className={adv.state === 'enter' ? styles.advEnter : styles.advExit}
                style={{ '--i': Math.min(i + 1, 5) } as CSSProperties}
              />
            ))}
          </>
        )}
      </aside>
      <section className={styles.section} aria-label={t('tools.history.label')}>
        <div className={styles.scroll}>
          <div className={styles.inner}>
            <div className={styles.head}>
              <h1 className={styles.title}>{p.title}</h1>
              <span className={styles.count}>{p.count(runs.items)}</span>
              <span className={styles.spacer} />
              <div role="tablist" aria-label={t('tools.filter.label')} className={styles.tabs}>
                {FILTERS.map((f) => (
                  <button key={f} type="button" role="tab" aria-selected={filter === f} className={styles.tab} onClick={() => setFilter(f)}>
                    <FormattedMessage id={`tools.filter.${f}`} />
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.grid} style={{ '--feed-min': `${p.feedMin}px` } as CSSProperties}>
              {visible.map((it, i) => (
                <FeedCard
                  key={it.id}
                  item={it}
                  index={i}
                  favorite={runs.favorites.has(it.id)}
                  onOpen={(run) => {
                    setViewing(run);
                    setOverlay('viewer');
                  }}
                  onAction={onAction}
                  onCancel={(run) => {
                    runs.cancel(run.id);
                    toast.show({ message: t('tools.toast.canceled', { n: run.cost ?? 0 }) });
                  }}
                  onRetry={(run) => {
                    runs.remove(run.id);
                    spend(run.prompt, run.cost ?? p.confirm.cost);
                  }}
                  onDraft={onDraft}
                />
              ))}
              {visible.length === 0 && (
                <p className={styles.empty}>
                  <FormattedMessage id={`tools.empty.${filter}`} />
                </p>
              )}
            </div>
          </div>
        </div>
        <Composer
          {...p.composer}
          refs={[...p.composer.refs, ...extraRefs]}
          pillsRef={pillsRef}
          openOverlay={overlay === 'model' || overlay === 'params' ? overlay : null}
          onPill={onPill}
          onSend={() => spend()}
          onRefine={() => void refine()}
          refining={refining}
          onAdd={refPicker.open}
        />
        <ToolModelPicker
          open={overlay === 'model'}
          kind={p.pickerKind}
          models={p.models}
          selected={p.model}
          onPick={(name) => {
            p.onModel(name);
            close();
          }}
          onClose={close}
          anchorClassName={styles.anchor}
          anchorRef={pillsRef}
        />
        <ToolParamPopover open={overlay === 'params'} kind={p.paramKind} plan={p.plan} onClose={close} anchorClassName={styles.anchor} anchorRef={pillsRef} />
      </section>
      <ToolRunConfirm
        open={overlay === 'confirm'}
        cost={pendingRun.current?.cost ?? p.confirm.cost}
        label={p.confirm.label}
        views={p.paramKind === 'image'}
        onClose={close}
        onConfirm={() => {
          const r = pendingRun.current ?? { prompt: p.composer.text, cost: p.confirm.cost };
          pendingRun.current = null;
          close();
          begin(r.prompt, r.cost);
        }}
      />
      <ToolPaywall open={overlay === 'paywall'} onClose={close} />
      <ToolResultViewer
        open={overlay === 'viewer'}
        aspect={viewing?.aspect ?? p.viewerAspect}
        // Runs started here show their own prompt; seeded history uses the viewer's mock details.
        prompt={viewing?.cost !== undefined ? viewing.prompt : undefined}
        onClose={close}
        onAction={(id) => {
          const run = viewing;
          close();
          if (id === 'download') {
            downloadMock(run?.id ?? 'result', run?.prompt ?? '', true);
            toast.show({ message: t('tools.toast.downloaded') });
          } else if (id === 'sendToCanvas') {
            void navigate({ to: '/p/$projectId', params: { projectId: 'prj_demo' } });
          } else if (id === 'edit') {
            p.composer.onText(run?.prompt ?? '');
            toast.show({ message: t('tools.toast.reused') });
          } else {
            spend(run?.prompt ?? p.composer.text, p.confirm.cost);
          }
        }}
      />
    </div>
  );
}
