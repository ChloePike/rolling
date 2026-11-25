import { useReactFlow, type ConnectionLineComponentProps, type Edge, type EdgeProps } from '@xyflow/react';
import { createContext, memo, useContext, useRef } from 'react';
import type { PortType, XY } from '@rolling/core/graph';
import styles from './wire.module.css';

export interface EdgeActions {
  moveReroute: (edgeId: string, index: number, position: XY) => void;
  removeReroute: (edgeId: string, index: number) => void;
  rerouteLabel: (index: number) => string;
}

export const EdgeActionsContext = createContext<EdgeActions>({ moveReroute: () => {}, removeReroute: () => {}, rerouteLabel: (i) => `Reroute ${i + 1}` });

export interface WireData extends Record<string, unknown> {
  /** Feeds the selected node. */
  highlight: boolean;
  /** Target is generating: data is flowing (dashed). */
  pending: boolean;
  /** Draw-in delay index when both ends were just built, or -1. */
  build: number;
  /** What flows along the wire (colors it). */
  type?: PortType | null;
  /** Reroute points in flow coordinates. */
  reroutes?: XY[];
}

export type WireEdge = Edge<WireData, 'wire'>;

/** Horizontal bezier like the hand-drawn edges in Canvas.dc.html. */
export function wirePath(sx: number, sy: number, tx: number, ty: number): string {
  const c = Math.max(24, Math.abs(tx - sx) / 2);
  return `M${sx} ${sy} C ${sx + c} ${sy}, ${tx - c} ${ty}, ${tx} ${ty}`;
}

/** Wire through reroute points: one bezier per segment. */
export function reroutedPath(sx: number, sy: number, tx: number, ty: number, points: readonly XY[] = []): string {
  const pts = [{ x: sx, y: sy }, ...points, { x: tx, y: ty }];
  return pts
    .slice(1)
    .map((p, i) => {
      const seg = wirePath(pts[i]!.x, pts[i]!.y, p.x, p.y);
      return i === 0 ? seg : seg.replace(/^M[^C]*/, ' ');
    })
    .join('')
    .replace(/ {2,}/g, ' ');
}

function Reroute({ edgeId, index, p }: { edgeId: string; index: number; p: XY }) {
  const actions = useContext(EdgeActionsContext);
  const flow = useReactFlow();
  const drag = useRef<{ id: number; moved: boolean } | null>(null);
  return (
    <circle
      cx={p.x}
      cy={p.y}
      r={6}
      className={styles.reroute}
      role="button"
      tabIndex={0}
      aria-label={actions.rerouteLabel(index)}
      data-testid={`reroute-${edgeId}-${index}`}
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, moved: false };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        drag.current.moved = true;
        const pos = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        (e.currentTarget as SVGCircleElement).setAttribute('cx', String(pos.x));
        (e.currentTarget as SVGCircleElement).setAttribute('cy', String(pos.y));
      }}
      onPointerUp={(e) => {
        if (drag.current?.moved) {
          const pos = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          actions.moveReroute(edgeId, index, { x: Math.round(pos.x), y: Math.round(pos.y) });
        }
        drag.current = null;
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        actions.removeReroute(edgeId, index);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          e.stopPropagation();
          actions.removeReroute(edgeId, index);
        }
      }}
    />
  );
}

function WireImpl({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<WireEdge>) {
  const points = data?.reroutes ?? [];
  const d = points.length ? reroutedPath(sourceX, sourceY, targetX, targetY, points) : wirePath(sourceX, sourceY, targetX, targetY);
  const build = data?.build ?? -1;
  return (
    <g
      data-testid={`edge-${id}`}
      data-highlight={data?.highlight ? '' : undefined}
      data-pending={data?.pending ? '' : undefined}
      data-type={data?.type ?? undefined}
      className={styles.typed}
    >
      <path d={d} className={styles.hit} />
      <path
        d={d}
        pathLength={build >= 0 ? 1 : undefined}
        className={`${styles.wire} ${data?.highlight ? styles.highlight : ''} ${data?.pending ? styles.pending : ''} ${build >= 0 ? styles.draw : ''}`}
        style={build >= 0 ? { animationDelay: `${build * 150 + 320}ms` } : undefined}
      />
      {points.map((p, i) => (
        <Reroute key={i} edgeId={id} index={i} p={p} />
      ))}
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
