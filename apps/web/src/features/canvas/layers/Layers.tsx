import { cx, presenceProps, staggerStyle, type PresenceState } from '@rolling/ui';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { RunConfirmPanel, type RunPlanRow } from '@/features/overlays';
import { useReferences, type RefItem } from '@/features/prompt';
import canvas from '../canvas.module.css';
import type { NodeKind } from '@rolling/core/graph';
import { CanvasIcon, type CanvasIconName } from '../icons';
import { MOCK_RUNS, MOCK_TEMPLATES, SCRIPT_ROWS, SCRIPT_VERSIONS, type CanvasTemplate, type ScriptRow } from '../mocks';
import type { CanvasCredits, ShareAudience, ShareSettings } from '../api';
import styles from './layers.module.css';
import { CreditsPopoverContent } from '@/shell/CreditsPopover';
import { MenuPopover, MenuRows, rovingKeys } from './Menu';
import { useLayer } from './useLayer';

interface LayerProps {
  state: PresenceState;
  onClose: () => void;
}

/* ---------- Script full screen (CanvasScript) ---------- */

type ScriptCol = 'scene' | 'visual' | 'lines' | 'character' | 'duration' | 'references' | 'status';
const SCRIPT_COLS: Array<{ key: ScriptCol; width: string }> = [
  { key: 'scene', width: '1.1fr' },
  { key: 'visual', width: '2.2fr' },
  { key: 'lines', width: '1.6fr' },
  { key: 'character', width: '1fr' },
  { key: 'duration', width: '64px' },
  { key: 'references', width: '120px' },
  { key: 'status', width: '110px' },
];
type ScriptFilter = 'all' | 'selected' | 'notGenerated';

/** Older script version for the Versions menu (mock of `script.get` at v1). */
export function scriptVersionRows(version: string, current: ScriptRow[]): ScriptRow[] {
  if (version !== 'v1') return current;
  return SCRIPT_ROWS.slice(0, 3).map((r) => ({ ...r, visual: r.visual.replace(', slow push-in', ''), status: 'off' as const, selected: true }));
}

export interface ScriptDialogProps extends LayerProps {
  title: string;
  version: string;
  rows: ScriptRow[] | undefined;
  /** Saves the edited rows (and version) to the script node. */
  onChange: (rows: ScriptRow[], version: string) => void;
  /** Generate storyboard for the selected rows: builds image + video nodes (free). */
  onGenerate: (rows: ScriptRow[]) => void;
  /** Opened from the node's "Fields" button. */
  initialMenu?: 'fields' | null;
}

