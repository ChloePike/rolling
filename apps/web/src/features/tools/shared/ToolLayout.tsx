import { useToast } from '@rolling/ui';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
import { assetMediaUrl, isApiError, isMockApi } from '@/features/overlays/backend';
import { agentFailure, applyProposal, sendTurn, threadFor, type AgentTool } from '@/features/overlays/agent';
import { downloadAsset } from '@/features/overlays/media';
import { listRuns, quoteSpec, resolveSpecAssets, retryRun, startQuote, type PromptSpec, type SpecQuote } from '@/features/overlays/runs';
import { savePendingAction, takePendingAction, useCheckoutResume } from '@/lib/session';

/** A tool run waiting for checkout (`savePendingAction('tools.run', …)`). */
interface PendingToolRun {
  path: string;
  prompt: string;
  spec: PromptSpec;
}
import { resolveAssetId } from '@/lib/transfers';
import { useSendToCanvas } from '@/features/canvas/target';

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
  /**
   * Real mode: what Generate quotes and runs (`POST /api/runs/quote { promptSpec }`), given the prompt.
   * A string is a message to show instead (e.g. an input is missing); the server's quote
   * explains anything else it can't run (blocked rows).
   */
  spec?: (prompt: string) => PromptSpec | string | null;
  /** Which tool's runs the real-mode feed lists (`RunView.tool`, default `quick`). */
  toolId?: 'quick' | 'remix' | 'avatar' | 'character';
  /** Real mode: the agent tool id for Simple-mode field filling (Refine), `propose.fields`. */
  agentTool?: AgentTool;
  /** Real mode: fields the agent proposed (`quick { prompt, model?, seconds?, ratio?, … }`) beyond the prompt. */
  onFields?: (fields: Record<string, unknown>) => void;
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
  const toCanvas = useSendToCanvas();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  /** A result goes to the canvas the user picks, as an asset node (tool runs have no project of their own). */
  const sendToCanvas = (run: MediaRun | null) => {
    if (!run) return;
    if (real && !run.assetId) return void toast.show({ message: t('canvas.target.noResult') });
    toCanvas.send({ name: run.prompt.slice(0, 60) || t('canvas.target.resultName'), media: run.video ? 'video' : 'image', assetId: real ? run.assetId : null, refId: run.assetId ?? run.id, source: 'generated', label: run.tags.join(' · ') });
  };
  const [overlay, setOverlay] = useState<ToolOverlay | null>(p.initialOverlay ?? null);
  const [filter, setFilter] = useState<Filter>('all');
  const [viewing, setViewing] = useState<MediaRun | null>(null);
  const [extraRefs, setExtraRefs] = useState<ComposerRef[]>([]);
  const [refining, setRefining] = useState(false);
  /** A run waiting for the confirm dialog (Generate, Retry, Regenerate). */
  const pendingRun = useRef<{ prompt: string; cost: number; quote?: SpecQuote } | null>(null);
  const real = !isMockApi();
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
        action: { label: t('tools.feed.retry'), onAction: () => (real ? retryReal(run) : spend(run.prompt, run.cost ?? p.confirm.cost)) },
      }),
  });

  // Real mode: the feed starts with this tool's recent runs (Activity index, `RunView.tool`).
  useEffect(() => {
    if (!real || !p.spec) return;
    let live = true;
    void listRuns({ first: 30 }).then(
      (page) => {
        if (!live) return;
        const tool = p.toolId ?? 'quick';
        const mine = page.runs.filter((r) => (r.tool ?? (r.source === 'quickCreate' ? 'quick' : null)) === tool && r.status !== 'running' && r.status !== 'queued');
        runs.setItems((cur) => [
          ...cur.filter((it) => it.kind === 'media' && it.runId),
          ...mine.map((r): MediaRun => {
            const asset = r.items.find((i) => i.assetId)?.assetId ?? null;
            return {
              kind: 'media',
              id: r.id,
              runId: r.id,
              assetId: asset,
              aspect: p.run.aspect,
              tiles: [{ tone: 'var(--c-tone-blank)', ...(asset ? { src: assetMediaUrl(asset) } : {}) }],
              prompt: r.name,
              tags: r.params.split(' · ').slice(1),
              video: r.items[0]?.kind !== 'image',
              actions: p.actions,
              finishedAgoMin: Math.round((Date.now() - (r.finishedAt ?? r.createdAt)) / 60_000),
              ...(r.status === 'failed' || (r.status === 'canceled' && !asset) ? { failed: { refunded: r.refunded } } : {}),
            };
          }),
        ]);
      },
      () => {},
    );
    return () => {
      live = false;
    };
    // Once per page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [real]);

  /** Real mode: `POST /api/runs { quoteId }` and a feed card that follows the run. */
  const beginReal = (prompt: string, quote: SpecQuote) => {
    void startQuote(quote.quoteId!).then(
      ({ runId }) => {
        runs.startReal({ ...p.run, prompt, cost: quote.total, actions: p.actions }, runId);
        setFilter((f) => (f === 'saved' ? 'all' : f));
        toast.show({ message: t('tools.toast.started', { n: quote.total }) });
      },
      (e: unknown) => runFailed(e, prompt),
    );
  };

  const runFailed = (e: unknown, prompt: string) => {
    if (isApiError(e, 'NO_PLAN')) return setOverlay('paywall');
    if (isApiError(e, 'INSUFFICIENT_CREDITS')) return void toast.show({ message: t('tools.toast.noCredits'), action: { label: t('tools.toast.topUp'), onAction: () => void navigate({ to: '/upgrade' }) } });
    if (isApiError(e, 'QUOTE_EXPIRED')) return void spendReal(prompt);
    if (isApiError(e, 'CONCURRENCY_LIMIT')) return void toast.show({ message: t('tools.toast.concurrency') });
    if (isApiError(e, 'MEMBER_LIMIT_REACHED')) return void toast.show({ message: t('tools.toast.memberLimit') });
    toast.show({ message: t('tools.toast.runError') });
  };

  /** A quote's outcome: blocked rows explain themselves, NO_PLAN opens the join paywall (the run resumes after checkout), else confirm per threshold (D-006). */
  const handleQuote = (prompt: string, q: SpecQuote, raw: PromptSpec) => {
    if (!q.quoteId) {
      const b = q.items.find((i) => i.action === 'blocked');
      if (b?.code === 'NO_PLAN') return joinFirst(prompt, raw);
      return void toast.show({ message: b?.reason ?? t('tools.toast.runError') });
    }
    if (q.needsConfirm) {
      pendingRun.current = { prompt, cost: q.total, quote: q };
      return setOverlay('confirm');
    }
    beginReal(prompt, q);
  };

  /** D-007: keep the run so it resumes after the checkout redirect (`tools.run`, this page). */
  const joinFirst = (prompt: string, raw: PromptSpec) => {
    savePendingAction('tools.run', { path: window.location.pathname, prompt, spec: raw } satisfies PendingToolRun);
    setOverlay('paywall');
  };

  /** Real mode: quote the tool's spec. */
  function spendReal(prompt: string, given?: PromptSpec) {
    const raw = given ?? p.spec?.(prompt);
    if (typeof raw === 'string') return void toast.show({ message: raw });
    if (!raw) return void toast.show({ message: t('tools.toast.runError') });
    void resolveSpecAssets(raw, resolveAssetId)
      .then((spec) => quoteSpec(spec))
      .then(
        (q) => handleQuote(prompt, q, raw),
        (e: unknown) => {
          if (isApiError(e, 'NO_PLAN')) return joinFirst(prompt, raw);
          runFailed(e, prompt);
        },
      );
  }

  /** Real mode: Retry on a failed card re-quotes that run's failed items with the same spec (`POST /api/runs/:id/retry`). */
  function retryReal(run: MediaRun) {
    if (!run.runId) return spendReal(run.prompt);
    void retryRun(run.runId).then(
      (q) => {
        runs.remove(run.id);
        const spec = p.spec?.(run.prompt);
        handleQuote(run.prompt, q, spec && typeof spec === 'object' ? spec : { kind: 'video', prompt: run.prompt });
      },
      (e: unknown) => {
        if (isApiError(e, 'CONFLICT')) return spendReal(run.prompt);
        runFailed(e, run.prompt);
      },
    );
  }

  // A run interrupted by the join paywall continues after checkout (also across the Stripe redirect).
  useCheckoutResume(() => {
    if (!real) return;
    const pending = takePendingAction<PendingToolRun>('tools.run', (d) => d.path === window.location.pathname);
    if (pending) spendReal(pending.prompt, pending.spec);
  });

  const begin = (prompt: string, cost: number) => {
    runs.start({ ...p.run, prompt, cost, actions: p.actions });
    // Hold and settle on the shared balance (header credits); the feed card shows the job itself.
    if (!real && !(window as unknown as { __rollingMocks?: { runFails?: boolean } }).__rollingMocks?.runFails) void startMockRun(cost).catch(() => undefined);
    setFilter((f) => (f === 'saved' ? 'all' : f));
  };

  /**
   * Generate, Retry and Regenerate: non-members get the join paywall (D-007);
   * runs quoted at or above the "Confirm before running" threshold open the
   * run confirm; smaller ones start right away (D-006, threshold 0 = always).
   */
  function spend(prompt = p.composer.text, cost = p.confirm.cost) {
    if (real) return spendReal(prompt);
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
    if (!real && !isMember) return setOverlay('paywall');
    const before = p.composer.text;
    if (!before.trim()) return toast.show({ message: t('tools.toast.refineEmpty') });
    if (real && p.agentTool) {
      // Simple mode: the agent fills the tool's fields (`propose.fields`); Apply returns them.
      setRefining(true);
      try {
        const thread = await threadFor(`tool:${p.agentTool}`, { surface: 'tool', tool: p.agentTool });
        const r = await sendTurn(thread.id, { text: before });
        const proposal = r.proposal?.body.kind === 'fields' ? r.proposal : null;
        if (!proposal) {
          toast.show({ message: r.text || t('tools.toast.refineNone') });
          return;
        }
        const applied = await applyProposal(proposal.id);
        const fields = applied.fields ?? (proposal.body.kind === 'fields' ? proposal.body.fields : {});
        if (typeof fields.prompt === 'string') p.composer.onText(fields.prompt);
        p.onFields?.(fields);
        toast.show({ message: t('tools.toast.refined'), action: { label: t('tools.toast.undo'), onAction: () => p.composer.onText(before) } });
      } catch (e) {
        const f = agentFailure(e);
        if (f.kind === 'join') setOverlay('paywall');
        else toast.show({ message: t(f.kind === 'allowance' ? 'tools.toast.allowance' : 'tools.toast.refineFailed') });
      } finally {
        setRefining(false);
      }
      return;
    }
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
        return sendToCanvas(item);
      case 'save':
        return toast.show({
          message: t('tools.toast.savedCharacter'),
          action: { label: t('tools.toast.view'), onAction: () => void navigate({ to: '/assets', search: { folder: 'characters' } }) },
        });
      case 'down':
        if (real && item.assetId) {
          void downloadAsset(item.assetId, item.prompt.slice(0, 60)).catch(() => toast.show({ message: t('tools.toast.runError') }));
          return toast.show({ message: t('tools.toast.downloaded') });
        }
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
                    if (real) return retryReal(run);
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
          if (real) {
            if (r.quote) beginReal(r.prompt, r.quote);
            else spendReal(r.prompt);
            return;
          }
          begin(r.prompt, r.cost);
        }}
      />
      <ToolPaywall open={overlay === 'paywall'} onClose={close} />
      {toCanvas.dialog}
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
            if (real && run?.assetId) {
              toast.show({ message: t('tools.toast.downloaded') });
              void downloadAsset(run.assetId, run.prompt.slice(0, 60)).catch(() => toast.show({ message: t('tools.toast.runError') }));
              return;
            }
            downloadMock(run?.id ?? 'result', run?.prompt ?? '', true);
            toast.show({ message: t('tools.toast.downloaded') });
          } else if (id === 'sendToCanvas') {
            sendToCanvas(run);
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
