import type { PlanId } from '@rolling/core/pricing/config';
import { cx, presenceProps, usePresence, type PresenceState } from '@rolling/ui';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { modeLabel, modelLabel, type CatalogModel } from '@/lib/models';
import { ModelIcon, modelIcon } from '@/lib/modelIcons';
import {
  defaultImageParams,
  defaultVideoParams,
  ModelPicker,
  ParamPopover,
  PlanLock,
  type ImageParams,
  type ModelOption,
  type PlanLockInfo,
  type VideoAspect,
  type VideoParams,
} from '@/features/overlays';
import { catalogToOptions } from '@/features/overlays';
import { findModel, formatLabel, mediaKind, resolutionOptions } from '../pricing';
import { runCost } from '../nodes/NodeCard';
import { useIntl } from 'react-intl';
import type { GraphNode } from '@rolling/core/graph';
import { CanvasIcon, type CanvasIconName } from '../icons';
import { MenuPopover } from '../layers/Menu';
import type { PromptRef } from '../mocks';
import { MODES, QUICK_OPTIONS } from './options';
import { isMockApi, mockData } from '@/lib/api/mode';
import { Skeleton } from '@rolling/ui';
import styles from './promptPanel.module.css';

interface PromptPanelProps {
  node: GraphNode;
  left: number;
  top: number;
  state: PresenceState;
  /** The node's references, in `@n` order. */
  refs: PromptRef[];
  pickerOpen: boolean;
  /** Opens the `@` picker; `fromTyping` when the user typed `@` at the end of the prompt. */
  onOpenPicker: (fromTyping?: boolean) => void;
  onGenerate: (nodeId: string) => void;
  /** Synced catalog (useModels), for the model's resolutions. */
  models: CatalogModel[] | undefined;
  plan: PlanId;
  /** Commits a param patch for the node (an `updateNode` op). */
  onUpdate: (nodeId: string, params: Record<string, unknown>) => void;
  onRemoveRef: (nodeId: string, index: number) => void;
}

/** Splits `Start from @[Product keyframe], …` into text and mention chips, spaced like the design. */
export function renderPrompt(text: string): ReactNode[] {
  const parts = text.split(/@\[([^\]]+)\]/);
  const out: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(' ', <span key={i} className={styles.chip}>@{part}</span>, ' ');
    } else {
      const t = i === 0 ? part.trimEnd() : i === parts.length - 1 ? part.trimStart() : part.trim();
      if (t) out.push(<Fragment key={i}>{t}</Fragment>);
    }
  });
  return out;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

type PillKey = 'model' | 'mode' | 'format' | 'extra';
const RATIOS: VideoAspect[] = ['Auto', '9:16', '16:9', '1:1', '4:3', '3:4'];

function videoValue(node: GraphNode): VideoParams {
  const p = node.params;
  const res = str(p.resolution);
  return {
    aspectRatio: RATIOS.includes(str(p.ratio) as VideoAspect) ? (str(p.ratio) as VideoAspect) : defaultVideoParams.aspectRatio,
    resolution: (['480p', '720p', '1080p'].includes(res) ? res : defaultVideoParams.resolution) as VideoParams['resolution'],
    duration: (['5s', '10s', '15s', '30s'].includes(`${p.length}s`) ? `${p.length}s` : defaultVideoParams.duration) as VideoParams['duration'],
    count: (['1', '2', '4'].includes(String(p.count ?? 1)) ? String(p.count ?? 1) : '1') as VideoParams['count'],
    audio: p.audio === undefined ? !/Audio off/.test(str(p.extra)) : p.audio === true,
  };
}

function imageValue(node: GraphNode): ImageParams {
  const p = node.params;
  return {
    aspectRatio: RATIOS.includes(str(p.ratio) as VideoAspect) ? (str(p.ratio) as VideoAspect) : defaultImageParams.aspectRatio,
    quality: p.quality === 'high' ? 'high' : 'standard',
    size: (['1K', '2K', '4K'].includes(str(p.resolution)) ? str(p.resolution) : defaultImageParams.size) as ImageParams['size'],
    count: (['1', '2', '4'].includes(String(p.count ?? 1)) ? String(p.count ?? 1) : '1') as ImageParams['count'],
  };
}

/**
 * Prompt editor attached under the selected image or video node: references
 * with their `@n` order, quick modifiers, the prompt with mention chips,
 * model pill first, params, the cost before running and Generate.
 */