export function ScriptDialog({ state, onClose, title, version: versionProp, rows: rowsProp, onChange, onGenerate, initialMenu = null }: ScriptDialogProps) {
  const intl = useIntl();
  const ref = useLayer<HTMLDivElement>(state === 'open', onClose, { modal: true });
  const [rows, setRows] = useState<ScriptRow[]>(rowsProp ?? SCRIPT_ROWS);
  const [version, setVersion] = useState(versionProp || 'v2');
  const [hidden, setHidden] = useState<ScriptCol[]>([]);
  const [filter, setFilter] = useState<ScriptFilter>('all');
  const [menu, setMenu] = useState<'fields' | 'filter' | 'versions' | null>(initialMenu);
  const lastAdded = useRef<string | null>(null);
  const selected = rows.filter((r) => r.selected);
  const cols = SCRIPT_COLS.filter((c) => !hidden.includes(c.key));
  const template: CSSProperties = { gridTemplateColumns: ['36px', '44px', ...cols.map((c) => c.width)].join(' ') };
  const shown = rows.filter((r) => (filter === 'selected' ? r.selected : filter === 'notGenerated' ? r.status !== 'done' : true));

  const save = (next: ScriptRow[], v = version) => {
    setRows(next);
    onChange(next, v);
  };
  const patchRow = (n: string, patch: Partial<ScriptRow>) => save(rows.map((x) => (x.n === n ? { ...x, ...patch } : x)));
  const renumber = (list: ScriptRow[]) => list.map((r, i) => ({ ...r, n: String(i + 1).padStart(2, '0') }));

  useEffect(() => {
    if (!lastAdded.current) return;
    ref.current?.querySelector<HTMLElement>(`[data-row="${lastAdded.current}"] [data-field="visual"]`)?.focus();
    lastAdded.current = null;
  }, [rows, ref]);

  const cell = (r: ScriptRow, key: ScriptCol) => {
    const label = (field: string) => intl.formatMessage({ id: 'canvas.script.cellLabel' }, { field: intl.formatMessage({ id: `canvas.script.col.${field}` }), n: r.n });
    switch (key) {
      case 'scene':
        return <EditableText key={key} className={styles.muted} label={label('scene')} value={r.scene} onCommit={(v) => patchRow(r.n, { scene: v })} />;
      case 'visual':
        return (
          <EditableText
            key={key}
            field="visual"
            label={label('visual')}
            value={r.visual}
            placeholder={intl.formatMessage({ id: 'canvas.script.visualPlaceholder' })}
            onCommit={(v) => patchRow(r.n, { visual: v })}
          />
        );
      case 'lines':
        return (
          <EditableText
            key={key}
            className={styles.muted}
            label={label('lines')}
            value={r.line}
            placeholder={intl.formatMessage({ id: 'canvas.script.noLine' })}
            onCommit={(v) => patchRow(r.n, { line: v })}
          />
        );
      case 'character':
        return (
          <span key={key} className={styles.cast}>
            {r.cast.map((c) => (
              <span key={c} className={styles.castChip}>
                @{c}
              </span>
            ))}
          </span>
        );
      case 'duration':
        return (
          <span key={key}>
            <EditableText
              inline
              numeric
              label={label('duration')}
              value={String(r.seconds)}
              onCommit={(v) => patchRow(r.n, { seconds: Math.max(1, Math.min(30, Math.round(Number(v)) || r.seconds)) })}
            />
            {intl.formatMessage({ id: 'canvas.script.secondsUnit' })}
          </span>
        );
      case 'references':
        return (
          <span key={key} className={styles.thumbs}>
            <span className={styles.thumb} style={{ background: 'var(--c-tone-plum)' }} />
            <span className={styles.thumb} style={{ background: 'var(--c-tone-teal)' }} />
          </span>
        );
      case 'status':
        return (
          <span key={key} className={styles.state} data-status={r.status}>
            <FormattedMessage id={`canvas.script.status.${r.status}`} />
          </span>
        );
    }
  };

  return (
    <div className={cx(canvas.scrim, canvas.scrimScript, 'rl-fade')} {...presenceProps(state)} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={intl.formatMessage({ id: 'canvas.node.kind.script' })}
        tabIndex={-1}
        data-layer=""
        className={cx(styles.script, 'rl-modal')}
        {...presenceProps(state)}
      >
        <div className={styles.scriptHead}>
          <h2 className={styles.scriptTitle}>
            <FormattedMessage id="canvas.script.title" values={{ title }} />
          </h2>
          <span className={styles.ver}>{version}</span>
          <span className={styles.spacer} />
          <button
            type="button"
            className={styles.soft}
            onClick={() => {
              const n = String(rows.length + 1).padStart(2, '0');
              lastAdded.current = n;
              const last = rows[rows.length - 1];
              save([...rows, { n, scene: last?.scene ?? '', visual: '', line: '', cast: [], seconds: 4, status: 'pending', selected: true }]);
            }}
          >
                        <FormattedMessage id="canvas.script.addShot" />
          </button>
          <MenuPopover
            open={menu === 'fields'}
            onOpenChange={(o) => setMenu(o ? 'fields' : null)}
            label={intl.formatMessage({ id: 'canvas.script.fieldVisibility' })}
            align="end"
            entries={SCRIPT_COLS.map((c) => ({
              key: c.key,
              label: intl.formatMessage({ id: `canvas.script.col.${c.key}` }),
              kind: 'checkbox' as const,
              checked: !hidden.includes(c.key),
              keepOpen: true,
              disabled: c.key === 'visual',
              reason: c.key === 'visual' ? intl.formatMessage({ id: 'canvas.script.visualRequired' }) : undefined,
              onSelect: () => setHidden((h) => (h.includes(c.key) ? h.filter((x) => x !== c.key) : [...h, c.key])),
            }))}
            trigger={(t) => (
              <button {...t} type="button" className={styles.soft}>
                <FormattedMessage id="canvas.script.fieldVisibility" />
              </button>
            )}
          />
          <MenuPopover
            open={menu === 'filter'}
            onOpenChange={(o) => setMenu(o ? 'filter' : null)}
            label={intl.formatMessage({ id: 'canvas.script.filter' })}
            align="end"
            entries={(['all', 'selected', 'notGenerated'] as const).map((f) => ({
              key: f,
              label: intl.formatMessage({ id: `canvas.script.filter.${f}` }),
              checked: filter === f,
              onSelect: () => setFilter(f),
            }))}
            trigger={(t) => (
              <button {...t} type="button" className={cx(styles.soft, filter !== 'all' && styles.softOn)}>
                {filter === 'all' ? <FormattedMessage id="canvas.script.filter" /> : intl.formatMessage({ id: `canvas.script.filter.${filter}` })}
              </button>
            )}
          />
          <MenuPopover
            open={menu === 'versions'}
            onOpenChange={(o) => setMenu(o ? 'versions' : null)}
            label={intl.formatMessage({ id: 'canvas.script.versions' })}
            align="end"
            entries={SCRIPT_VERSIONS.map((v) => ({
              key: v,
              label: v,
              meta: v === SCRIPT_VERSIONS[0] ? intl.formatMessage({ id: 'canvas.script.latest' }) : undefined,
              checked: version === v,
              onSelect: () => {
                setVersion(v);
                save(scriptVersionRows(v, rowsProp ?? SCRIPT_ROWS), v);
              },
            }))}
            trigger={(t) => (
              <button {...t} type="button" className={styles.soft}>
                <FormattedMessage id="canvas.script.versions" />
              </button>
            )}
          />
          <button
            type="button"
            className={cx(styles.primary, 'rl-press')}
            aria-disabled={!selected.length || undefined}
            title={selected.length ? undefined : intl.formatMessage({ id: 'canvas.script.selectFirst' })}
            onClick={() => selected.length && onGenerate(selected)}
          >
            <FormattedMessage id="canvas.script.generate" values={{ n: selected.length }} />
            <span className={styles.badge}>~{intl.formatNumber(selected.length * 10)}</span>
          </button>
          <button type="button" className={styles.exit} aria-label={intl.formatMessage({ id: 'canvas.script.exit' })} onClick={onClose}>
            <CanvasIcon name="close" size={16} />
          </button>
        </div>
        <div className={styles.scroll}>
          <div className={styles.grid} role="table">
            <div className={cx(styles.cols, styles.th)} role="row" style={template}>
              <span role="columnheader" />
              <span role="columnheader">#</span>
              {cols.map((c) => (
                <span key={c.key} role="columnheader">
                  {intl.formatMessage({ id: `canvas.script.col.${c.key}` })}
                </span>
              ))}
            </div>
            {shown.map((r, i) => (
              <div key={r.n} className={cx(styles.cols, styles.tr, 'rl-stagger')} style={{ ...template, ...staggerStyle(i) }} role="row" data-motion="" data-row={r.n}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={r.selected}
                  aria-label={intl.formatMessage({ id: 'canvas.script.select' }, { n: r.n })}
                  className={styles.cb}
                  onClick={() => patchRow(r.n, { selected: !r.selected, status: r.selected ? 'off' : r.status === 'off' ? 'pending' : r.status })}
                />
                <span className={styles.num}>{r.n}</span>
                {cols.map((c) => cell(r, c.key))}
                <button
                  type="button"
                  className={styles.rowRemove}
                  aria-label={intl.formatMessage({ id: 'canvas.script.remove' }, { n: r.n })}
                  title={intl.formatMessage({ id: 'canvas.script.remove' }, { n: r.n })}
                  onClick={() => save(renumber(rows.filter((x) => x.n !== r.n)))}
                >
                  <CanvasIcon name="trash" size={14} />
                </button>
              </div>
            ))}
            {!shown.length ? (
              <p className={styles.empty}>
                <FormattedMessage id="canvas.script.empty" />
              </p>
            ) : null}

          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Text that edits in place and renders exactly like the static cell (wrapping
 * included): Enter or blur saves, Escape reverts.
 */
function EditableText({
  value,
  onCommit,
  label,
  placeholder,
  className,
  field,
  inline,
  numeric,
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
  field?: string;
  inline?: boolean;
  numeric?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current && document.activeElement !== ref.current && ref.current.textContent !== value) ref.current.textContent = value;
  }, [value]);
  return (
    <span
      ref={ref}
      role="textbox"
      aria-label={label}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      inputMode={numeric ? 'numeric' : undefined}
      data-placeholder={placeholder}
      data-field={field}
      className={cx(styles.editable, inline && styles.editableInline, className)}
      onBlur={(e) => {
        const v = (e.currentTarget.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (v !== value) onCommit(v);
        if (ref.current) ref.current.textContent = numeric && !v ? value : v;
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          e.currentTarget.textContent = value;
          e.currentTarget.blur();
        }
      }}
    >
      {value}
    </span>
  );
}

