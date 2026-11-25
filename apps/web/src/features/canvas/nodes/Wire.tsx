import type { ConnectionLineComponentProps, Edge, EdgeProps } from '@xyflow/react';
import { memo } from 'react';
import styles from './wire.module.css';

export interface WireData extends Record<string, unknown> {
  /** Feeds the selected node. */
  highlight: boolean;
  /** Target is generating: data is flowing (dashed). */
  pending: boolean;
  /** Draw-in delay index when both ends were just built, or -1. */
  build: number;
}

export type WireEdge = Edge<WireData, 'wire'>;

/** Horizontal bezier like the hand-drawn edges in Canvas.dc.html. */
export function wirePath(sx: number, sy: number, tx: number, ty: number): string {
  const c = Math.max(24, Math.abs(tx - sx) / 2);
  return `M${sx} ${sy} C ${sx + c} ${sy}, ${tx - c} ${ty}, ${tx} ${ty}`;
}

function WireImpl({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<WireEdge>) {
  const d = wirePath(sourceX, sourceY, targetX, targetY);
  const build = data?.build ?? -1;
  return (
    <g data-testid={`edge-${id}`} data-highlight={data?.highlight ? '' : undefined} data-pending={data?.pending ? '' : undefined}>
      <path d={d} className={styles.hit} />
      <path
        d={d}
        pathLength={build >= 0 ? 1 : undefined}
        className={`${styles.wire} ${data?.highlight ? styles.highlight : ''} ${data?.pending ? styles.pending : ''} ${build >= 0 ? styles.draw : ''}`}
        style={build >= 0 ? { animationDelay: `${build * 150 + 320}ms` } : undefined}
      />
    </g>
  );
}

export const Wire = memo(WireImpl);

/** The line that follows the pointer while connecting; red over a refused port. */
export function ConnectionLine({ fromX, fromY, toX, toY, connectionStatus }: ConnectionLineComponentProps) {
  return (
    <path
      d={wirePath(fromX, fromY, toX, toY)}
      className={`${styles.wire} ${connectionStatus === 'invalid' ? styles.invalid : styles.highlight}`}
      data-testid="connection-line"
      data-status={connectionStatus ?? 'none'}
    />
  );
}