export function PromptPanel({ node, left, top, state, refs, pickerOpen, onOpenPicker, onGenerate, models, plan, onUpdate, onRemoveRef }: PromptPanelProps) {
  const intl = useIntl();
  const [open, setOpen] = useState<PillKey | null>(null);
  const [quickOpen, setQuickOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(str(node.params.prompt));
  const resP = usePresence(open === 'format');
  const modelRef = useRef<HTMLButtonElement>(null);
  const extraRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const video = node.kind === 'video';
  const kind = mediaKind(node) ?? 'image';
  const quick = (Array.isArray(node.params.quick) ? node.params.quick : []) as string[];
  const modifiers = (node.params.modifiers && typeof node.params.modifiers === 'object' ? node.params.modifiers : {}) as Record<string, string>;
  const count = typeof node.params.count === 'number' ? node.params.count : 1;

  useEffect(() => {
    if (!editing) setDraft(str(node.params.prompt));
  }, [node.params.prompt, editing]);
  useEffect(() => {
    if (editing) {
      const el = textRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);
  // Close pill layers when another node is selected.
  useEffect(() => setOpen(null), [node.id]);

  const fromCatalog: ModelOption[] = models?.length ? catalogToOptions(models, kind) : [];
  // Real mode: the synced catalog only (empty while it loads); mock mode falls back to the design list.
  const options: ModelOption[] = fromCatalog.length || !isMockApi() ? fromCatalog : mockData().overlays.mockModels[kind];
  const currentModel = options.find((o) => o.id === node.params.modelId || o.id === node.params.model || o.name === node.params.model);
  const extraLabel = video
    ? intl.formatMessage({ id: 'canvas.prompt.extra' }, { n: count, audio: videoValue(node).audio ? 'on' : 'off' })
    : intl.formatMessage({ id: 'canvas.prompt.count' }, { n: count });
  const pills: Array<{ key: PillKey; label: string; icon: CanvasIconName; caret: boolean }> = [
    { key: 'model', label: modelLabel(models, node.params.model), icon: 'cube', caret: true },
    { key: 'mode', label: modeLabel(node.params.mode), icon: video ? 'frame' : 'image', caret: true },
    { key: 'format', label: formatLabel(node), icon: 'ratio', caret: false },
    { key: 'extra', label: video ? str(node.params.extra) || extraLabel : extraLabel, icon: video ? 'wave' : 'copy', caret: false },
  ];
  /** The node's price from the catalog (usePricedNodes); unknown until the catalog answers. */
  const cost = runCost(node) ?? null;
  const resolutions = resolutionOptions(intl, findModel(models, node), kind, plan);
  const running = node.status === 'generating' || node.status === 'queued';
  const toggle = (k: PillKey) => setOpen((o) => (o === k ? null : k));

  const commitDraft = () => {
    setEditing(false);
    if (draft !== str(node.params.prompt)) onUpdate(node.id, { prompt: draft });
  };

  /**
   * Mock mode only: the design's D-006 scale (Seedance 720p 347 per 5s, an
   * image 11). Real mode stores no estimate; usePricedNodes re-prices every
   * node from `useModels()`.
   */
  const estimate = (_opt: ModelOption | undefined, patch: { seconds?: number; count?: number }): number | undefined => {
    if (!isMockApi()) return undefined;
    const n = patch.count ?? count;
    const m = mockData().canvas;
    return video ? m.mockVideoCredits(patch.seconds ?? (typeof node.params.length === 'number' ? node.params.length : 5)) * n : m.MOCK_PRICE.image * n;
  };

  return (
    <div className={cx(styles.panel, 'rl-pop')} style={{ left, top }} {...presenceProps(state)} data-testid="prompt-panel">
      <div className={styles.top}>
        {refs.map((r, i) => (
          <button
            key={`${r.id}-${i}`}
            type="button"
            className={styles.ref}
            style={{ background: r.tone }}
            title={`${r.name} · ${r.source}`}
            aria-label={intl.formatMessage({ id: 'canvas.prompt.removeRef' }, { n: i + 1, name: r.name })}
            onClick={() => onRemoveRef(node.id, i)}
          >
            {r.letter}
            <span className={styles.refBadge}>@{i + 1}</span>
            <span className={styles.refRemove} aria-hidden="true">
              <CanvasIcon name="close" size={12} />
            </span>
          </button>
        ))}
        <button
          type="button"
          className={styles.addRef}
          aria-label={intl.formatMessage({ id: 'canvas.prompt.addRef' })}
          aria-expanded={pickerOpen}
          aria-haspopup="dialog"
          onClick={() => onOpenPicker(false)}
        >
          <CanvasIcon name="plus" size={16} />
        </button>
        <span className={styles.spacer} />
        {quick.map((q) => {
          const value = modifiers[q];
          const name = intl.formatMessage({ id: `canvas.prompt.quick.${q}`, defaultMessage: q });
          return (
            <MenuPopover
              key={q}
              open={quickOpen === q}
              onOpenChange={(o) => setQuickOpen(o ? q : null)}
              label={name}
              align="end"
              title={name}
              entries={[
                ...(QUICK_OPTIONS[q] ?? []).map((v) => ({
                  key: v,
                  label: v,
                  checked: value === v,
                  onSelect: () => onUpdate(node.id, { modifiers: { ...modifiers, [q]: v } }),
                })),
                {
                  key: '__none',
                  label: intl.formatMessage({ id: 'canvas.prompt.quick.none' }),
                  checked: !value,
                  onSelect: () => {
                    const { [q]: _drop, ...rest } = modifiers;
                    onUpdate(node.id, { modifiers: rest });
                  },
                },
              ]}
              trigger={(t) => (
                <button {...t} type="button" className={cx(styles.quick, value && styles.quickOn)} title={value ? `${name}: ${value}` : name}>
                  {value ? intl.formatMessage({ id: 'canvas.prompt.quick.value' }, { name, value }) : name}
                </button>
              )}
            />
          );
        })}
      </div>
      {editing ? (
        <textarea
          ref={textRef}
          className={cx(styles.prompt, styles.promptInput)}
          aria-label={intl.formatMessage({ id: 'canvas.prompt.label' })}
          value={draft}
          rows={2}
          onChange={(e) => {
            const v = e.target.value;
            setDraft(v);
            if (v.endsWith('@') && !pickerOpen) onOpenPicker(true);
          }}
          onBlur={() => {
            // The @ picker takes focus; keep editing until it closes.
            if (!pickerOpen) commitDraft();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setDraft(str(node.params.prompt));
              setEditing(false);
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commitDraft();
            }
          }}
        />
      ) : (
        <div
          className={styles.prompt}
          role="textbox"
          tabIndex={0}
          aria-multiline="true"
          aria-label={intl.formatMessage({ id: 'canvas.prompt.label' })}
          onClick={() => setEditing(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || (e.key.length === 1 && !e.metaKey && !e.ctrlKey)) {
              e.preventDefault();
              setEditing(true);
            }
          }}
          data-testid="prompt-text"
        >
          {str(node.params.prompt) ? renderPrompt(str(node.params.prompt)) : <span className={styles.placeholder}>{intl.formatMessage({ id: 'canvas.prompt.placeholder' })}</span>}
        </div>
      )}
      <div className={styles.params}>
        {pills.map((p, i) => {
          const button = (extra: Record<string, unknown> = {}) => (
            <button
              type="button"
              className={cx(styles.param, i === 0 && styles.model)}
              aria-expanded={open === p.key}
              aria-haspopup={p.key === 'format' || p.key === 'mode' ? 'menu' : 'dialog'}
              onClick={() => toggle(p.key)}
              {...extra}
            >
              {p.key === 'model' && modelIcon(currentModel?.id) ? <ModelIcon modelId={currentModel!.id} size={13} /> : <CanvasIcon name={p.icon} size={13} />}
              {p.label}
              {p.caret ? <CanvasIcon name="caret" size={12} strokeWidth={2.4} className={styles.caret} /> : null}
            </button>
          );
          if (p.key === 'mode') {
            return (
              <MenuPopover
                key={p.key}
                open={open === 'mode'}
                onOpenChange={(o) => setOpen(o ? 'mode' : null)}
                label={intl.formatMessage({ id: 'canvas.prompt.mode' })}
                title={intl.formatMessage({ id: 'canvas.prompt.mode' })}
                entries={MODES[kind].map((m) => ({ key: m, label: m, checked: m === modeLabel(node.params.mode), onSelect: () => onUpdate(node.id, { mode: m }) }))}
                trigger={(t) => (
                  <button {...t} type="button" className={styles.param}>
                    <CanvasIcon name={p.icon} size={13} />
                    {p.label}
                    <CanvasIcon name="caret" size={12} strokeWidth={2.4} className={styles.caret} />
                  </button>
                )}
              />
            );
          }
          return (
            <span key={p.key} className={styles.pillWrap}>
              {button(p.key === 'model' ? { ref: modelRef } : p.key === 'extra' ? { ref: extraRef } : {})}
              {p.key === 'format' && resP.mounted ? (
                <ResolutionMenu
                  state={resP.state}
                  current={typeof node.params.resolution === 'string' ? node.params.resolution : ''}
                  options={resolutions}
                  onClose={() => setOpen(null)}
                  onPick={(r) => {
                    onUpdate(node.id, { resolution: r });
                    setOpen(null);
                  }}
                />
              ) : null}
            </span>
          );
        })}
        <span className={styles.spacer} />
        {cost === null ? (
          <span className={styles.cost} aria-busy="true">
            <Skeleton width={36} height={12} />
          </span>
        ) : (
          <span className={styles.cost} aria-label={intl.formatMessage({ id: 'canvas.prompt.cost' }, { n: cost })}>
            <span className={styles.costDot} />
            {intl.formatNumber(cost)}
          </span>
        )}
        <button
          type="button"
          className={cx(styles.go, 'rl-press')}
          aria-label={intl.formatMessage({ id: 'canvas.prompt.generate' })}
          disabled={running}
          onClick={() => onGenerate(node.id)}
        >
          <CanvasIcon name="arrowUp" size={16} strokeWidth={2.8} />
        </button>
      </div>
      <ModelPicker
        kind={kind}
        open={open === 'model'}
        value={currentModel?.id ?? ''}
        models={options}
        anchorRef={modelRef}
        placement="below"
        className={styles.layer}
        onClose={() => setOpen(null)}
        onValueChange={(id) => {
          const opt = options.find((o) => o.id === id);
          if (opt) onUpdate(node.id, { model: opt.name, modelId: opt.id, runCost: estimate(opt, {}) ?? node.params.runCost });
          setOpen(null);
        }}
      />
      {video ? (
        <ParamPopover
          kind="video"
          open={open === 'extra'}
          value={videoValue(node)}
          plan={plan}
          cost={cost}
          anchorRef={extraRef}
          placement="below"
          className={styles.layer}
          onClose={() => setOpen(null)}
          onValueChange={(v) => {
            const seconds = parseInt(v.duration, 10);
            const n = Number(v.count);
            onUpdate(node.id, {
              ratio: v.aspectRatio,
              resolution: v.resolution,
              length: seconds,
              count: n,
              audio: v.audio,
              extra: intl.formatMessage({ id: 'canvas.prompt.extra' }, { n, audio: v.audio ? 'on' : 'off' }),
              runCost: estimate(currentModel, { seconds, count: n }) ?? node.params.runCost,
            });
          }}
        />
      ) : (
        <ParamPopover
          kind="image"
          open={open === 'extra'}
          value={imageValue(node)}
          plan={plan}
          cost={cost}
          anchorRef={extraRef}
          placement="below"
          className={styles.layer}
          onClose={() => setOpen(null)}
          onValueChange={(v) => {
            const n = Number(v.count);
            onUpdate(node.id, { ratio: v.aspectRatio, resolution: v.size, quality: v.quality, count: n, runCost: estimate(currentModel, { count: n }) ?? node.params.runCost });
          }}
        />
      )}
    </div>
  );
}

interface ResolutionMenuProps {
  state: PresenceState;
  current: string;
  options: Array<{ value: string; lock: PlanLockInfo | null }>;
  onPick: (resolution: string) => void;
  onClose: () => void;
}

/** Output resolution with plan caps (D-006): options above the plan are locked and name the plan that unlocks them. */
function ResolutionMenu({ state, current, options, onPick, onClose }: ResolutionMenuProps) {
  const intl = useIntl();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state !== 'open') return;
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (i < 0 || !items.length) return;
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]!.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [state, onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={intl.formatMessage({ id: 'canvas.prompt.resolution' })}
      className={cx(styles.resMenu, 'rl-pop')}
      style={{ ['--rl-pop-dir' as string]: 1 }}
      {...presenceProps(state)}
    >
      <span className={styles.resTitle}>{intl.formatMessage({ id: 'canvas.prompt.resolution' })}</span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="menuitemradio"
          aria-checked={o.value === current}
          aria-disabled={o.lock ? true : undefined}
          aria-label={o.lock ? o.lock.label : o.value}
          title={o.lock?.reason}
          className={styles.resItem}
          onClick={() => !o.lock && onPick(o.value)}
        >
          <span>{o.value}</span>
          {o.lock ? <PlanLock plan={o.lock.plan} /> : null}
        </button>
      ))}
    </div>
  );
}