/* ---------- Share (CanvasShare) ---------- */

export interface ShareDialogProps extends LayerProps {
  share: ShareSettings;
  onCopy: () => void;
  onUpdate: (patch: Partial<Pick<ShareSettings, 'audience' | 'allowDownloads' | 'showPrompt'>>) => void;
  onStop: () => void;
  onPublish: () => void;
  busy: boolean;
}

export function ShareDialog({ state, onClose, share, onCopy, onUpdate, onStop, onPublish, busy }: ShareDialogProps) {
  const intl = useIntl();
  const ref = useLayer<HTMLDivElement>(state === 'open', onClose, { modal: true });
  const [audienceOpen, setAudienceOpen] = useState(false);
  const toggles: Array<{ k: 'download' | 'prompt'; on: boolean; flip: () => void }> = [
    { k: 'download', on: share.allowDownloads, flip: () => onUpdate({ allowDownloads: !share.allowDownloads }) },
    { k: 'prompt', on: share.showPrompt, flip: () => onUpdate({ showPrompt: !share.showPrompt }) },
  ];
  const audienceLabel = (a: ShareAudience) => intl.formatMessage({ id: `canvas.shareDialog.view.${a}` });
  return (
    <div className={cx(canvas.scrim, 'rl-fade')} {...presenceProps(state)} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="canvas-share-title"
        tabIndex={-1}
        data-layer=""
        className={cx(styles.share, 'rl-modal')}
        {...presenceProps(state)}
        data-active={share.active}
      >
        <div className={styles.shareHead}>
          <h2 id="canvas-share-title" className={styles.shareTitle}>
            <FormattedMessage id="canvas.shareDialog.title" />
          </h2>
          <button type="button" className={styles.close} aria-label={intl.formatMessage({ id: 'canvas.shareDialog.close' })} onClick={onClose}>
            <CanvasIcon name="close" size={16} />
          </button>
        </div>
        <span className={styles.shareNote} role="status">
          {share.active ? (
            <FormattedMessage id="canvas.shareDialog.snapshot" values={{ date: share.snapshotAt }} />
          ) : (
            <FormattedMessage id="canvas.shareDialog.stopped" />
          )}
        </span>
        <div className={styles.linkRow}>
          <div className={cx(styles.link, !share.active && styles.linkOff)} data-testid="share-link">
            {share.active ? share.url : intl.formatMessage({ id: 'canvas.shareDialog.linkOff' })}
          </div>
          <button
            type="button"
            className={cx(styles.copy, 'rl-press')}
            aria-disabled={!share.active || undefined}
            title={share.active ? undefined : intl.formatMessage({ id: 'canvas.shareDialog.copyOff' })}
            onClick={() => share.active && onCopy()}
          >
            <FormattedMessage id="canvas.shareDialog.copy" />
          </button>
        </div>
        <div className={styles.setting}>
          <span className={styles.settingText}>
            <span className={styles.settingName}>
              <FormattedMessage id="canvas.shareDialog.view" />
            </span>
            <span className={styles.settingDesc}>
              <FormattedMessage id={`canvas.shareDialog.view.${share.audience}.desc`} />
            </span>
          </span>
          <MenuPopover
            open={audienceOpen}
            onOpenChange={setAudienceOpen}
            label={intl.formatMessage({ id: 'canvas.shareDialog.view' })}
            align="end"
            entries={(['link', 'workspace'] as const).map((a) => ({ key: a, label: audienceLabel(a), checked: share.audience === a, onSelect: () => onUpdate({ audience: a }) }))}
            trigger={(t) => (
              <button {...t} type="button" className={styles.settingValue} aria-label={`${intl.formatMessage({ id: 'canvas.shareDialog.view' })}: ${audienceLabel(share.audience)}`}>
                <FormattedMessage id="canvas.shareDialog.view.value" values={{ value: audienceLabel(share.audience) }} />
              </button>
            )}
          />
        </div>
        {toggles.map((r) => (
          <div key={r.k} className={styles.setting}>
            <span className={styles.settingText}>
              <span className={styles.settingName} id={`canvas-share-${r.k}`}>
                <FormattedMessage id={`canvas.shareDialog.${r.k}`} />
              </span>
              <span className={styles.settingDesc}>
                <FormattedMessage id={`canvas.shareDialog.${r.k}.desc`} />
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={r.on}
              aria-labelledby={`canvas-share-${r.k}`}
              className={cx(styles.settingValue, r.on && styles.settingOn)}
              onClick={r.flip}
            >
              <FormattedMessage id={r.on ? `canvas.shareDialog.${r.k}.on` : `canvas.shareDialog.${r.k}.off`} />
            </button>
          </div>
        ))}
        <div className={styles.shareFoot}>
          <button
            type="button"
            className={styles.stop}
            aria-disabled={!share.active || busy || undefined}
            title={share.active ? undefined : intl.formatMessage({ id: 'canvas.shareDialog.stoppedShort' })}
            onClick={() => share.active && !busy && onStop()}
          >
            <FormattedMessage id="canvas.shareDialog.stop" />
          </button>
          <button type="button" className={styles.publish} aria-busy={busy || undefined} onClick={() => !busy && onPublish()}>
            <FormattedMessage id={share.active ? 'canvas.shareDialog.publish' : 'canvas.shareDialog.shareAgain'} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Run-all quote (CanvasPlan → RunConfirm variant graph) ---------- */

export function PlanDialog({ state, onClose, rows, onConfirm, balance }: LayerProps & { rows: RunPlanRow[]; onConfirm: () => void; balance: number }) {
  const ref = useLayer<HTMLDivElement>(state === 'open', onClose, { modal: true });
  const intl = useIntl();
  return (
    <div className={cx(canvas.scrim, 'rl-fade')} {...presenceProps(state)} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={intl.formatMessage({ id: 'overlays.runConfirm.graph.title', defaultMessage: 'Run all' })}
        tabIndex={-1}
        data-layer=""
        className={cx(styles.plan, 'rl-modal')}
        {...presenceProps(state)}
        data-testid="plan-dialog"
      >
        <RunConfirmPanel variant="graph" rows={rows} balance={balance} eta={intl.formatMessage({ id: 'canvas.plan.eta' })} onConfirm={onConfirm} onCancel={onClose} />
      </div>
    </div>
  );
}

/* ---------- Add node menu (CanvasAdd) ---------- */

export interface AddItem {
  key: 'text' | 'script' | 'image' | 'video' | 'audio' | 'director' | 'autoEdit';
  icon: CanvasIconName;
  kind?: NodeKind;
  note?: 'script' | 'soon';
}

export const ADD_ITEMS: AddItem[] = [
  { key: 'text', icon: 'doc', kind: 'text' },
  { key: 'script', icon: 'scroll', kind: 'script', note: 'script' },
  { key: 'image', icon: 'image', kind: 'image' },
  { key: 'video', icon: 'video', kind: 'video' },
  { key: 'audio', icon: 'wave', kind: 'audio' },
  { key: 'director', icon: 'director', note: 'soon' },
  { key: 'autoEdit', icon: 'autoEdit', note: 'soon' },
];

/** What a pick in the add menu creates. */
export type AddPick = { type: 'node'; kind: NodeKind; variant?: 'original' | 'adapted' } | { type: 'resource'; item: RefItem };

export function AddNodeMenu({
  state,
  onClose,
  x,
  y,
  suggested,
  onPick,
  onSoon,
  accept,
}: LayerProps & {
  x: number;
  y: number;
  suggested: NodeKind | null;
  onPick: (pick: AddPick) => void;
  onSoon: (key: AddItem['key']) => void;
  /** Dropping a wire on empty canvas: only kinds (and resource types) that can take the other end. */
  accept?: { kinds: NodeKind[]; resources: Array<'image' | 'audio'> } | null;
}) {
  const intl = useIntl();
  const ref = useLayer<HTMLDivElement>(state === 'open', onClose, { focus: false });
  const [tab, setTab] = useState<'node' | 'resource'>('node');
  const [scriptStep, setScriptStep] = useState(false);
  const [q, setQ] = useState('');
  const refs = useReferences().data ?? [];
  const items = useMemo(
    () =>
      ADD_ITEMS.filter(
        (it) =>
          (!accept || (it.kind && accept.kinds.includes(it.kind))) &&
          (!q || intl.formatMessage({ id: `canvas.add.${it.key}` }).toLowerCase().includes(q.toLowerCase())),
      ),
    [q, intl, accept],
  );
  const resources = useMemo(
    () =>
      refs
        .filter((r) => r.group !== 'pub' && (!accept || accept.resources.includes(r.group === 'voice' ? 'audio' : 'image')))
        .filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 8),
    [refs, q, accept],
  );
  // Until the pointer or arrows move it, the kind of the selected node is suggested.
  const [active, setActive] = useState<number | null>(null);
  const count = tab === 'node' ? (scriptStep ? 2 : items.length) : resources.length;
  const current = Math.max(0, Math.min(active ?? (tab === 'node' && !scriptStep ? Math.max(0, items.findIndex((it) => it.kind === suggested)) : 0), count - 1));
  const pick = (it: AddItem | undefined) => {
    if (!it) return;
    if (it.note === 'soon') onSoon(it.key);
    else if (it.kind === 'script') {
      setScriptStep(true);
      setActive(0);
    } else if (it.kind) onPick({ type: 'node', kind: it.kind });
  };
  const scriptVariants = ['original', 'adapted'] as const;
  const choose = (i: number) => {
    if (tab === 'resource') {
      const r = resources[i];
      if (r) onPick({ type: 'resource', item: r });
    } else if (scriptStep) onPick({ type: 'node', kind: 'script', variant: scriptVariants[i] });
    else pick(items[i]);
  };
  return (
    <>
      <span className={cx(canvas.dropDot, 'rl-fade')} style={{ left: x - 8, top: y - 8 }} {...presenceProps(state)} aria-hidden="true" />
      <div
        ref={ref}
        role="menu"
        aria-label={intl.formatMessage({ id: 'canvas.add.label' })}
        className={cx(canvas.addMenu, 'rl-pop')}
        style={{ left: x, top: y }}
        {...presenceProps(state)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((current + (e.key === 'ArrowDown' ? 1 : count - 1)) % Math.max(1, count));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(current);
          } else if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && scriptStep && (e.target as HTMLElement).tagName !== 'INPUT') {
            e.preventDefault();
            setScriptStep(false);
            setActive(null);
          }
        }}
      >
        <div className={canvas.addTabs} role="tablist">
          {(['node', 'resource'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={canvas.addTab}
              onClick={() => {
                setTab(t);
                setScriptStep(false);
                setActive(null);
              }}
            >
              <FormattedMessage id={`canvas.add.tab.${t}`} />
            </button>
          ))}
        </div>
        <label htmlFor="canvas-add-q" className="rl-visually-hidden">
          <FormattedMessage id={tab === 'node' ? 'canvas.add.search' : 'canvas.add.searchResource'} />
        </label>
        <input
          id="canvas-add-q"
          className={canvas.addSearch}
          placeholder={intl.formatMessage({ id: tab === 'node' ? 'canvas.add.searchPlaceholder' : 'canvas.add.resourcePlaceholder' })}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
        />
        {tab === 'node' && scriptStep
          ? scriptVariants.map((v, i) => (
              <button
                key={v}
                type="button"
                role="menuitem"
                className={cx(canvas.addItem, 'rl-stagger')}
                style={staggerStyle(i)}
                data-motion=""
                data-active={i === current ? '' : undefined}
                onPointerEnter={() => setActive(i)}
                onClick={() => choose(i)}
              >
                <span className={canvas.addIcon}>
                  <CanvasIcon name="scroll" size={14} />
                </span>
                <span className={canvas.addLabel}>
                  <FormattedMessage id={`canvas.add.script.${v}`} />
                </span>
              </button>
            ))
          : null}
        {tab === 'node' && !scriptStep
          ? items.map((it, i) => (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                aria-disabled={it.note === 'soon' ? true : undefined}
                aria-haspopup={it.kind === 'script' ? 'menu' : undefined}
                title={it.note === 'soon' ? intl.formatMessage({ id: `canvas.add.soonReason.${it.key}` }) : undefined}
                className={cx(canvas.addItem, 'rl-stagger')}
                style={staggerStyle(i)}
                data-motion=""
                data-active={i === current ? '' : undefined}
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(it)}
              >
                <span className={canvas.addIcon}>
                  <CanvasIcon name={it.icon} size={14} />
                </span>
                <span className={canvas.addLabel}>
                  <FormattedMessage id={`canvas.add.${it.key}`} />
                </span>
                <span className={canvas.addNote}>
                  {it.note === 'script' ? <FormattedMessage id="canvas.add.script.note" /> : it.note === 'soon' ? <FormattedMessage id="canvas.add.soon" /> : null}
                </span>
              </button>
            ))
          : null}
        {tab === 'resource'
          ? resources.map((r, i) => (
              <button
                key={r.id}
                type="button"
                role="menuitem"
                className={cx(canvas.addItem, 'rl-stagger')}
                style={staggerStyle(i)}
                data-motion=""
                data-active={i === current ? '' : undefined}
                onPointerEnter={() => setActive(i)}
                onClick={() => choose(i)}
              >
                <span className={canvas.addIcon} style={{ background: r.tone }}>
                  {r.glyph.type === 'letter' ? r.glyph.letter : <CanvasIcon name={r.group === 'voice' ? 'wave' : 'image'} size={14} />}
                </span>
                <span className={canvas.addLabel}>{r.name}</span>
                <span className={canvas.addNote}>
                  <FormattedMessage id={`canvas.add.source.${r.source}`} />
                </span>
              </button>
            ))
          : null}
        {count === 0 ? (
          <div className={canvas.addEmpty}>
            <FormattedMessage id="canvas.add.empty" values={{ q }} />
          </div>
        ) : null}
      </div>
    </>
  );
}

