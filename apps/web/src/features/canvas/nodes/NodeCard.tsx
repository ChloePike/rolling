import { cx, motionSafe } from '@rolling/ui';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { createContext, memo, useContext, type CSSProperties, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { hasInputs, outputType } from '@rolling/core/graph';
import type { GraphNode } from '@rolling/core/graph';
import { CanvasIcon } from '../icons';
import styles from './nodes.module.css';

export interface CardData extends Record<string, unknown> {
  node: GraphNode;
  /** Position in the latest build batch (agent build / add), or -1. */
  buildIndex: number;
  /** The node's input port was just refused while connecting. */
  refused: boolean;
}

export type CardNode = Node<CardData, 'card'>;

export interface NodeActions {
  openScript: (nodeId: string) => void;
  retry: (nodeId: string) => void;
  generateStoryboard: (nodeId: string) => void;
}

export const NodeActionsContext = createContext<NodeActions>({
  openScript: () => {},
  retry: () => {},
  generateStoryboard: () => {},
});

/** Card width per kind (Canvas.dc.html). */
export const NODE_WIDTH: Record<GraphNode['kind'], number> = {
  script: 300,
  text: 240,
  asset: 204,
  audio: 204,
  image: 240,
  video: 300,
  render: 300,
};

/** Input port offset from the top of the body, and output port offset from the top of the node. */
const PORT_TOP: Record<GraphNode['kind'], { in: number; out: number; outFromBody?: boolean }> = {
  script: { in: 100, out: 100 },
  text: { in: 40, out: 40, outFromBody: true },
  asset: { in: 110, out: 110 },
  audio: { in: 62, out: 62 },
  image: { in: 110, out: 110, outFromBody: true },
  video: { in: 78, out: 78, outFromBody: true },
  render: { in: 78, out: 78, outFromBody: true },
};

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Credits the next run costs: the quote, or the node's own estimate for new nodes. */
export function runCost(node: GraphNode): number | undefined {
  return node.cost ?? (typeof node.params.runCost === 'number' ? node.params.runCost : undefined);
}

/** The cost chip shows only when the node will run (handoff 3). */
export function willRun(node: GraphNode): boolean {
  return runCost(node) !== undefined && node.status !== 'done';
}

function Status({ node }: { node: GraphNode }) {
  if (node.status === 'idle' || node.status === 'done') return null;
  return (
    <span key={node.status} className={cx(styles.status, styles.statusIn)} data-status={node.status} {...motionSafe}>
      <FormattedMessage id={`canvas.node.status.${node.status}`} />
    </span>
  );
}

function Cost({ node }: { node: GraphNode }) {
  const intl = useIntl();
  if (!willRun(node)) return null;
  return (
    <span
      className={styles.cost}
      title={intl.formatMessage({ id: 'canvas.node.cost' })}
      aria-label={intl.formatMessage({ id: 'canvas.node.costLabel' }, { n: runCost(node) })}
    >
      {intl.formatNumber(runCost(node)!)}
    </span>
  );
}

function Label({ node }: { node: GraphNode }) {
  const intl = useIntl();
  return (
    <span>
      <span className={styles.kind}>{intl.formatMessage({ id: `canvas.node.kind.${node.kind}` })}</span>
      {' · '}
      {node.title}
    </span>
  );
}

function Port({ type, node, active, refused, top }: { type: 'in' | 'out'; node: GraphNode; active: boolean; refused?: boolean; top: number }) {
  const intl = useIntl();
  const hidden = type === 'out' && (node.kind === 'video' || node.kind === 'render');
  return (
    <Handle
      type={type === 'in' ? 'target' : 'source'}
      id={type}
      position={type === 'in' ? Position.Left : Position.Right}
      className={cx(
        styles.port,
        type === 'in' ? styles.portIn : styles.portOut,
        active && styles.portActive,
        refused && styles.portRefused,
        hidden && styles.portHidden,
      )}
      style={{ top }}
      aria-label={intl.formatMessage({ id: type === 'in' ? 'canvas.port.in' : 'canvas.port.out' }, { title: node.title })}
      data-port={type}
    />
  );
}

/** Done image/video body: the result (tone stands in for the thumbnail). */
function Result({ node, reveal }: { node: GraphNode; reveal: boolean }) {
  const intl = useIntl();
  const tone = str(node.params.tone, 'var(--c-tone-indigo)');
  if (node.kind === 'image') {
    return (
      <div className={cx(styles.reveal, reveal && 'rl-reveal')} style={{ background: tone }} {...motionSafe}>
        {node.version ? (
          <span className={styles.versionChip}>
            <FormattedMessage id="canvas.node.version" values={{ n: node.version.n, total: node.version.total }} />
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div className={cx(styles.reveal, reveal && 'rl-reveal')} style={{ background: tone }} {...motionSafe}>
      <span className={styles.playDisc} role="img" aria-label={intl.formatMessage({ id: 'canvas.node.play' })}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--c-text-1)" aria-hidden="true">
          <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" />
        </svg>
      </span>
      <span className={styles.duration}>{clock(num(node.params.seconds, 5))}</span>
    </div>
  );
}

function GenerativeBody({ node, height, selected, refused }: { node: GraphNode; height: number; selected: boolean; refused: boolean }) {
  const actions = useContext(NodeActionsContext);
  const intl = useIntl();
  const top = PORT_TOP[node.kind];
  const ports = (
    <>
      {hasInputs(node) ? <Port type="in" node={node} active={selected} refused={refused} top={top.in} /> : null}
      {outputType(node) ? <Port type="out" node={node} active={false} top={top.out} /> : null}
    </>
  );
  let content: ReactNode;
  let bodyClass = styles.media;
  if (node.status === 'generating' || node.status === 'queued') {
    const p = node.progress ?? 0;
    bodyClass = cx(styles.progressBody);
    content = (
      <>
        <div className={styles.progressFill} style={{ width: `${Math.round(p * 100)}%` }} />
        <span className={styles.progressLabel}>{intl.formatNumber(p, { style: 'percent' })}</span>
      </>
    );
  } else if (node.status === 'failed') {
    bodyClass = styles.failedBody;
    content = (
      <>
        <span className={styles.failedTitle}>
          <FormattedMessage id="canvas.node.failedTitle" />
        </span>
        <span className={styles.failedNote}>
          <FormattedMessage id="canvas.node.refunded" values={{ n: node.refunded ?? 0 }} />
        </span>
        <button type="button" className={cx(styles.retry, 'nodrag')} onClick={() => actions.retry(node.id)}>
          <CanvasIcon name="retry" size={13} />
          <FormattedMessage id="canvas.node.retry" />
        </button>
      </>
    );
  } else if (node.version) {
    // done or outdated: show the active version; reveal plays when it just finished.
    content = <Result node={node} reveal={node.status === 'done' && node.progress === 1} />;
  } else {
    bodyClass = cx(styles.media, styles.emptyBody);
    content = <FormattedMessage id="canvas.node.notGenerated" />;
  }
  return (
    <div className={cx(styles.body, bodyClass)} style={{ height }} data-body="">
      {content}
      {ports}
    </div>
  );
}

function CardContent({ node, selected, refused }: { node: GraphNode; selected: boolean; refused: boolean }) {
  const intl = useIntl();
  const actions = useContext(NodeActionsContext);
  const top = PORT_TOP[node.kind];
  switch (node.kind) {
    case 'script': {
      const rows = (Array.isArray(node.params.rows) ? node.params.rows : []) as Array<{ n: string; visual: string; seconds: number }>;
      return (
        <>
          <div className={styles.head}>
            <CanvasIcon name="doc" size={14} />
            <span className={styles.kind}>{intl.formatMessage({ id: 'canvas.node.kind.script' })}</span>
            <span>{str(node.params.versionLabel)}</span>
            <span className={styles.spacer} />
            <button
              type="button"
              className={cx(styles.iconBtn, 'nodrag')}
              aria-label={intl.formatMessage({ id: 'canvas.node.fullScreen' })}
              onClick={() => actions.openScript(node.id)}
            >
              <CanvasIcon name="fullscreen" size={14} />
            </button>
          </div>
          <div className={cx(styles.table, styles.body)} data-body="">
            <div className={styles.rowHead}>
              <span className={styles.check} />
              <span>{intl.formatMessage({ id: 'canvas.node.script.head.number' })}</span>
              <span>{intl.formatMessage({ id: 'canvas.node.script.head.visual' })}</span>
              <span>{intl.formatMessage({ id: 'canvas.node.script.head.duration' })}</span>
            </div>
            {rows.map((r) => (
              <div key={r.n} className={styles.row}>
                <span className={styles.checkOn} />
                <span>{r.n}</span>
                <span>{r.visual}</span>
                <span>{intl.formatMessage({ id: 'canvas.node.seconds' }, { n: r.seconds })}</span>
              </div>
            ))}
            <div className={styles.tableActions}>
              <button type="button" className={cx(styles.pillBtn, 'nodrag')} onClick={() => actions.generateStoryboard(node.id)}>
                {intl.formatMessage({ id: 'canvas.node.script.generate' }, { n: rows.length })}
              </button>
              <button type="button" className={cx(styles.ghostBtn, 'nodrag')}>
                {intl.formatMessage({ id: 'canvas.node.script.fields' })}
              </button>
            </div>
          </div>
          <Port type="out" node={node} active={false} top={top.out} />
        </>
      );
    }
    case 'asset': {
      return (
        <>
          <div className={styles.headBlock}>
            <Label node={node} />
          </div>
          <div className={cx(styles.body, styles.assetBody)} style={{ height: 184, background: str(node.params.tone, 'var(--c-tone-teal)') }} data-body="">
            {str(node.params.label)}
          </div>
          <Port type="out" node={node} active={false} top={top.out} />
        </>
      );
    }
    case 'audio': {
      const wave = (Array.isArray(node.params.wave) ? node.params.wave : []) as number[];
      return (
        <>
          <div className={styles.head}>
            <Label node={node} />
            <span className={styles.spacer} />
            <Status node={node} />
            <Cost node={node} />
          </div>
          <div className={cx(styles.body, styles.audioBody)} data-body="">
            <div className={styles.wave} aria-hidden="true">
              {wave.map((h, i) => (
                <span key={i} className={styles.waveBar} style={{ height: h }} />
              ))}
            </div>
            <div className={styles.audioMeta}>
              <span>{clock(num(node.params.seconds))}</span>
              <span>{str(node.params.voice)}</span>
            </div>
          </div>
          <Port type="out" node={node} active={false} top={top.out} />
        </>
      );
    }
    case 'text': {
      return (
        <>
          <div className={styles.head}>
            <CanvasIcon name="doc" size={14} />
            <Label node={node} />
          </div>
          <div className={cx(styles.body, styles.textBody)} data-body="">
            {str(node.params.text)}
            <Port type="out" node={node} active={false} top={top.out} />
          </div>
        </>
      );
    }
    case 'image':
      return (
        <>
          <div className={styles.head}>
            <Label node={node} />
            <span className={styles.spacer} />
            <Status node={node} />
            <Cost node={node} />
          </div>
          <GenerativeBody node={node} height={240} selected={selected} refused={refused} />
        </>
      );
    default:
      return (
        <>
          <div className={styles.headTight}>
            <Label node={node} />
            <span className={styles.spacer} />
            <Status node={node} />
            <Cost node={node} />
          </div>
          <GenerativeBody node={node} height={170} selected={selected} refused={refused} />
        </>
      );
  }
}

function NodeCardImpl({ data, selected }: NodeProps<CardNode>) {
  const { node, buildIndex, refused } = data;
  const building = buildIndex >= 0;
  return (
    <div
      className={cx(styles.node, selected && styles.selected, building && cx(styles.build, 'rl-build'))}
      style={building ? ({ width: NODE_WIDTH[node.kind], '--rl-i': buildIndex } as CSSProperties) : { width: NODE_WIDTH[node.kind] }}
      data-node-kind={node.kind}
      data-status={node.status}
      data-testid={`node-${node.id}`}
      {...(building ? motionSafe : {})}
    >
      <CardContent node={node} selected={!!selected} refused={refused} />
    </div>
  );
}

export const NodeCard = memo(NodeCardImpl);
