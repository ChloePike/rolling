import type { PlanId } from '@rolling/core/pricing/config';
import { cx, presenceProps, usePresence, type PresenceState } from '@rolling/ui';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CatalogModel } from '@/lib/models';
import { findModel, formatLabel, mediaKind, resolutionOptions } from '../pricing';
import { runCost } from '../nodes/NodeCard';
import { useIntl } from 'react-intl';
import type { GraphNode } from '@rolling/core/graph';
import { CanvasIcon, type CanvasIconName } from '../icons';
import { MOCK_REFS, type PromptRef } from '../mocks';
import styles from './promptPanel.module.css';

interface PromptPanelProps {
  node: GraphNode;
  left: number;
  top: number;
  state: PresenceState;
  /** Extra references added through the `@` picker. */
  extraRefs: PromptRef[];
  pickerOpen: boolean;
  onOpenPicker: () => void;
  onGenerate: (nodeId: string) => void;
  /** Synced catalog (useModels), for the model's resolutions. */
  models: CatalogModel[] | undefined;
  plan: PlanId;
  onSetResolution: (nodeId: string, resolution: string) => void;
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

/**
 * Prompt editor attached under the selected image or video node: references
 * with their `@n` order, quick modifiers, the prompt with mention chips,
 * model pill first, params, the cost before running and Generate.
 */
export function PromptPanel({ node, left, top, state, extraRefs, pickerOpen, onOpenPicker, onGenerate, models, plan, onSetResolution }: PromptPanelProps) {
  const [resOpen, setResOpen] = useState(false);
  const resP = usePresence(resOpen);
  const intl = useIntl();
  const video = node.kind === 'video';
  const refIds = (Array.isArray(node.params.refs) ? node.params.refs : []) as string[];
  const refs = [...refIds.map((id) => MOCK_REFS[id]).filter((r): r is PromptRef => !!r), ...extraRefs];
  const quick = (Array.isArray(node.params.quick) ? node.params.quick : []) as string[];
  const count = typeof node.params.count === 'number' ? node.params.count : 1;
  const pills: Array<{ label: string; icon: CanvasIconName; caret: boolean; res?: boolean }> = video
    ? [
        { label: str(node.params.model), icon: 'cube', caret: true },
        { label: str(node.params.mode), icon: 'frame', caret: true },
        { label: formatLabel(node), icon: 'ratio', caret: false, res: true },
        { label: str(node.params.extra), icon: 'wave', caret: false },
      ]
    : [
        { label: str(node.params.model), icon: 'cube', caret: true },
        { label: str(node.params.mode), icon: 'image', caret: true },
        { label: formatLabel(node), icon: 'ratio', caret: false, res: true },
        { label: intl.formatMessage({ id: 'canvas.prompt.count' }, { n: count }), icon: 'copy', caret: false },
      ];
  const cost = runCost(node) ?? 0;
  const kind = mediaKind(node);
  const resolutions = kind ? resolutionOptions(findModel(models, node), kind, plan) : [];
  const running = node.status === 'generating' || node.status === 'queued';

  return (
    <div className={cx(styles.panel, 'rl-pop')} style={{ left, top }} {...presenceProps(state)} data-testid="prompt-panel">
      <div className={styles.top}>
        {refs.map((r, i) => (
          <div key={`${r.id}-${i}`} className={styles.ref} style={{ background: r.tone }} title={`${r.name} · ${r.source}`}>
            {r.letter}
            <span className={styles.refBadge}>@{i + 1}</span>
          </div>
        ))}
        <button
          type="button"
          className={styles.addRef}
          aria-label={intl.formatMessage({ id: 'canvas.prompt.addRef' })}
          aria-expanded={pickerOpen}
          aria-haspopup="dialog"
          onClick={onOpenPicker}
        >
          <CanvasIcon name="plus" size={16} />
        </button>
        <span className={styles.spacer} />
        {quick.map((q) => (
          <button key={q} type="button" className={styles.quick} title={q}>
            {intl.formatMessage({ id: `canvas.prompt.quick.${q}`, defaultMessage: q })}
          </button>
        ))}
      </div>
      <div className={styles.prompt} role="textbox" aria-readonly="true" aria-label={intl.formatMessage({ id: 'canvas.prompt.label' })}>
        {renderPrompt(str(node.params.prompt))}
      </div>
      <div className={styles.params}>
        {pills.map((p, i) => (
          <span key={i} className={styles.pillWrap}>
            <button
              type="button"
              className={cx(styles.param, i === 0 && styles.model)}
              {...(p.res ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': resOpen, onClick: () => setResOpen((o) => !o) } : {})}
            >
              <CanvasIcon name={p.icon} size={13} />
              {p.label}
              {p.caret ? <CanvasIcon name="caret" size={12} strokeWidth={2.4} className={styles.caret} /> : null}
            </button>
            {p.res && resP.mounted ? (
              <ResolutionMenu
                state={resP.state}
                current={typeof node.params.resolution === 'string' ? node.params.resolution : ''}
                options={resolutions}
                onClose={() => setResOpen(false)}
                onPick={(r) => {
                  onSetResolution(node.id, r);
                  setResOpen(false);
                }}
              />
            ) : null}
          </span>
        ))}
        <span className={styles.spacer} />
        <span className={styles.cost} aria-label={intl.formatMessage({ id: 'canvas.prompt.cost' }, { n: cost })}>
          <span className={styles.costDot} />
          {intl.formatNumber(cost)}
        </span>
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
    </div>
  );
}

interface ResolutionMenuProps {
  state: PresenceState;
  current: string;
  options: Array<{ value: string; allowed: boolean; unlockPlan: string | null }>;
  onPick: (resolution: string) => void;
  onClose: () => void;
}

/** Output resolution with plan caps (D-006): options above the plan are locked and name the plan that unlocks them. */
function ResolutionMenu({ state, current, options, onPick, onClose }: ResolutionMenuProps) {
  const intl = useIntl();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state !== 'open') return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
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
          aria-disabled={!o.allowed || undefined}
          aria-label={o.allowed ? o.value : intl.formatMessage({ id: 'canvas.prompt.lockedLabel' }, { resolution: o.value, plan: o.unlockPlan })}
          className={styles.resItem}
          onClick={() => o.allowed && onPick(o.value)}
        >
          <span>{o.value}</span>
          {o.allowed ? null : (
            <span className={styles.resLock}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                <path d="M7 11V7a5 5 0 0 1 10 0v4 M5 11h14v10H5z" />
              </svg>
              {intl.formatMessage({ id: 'canvas.prompt.locked' }, { plan: o.unlockPlan })}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