/* ---------- Credits popover ---------- */

export function CreditsPopover({ state, onClose, credits }: LayerProps & { credits: CanvasCredits }) {
  const intl = useIntl();
  const ref = useLayer<HTMLDivElement>(state === 'open', onClose);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={intl.formatMessage({ id: 'canvas.credits.label' })}
      tabIndex={-1}
      data-layer=""
      className={cx(canvas.creditsPop, 'rl-pop')}
      {...presenceProps(state)}
    >
      {/* Same content as the shared header's credits popover (D-006 top-ups). */}
      <CreditsPopoverContent credits={credits} onNavigate={onClose} />
    </div>
  );
}

/* ---------- Run history drawer ---------- */

export interface HistoryRow {
  id: string;
  nodeId?: string;
  title: string;
  model: string;
  credits: number;
  status: 'running' | 'done' | 'failed';
  progress?: number;
  refunded?: number;
  at: Date;
}

export function HistoryDrawer({ state, onClose, rows, onOpen }: LayerProps & { rows: HistoryRow[]; onOpen: (nodeId: string) => void }) {
  const intl = useIntl();
  const ref = useLayer<HTMLDivElement>(state === 'open', onClose, { focus: false });
  return (
    <section
      ref={ref}
      aria-label={intl.formatMessage({ id: 'canvas.history.title' })}
      className={cx(canvas.history, 'rl-panel')}
      {...presenceProps(state)}
    >
      <div className={canvas.historyHead}>
        <span>
          <FormattedMessage id="canvas.history.title" />
        </span>
        <button type="button" className={canvas.closeBtn} aria-label={intl.formatMessage({ id: 'canvas.history.close' })} onClick={onClose}>
          <CanvasIcon name="close" size={16} />
        </button>
      </div>
      <div className={canvas.historyList} role="list" onKeyDown={rovingKeys}>
        {rows.length === 0 ? (
          <span className={canvas.historyMeta}>
            <FormattedMessage id="canvas.history.empty" />
          </span>
        ) : null}
        {rows.map((r, i) => (
          <div key={r.id} role="listitem" className={cx(canvas.historyItem, 'rl-stagger')} style={staggerStyle(i)} data-motion="">
            <button
              type="button"
              role="menuitem"
              className={canvas.historyRow}
              aria-label={intl.formatMessage({ id: 'canvas.history.show' }, { title: r.title })}
              onClick={() => r.nodeId && onOpen(r.nodeId)}
            >
              <span className={canvas.historyText}>
                <span className={canvas.historyTitle}>{r.title}</span>
                <span className={canvas.historyMeta}>
                  {r.model} · {intl.formatTime(r.at, { hour: 'numeric', minute: '2-digit' })}
                </span>
              </span>
              <span className={canvas.historyState} data-status={r.status}>
                {r.status === 'running' ? (
                  <FormattedMessage id="canvas.history.running" values={{ p: r.progress ?? 0 }} />
                ) : r.status === 'failed' ? (
                  <FormattedMessage id="canvas.history.failed" values={{ n: r.refunded ?? 0 }} />
                ) : (
                  <FormattedMessage id="canvas.history.done" />
                )}
              </span>
              <span className={canvas.historyCredits}>
                <FormattedMessage id="canvas.history.credits" values={{ n: r.status === 'failed' ? 0 : r.credits }} />
              </span>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------- Workflows and templates (tool rail) ---------- */

export function TemplatesPanel({ state, onClose, onUse }: LayerProps & { onUse: (tpl: CanvasTemplate) => void }) {
  const intl = useIntl();
  const ref = useLayer<HTMLDivElement>(state === 'open', onClose);
  return (
    <section
      ref={ref}
      tabIndex={-1}
      data-layer=""
      aria-label={intl.formatMessage({ id: 'canvas.tools.flow' })}
      className={cx(canvas.toolPanel, 'rl-pop')}
      style={{ ['--rl-pop-dir' as string]: 0 }}
      {...presenceProps(state)}
    >
      <div className={canvas.historyHead}>
        <span>
          <FormattedMessage id="canvas.templates.title" />
        </span>
        <button type="button" className={canvas.closeBtn} aria-label={intl.formatMessage({ id: 'canvas.templates.close' })} onClick={onClose}>
          <CanvasIcon name="close" size={16} />
        </button>
      </div>
      <MenuRows
        onClose={() => {}}
        entries={MOCK_TEMPLATES.map((t) => ({
          key: t.id,
          label: t.name,
          meta: intl.formatMessage({ id: 'canvas.templates.nodes' }, { n: t.nodes.length }),
          onSelect: () => onUse(t),
        }))}
      />
      <Link className={canvas.toolPanelLink} to="/templates">
        <FormattedMessage id="canvas.templates.all" />
      </Link>
    </section>
  );
}

export { MOCK_RUNS };
