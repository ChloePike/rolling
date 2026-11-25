import { cx, presenceProps, staggerStyle, type PresenceState } from '@rolling/ui';
import { useMemo, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { RunConfirmPanel, type RunPlanRow } from '@/features/overlays';
import canvas from '../canvas.module.css';
import type { NodeKind } from '@rolling/core/graph';
import { CanvasIcon, type CanvasIconName } from '../icons';
import { MOCK_CREDITS, MOCK_RUNS, SCRIPT_ROWS } from '../mocks';
import styles from './layers.module.css';
import { useLayer } from './useLayer';

interface LayerProps {
  state: PresenceState;
  onClose: () => void;
}

/* ---------- Script full screen (CanvasScript) ---------- */

export function ScriptDialog({ state, onClose, title, version }: LayerProps & { title: string; version: string }) {
  const intl = useIntl();
  const ref = useLayer<HTMLDivElement>(state === 'open', onClose, { modal: true });
  const [rows, setRows] = useState(SCRIPT_ROWS);
  const selected = rows.filter((r) => r.selected).length;
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
          <button type="button" className={styles.soft}>
            <FormattedMessage id="canvas.script.fieldVisibility" />
          </button>
          <button type="button" className={styles.soft}>
            <FormattedMessage id="canvas.script.filter" />
          </button>
          <button type="button" className={styles.soft}>
            <FormattedMessage id="canvas.script.versions" />
          </button>
          <button type="button" className={cx(styles.primary, 'rl-press')}>
            <FormattedMessage id="canvas.script.generate" values={{ n: selected }} />
            <span className={styles.badge}>~{intl.formatNumber(selected * 10)}</span>
          </button>
          <button type="button" className={styles.exit} aria-label={intl.formatMessage({ id: 'canvas.script.exit' })} onClick={onClose}>
            <CanvasIcon name="close" size={16} />
          </button>
        </div>
        <div className={styles.scroll}>
          <div className={styles.grid} role="table">
            <div className={cx(styles.cols, styles.th)} role="row">
              <span role="columnheader" />
              <span role="columnheader">#</span>
              {(['scene', 'visual', 'lines', 'character', 'duration', 'references', 'status'] as const).map((k) => (
                <span key={k} role="columnheader">
                  {intl.formatMessage({ id: `canvas.script.col.${k}` })}
                </span>
              ))}
            </div>
            {rows.map((r, i) => (
              <div key={r.n} className={cx(styles.cols, styles.tr, 'rl-stagger')} style={staggerStyle(i)} role="row" data-motion="">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={r.selected}
                  aria-label={intl.formatMessage({ id: 'canvas.script.select' }, { n: r.n })}
                  className={styles.cb}
                  onClick={() => setRows((all) => all.map((x) => (x.n === r.n ? { ...x, selected: !x.selected } : x)))}
                />
                <span className={styles.num}>{r.n}</span>
                <span className={styles.muted}>{r.scene}</span>
                <span>{r.visual}</span>
                <span className={styles.muted}>{r.line || intl.formatMessage({ id: 'canvas.script.noLine' })}</span>
                <span className={styles.cast}>
                  {r.cast.map((c) => (
                    <span key={c} className={styles.castChip}>
                      @{c}
                    </span>
                  ))}
                </span>
                <span>{intl.formatMessage({ id: 'canvas.node.seconds' }, { n: r.seconds })}</span>
                <span className={styles.thumbs}>
                  <span className={styles.thumb} style={{ background: '#26232A' }} />
                  <span className={styles.thumb} style={{ background: '#1F2628' }} />
                </span>
                <span className={styles.state} data-status={r.status}>
                  <FormattedMessage id={`canvas.script.status.${r.status}`} />
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Share (CanvasShare) ---------- */

export function ShareDialog({ state, onClose, url, snapshotAt, onCopy }: LayerProps & { url: string; snapshotAt: Date; onCopy: () => void }) {
  const intl = useIntl();
  const ref = useLayer<HTMLDivElement>(state === 'open', onClose, { modal: true });
  const [downloads, setDownloads] = useState(false);
  const [prompt, setPrompt] = useState(true);
  const rows: Array<{ k: string; value: string; onClick?: () => void }> = [
    { k: 'view', value: intl.formatMessage({ id: 'canvas.shareDialog.view.value' }) },
    { k: 'download', value: intl.formatMessage({ id: downloads ? 'canvas.shareDialog.download.on' : 'canvas.shareDialog.download.off' }), onClick: () => setDownloads((d) => !d) },
    { k: 'prompt', value: intl.formatMessage({ id: prompt ? 'canvas.shareDialog.prompt.on' : 'canvas.shareDialog.prompt.off' }), onClick: () => setPrompt((p) => !p) },
  ];
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
      >
        <div className={styles.shareHead}>
          <h2 id="canvas-share-title" className={styles.shareTitle}>
            <FormattedMessage id="canvas.shareDialog.title" />
          </h2>
          <button type="button" className={styles.close} aria-label={intl.formatMessage({ id: 'canvas.shareDialog.close' })} onClick={onClose}>
            <CanvasIcon name="close" size={16} />
          </button>
        </div>
        <span className={styles.shareNote}>
          <FormattedMessage id="canvas.shareDialog.snapshot" values={{ date: snapshotAt }} />
        </span>
        <div className={styles.linkRow}>
          <div className={styles.link}>{url}</div>
          <button type="button" className={cx(styles.copy, 'rl-press')} onClick={onCopy}>
            <FormattedMessage id="canvas.shareDialog.copy" />
          </button>
        </div>
        {rows.map((r) => (
          <div key={r.k} className={styles.setting}>
            <span className={styles.settingText}>
              <span className={styles.settingName}>
                <FormattedMessage id={`canvas.shareDialog.${r.k}`} />
              </span>
              <span className={styles.settingDesc}>
                <FormattedMessage id={`canvas.shareDialog.${r.k}.desc`} />
              </span>
            </span>
            <button type="button" className={styles.settingValue} onClick={r.onClick} aria-label={`${intl.formatMessage({ id: `canvas.shareDialog.${r.k}` })}: ${r.value}`}>
              {r.value}
            </button>
          </div>
        ))}
        <div className={styles.shareFoot}>
          <button type="button" className={styles.stop}>
            <FormattedMessage id="canvas.shareDialog.stop" />
          </button>
          <button type="button" className={styles.publish}>
            <FormattedMessage id="canvas.shareDialog.publish" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Run-all quote (CanvasPlan → RunConfirm variant graph) ---------- */

export function PlanDialog({ state, onClose, rows, onConfirm }: LayerProps & { rows: RunPlanRow[]; onConfirm: () => void }) {
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
        <RunConfirmPanel
          variant="graph"
          rows={rows}
          balance={MOCK_CREDITS.balance}
          eta={intl.formatMessage({ id: 'canvas.plan.eta' })}
          onConfirm={onConfirm}
          onCancel={onClose}
        />
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

export function AddNodeMenu({
  state,
  onClose,
  x,
  y,
  suggested,
  onPick,
}: LayerProps & { x: number; y: number; suggested: NodeKind | null; onPick: (kind: NodeKind) => void }) {
  const intl = useIntl();
  const ref = useLayer<HTMLDivElement>(state === 'open', onClose, { focus: false });
  const [q, setQ] = useState('');
  const items = useMemo(
    () => ADD_ITEMS.filter((it) => !q || intl.formatMessage({ id: `canvas.add.${it.key}` }).toLowerCase().includes(q.toLowerCase())),
    [q, intl],
  );
  // Until the pointer or arrows move it, the kind of the selected node is suggested.
  const [active, setActive] = useState<number | null>(null);
  const current = Math.min(active ?? Math.max(0, items.findIndex((it) => it.kind === suggested)), items.length - 1);
  const pick = (it: AddItem | undefined) => {
    if (it?.kind && it.note !== 'soon') onPick(it.kind);
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
            setActive((current + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(1, items.length));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(items[current]);
          }
        }}
      >
        <div className={canvas.addTabs} role="tablist">
          <button type="button" role="tab" aria-selected="true" className={canvas.addTab}>
            <FormattedMessage id="canvas.add.tab.node" />
          </button>
          <button type="button" role="tab" aria-selected="false" className={canvas.addTab}>
            <FormattedMessage id="canvas.add.tab.resource" />
          </button>
        </div>
        <label htmlFor="canvas-add-q" className="rl-visually-hidden">
          <FormattedMessage id="canvas.add.search" />
        </label>
        <input
          id="canvas-add-q"
          className={canvas.addSearch}
          placeholder={intl.formatMessage({ id: 'canvas.add.searchPlaceholder' })}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
        />
        {items.map((it, i) => (
          <button
            key={it.key}
            type="button"
            role="menuitem"
            aria-disabled={it.note === 'soon' ? true : undefined}
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
        ))}
        {items.length === 0 ? (
          <div className={canvas.addEmpty}>
            <FormattedMessage id="canvas.add.empty" values={{ q }} />
          </div>
        ) : null}
      </div>
    </>
  );
}

/* ---------- Credits popover ---------- */

export function CreditsPopover({ state, onClose }: LayerProps) {
  const intl = useIntl();
  const ref = useLayer<HTMLDivElement>(state === 'open', onClose);
  const c = MOCK_CREDITS;
  const [pack, setPack] = useState(c.packs[1]!);
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
      <div className={canvas.cpTop}>
        <div className={canvas.cpBalance}>
          <span className={canvas.cpLabel}>
            <FormattedMessage id="canvas.credits.available" />
          </span>
          <span className={canvas.cpValue}>{intl.formatNumber(c.balance)}</span>
        </div>
        <a href="/activity" className={canvas.cpLink}>
          <FormattedMessage id="canvas.credits.usage" />
        </a>
      </div>
      <div className={canvas.cpBar}>
        <span style={{ flex: c.plan, background: '#F5F5F5' }} />
        <span style={{ flex: c.purchased, background: '#55555E' }} />
      </div>
      <div className={canvas.cpLines}>
        <div className={canvas.cpLine}>
          <span className={canvas.cpSwatch} style={{ background: '#F5F5F5' }} />
          <span className={canvas.cpName}>
            <FormattedMessage id="canvas.credits.plan" />
          </span>
          <span className={canvas.cpNum}>{intl.formatNumber(c.plan)}</span>
          <span className={canvas.cpNote}>
            <FormattedMessage id="canvas.credits.expires" values={{ date: c.planExpires }} />
          </span>
        </div>
        <div className={canvas.cpLine}>
          <span className={canvas.cpSwatch} style={{ background: '#55555E' }} />
          <span className={canvas.cpName}>
            <FormattedMessage id="canvas.credits.purchased" />
          </span>
          <span className={canvas.cpNum}>{intl.formatNumber(c.purchased)}</span>
          <span className={canvas.cpNote}>
            <FormattedMessage id="canvas.credits.neverExpire" />
          </span>
        </div>
      </div>
      <div className={canvas.cpRule} />
      <div className={canvas.cpStats}>
        {(
          [
            ['used', c.usedThisMonth],
            ['held', c.held],
            ['expiring', c.expiringThisMonth],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className={canvas.cpStat}>
            <span>
              <FormattedMessage id={`canvas.credits.${k}`} />
            </span>
            <span className={canvas.cpNum}>{intl.formatNumber(v)}</span>
          </div>
        ))}
      </div>
      <div className={canvas.cpRule} />
      <div className={canvas.cpTopUp}>
        <span className={canvas.cpLabel}>
          <FormattedMessage id="canvas.credits.topUp" />
        </span>
        <div className={canvas.cpPacks}>
          {c.packs.map((n) => (
            <button key={n} type="button" aria-pressed={pack === n} className={canvas.cpPack} onClick={() => setPack(n)}>
              <span className={canvas.cpPackN}>{intl.formatNumber(n)}</span>
              <span className={canvas.cpPackPrice}>
                <FormattedMessage id="canvas.credits.price" />
              </span>
            </button>
          ))}
        </div>
        <button type="button" className={cx(canvas.cpBuy, 'rl-press')}>
          <FormattedMessage id="canvas.credits.topUpAction" values={{ n: pack }} />
        </button>
        <span className={canvas.cpFoot}>
          <FormattedMessage id="canvas.credits.note" />
        </span>
      </div>
    </div>
  );
}

/* ---------- Run history drawer ---------- */

export interface HistoryRow {
  id: string;
  title: string;
  model: string;
  credits: number;
  status: 'running' | 'done' | 'failed';
  progress?: number;
  refunded?: number;
  at: Date;
}

export function HistoryDrawer({ state, onClose, rows }: LayerProps & { rows: HistoryRow[] }) {
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
      <div className={canvas.historyList} role="list">
        {rows.length === 0 ? <span className={canvas.historyMeta}><FormattedMessage id="canvas.history.empty" /></span> : null}
        {rows.map((r, i) => (
          <div key={r.id} role="listitem" className={cx(canvas.historyRow, 'rl-stagger')} style={staggerStyle(i)} data-motion="">
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
          </div>
        ))}
      </div>
    </section>
  );
}

export { MOCK_RUNS };
