import { useEffect, useRef } from 'react';
import { useReactFlow, useViewport } from '@xyflow/react';
import { useIntl } from 'react-intl';
import type { PresenceEntry, ThreadView } from '@rolling/core/collab';
import type { PresenceClient } from './presence';
import styles from './collab.module.css';

export interface LayerNodeBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Drawn inside <ReactFlow> (D-031): other people's cursors with their name,
 * an outline on what they selected, comment pins (canvas points and nodes),
 * and the "click to pin a comment" mode. Tracks this tab's pointer in flow
 * coordinates for the presence client. Cursors glide with a short linear
 * transition; under reduced motion they jump (collab.module.css).
 */
export function CanvasCollabLayer({
  client,
  entries,
  nodes,
  threads,
  placing,
  onPlace,
  onOpenThread,
}: {
  client: PresenceClient;
  entries: readonly PresenceEntry[];
  nodes: readonly LayerNodeBox[];
  threads: readonly ThreadView[];
  placing: boolean;
  onPlace: (at: { x: number; y: number }) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const intl = useIntl();
  const flow = useReactFlow();
  const vp = useViewport();
  const probe = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = probe.current?.closest('.react-flow');
    if (!(root instanceof HTMLElement)) return;
    const move = (e: PointerEvent) => client.setCursor(flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false }));
    const leave = () => client.setCursor(null);
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerleave', leave);
    return () => {
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerleave', leave);
    };
  }, [client, flow]);

  const toScreen = (x: number, y: number) => ({ left: vp.x + x * vp.zoom, top: vp.y + y * vp.zoom });
  const box = new Map(nodes.map((n) => [n.id, n]));
  const open = threads.filter((t) => t.status === 'open');
  const nodeCounts = new Map<string, { n: number; first: string; unread: boolean }>();
  for (const t of open) {
    if (t.anchor.kind !== 'node' && t.anchor.kind !== 'version') continue;
    const c = nodeCounts.get(t.anchor.nodeId) ?? { n: 0, first: t.id, unread: false };
    nodeCounts.set(t.anchor.nodeId, { n: c.n + 1, first: c.first, unread: c.unread || t.unread });
  }

  return (
    <div className={styles.layer} data-testid="collab-layer">
      <span ref={probe} hidden />
      {entries.flatMap((e) =>
        e.selection.map((id) => {
          const b = box.get(id);
          if (!b) return null;
          const p = toScreen(b.x, b.y);
          return (
            <div key={`${e.id}:${id}`} className={styles.remoteSelection} data-testid="remote-selection" data-node={id} style={{ ...p, width: b.w * vp.zoom, height: b.h * vp.zoom }}>
              <span className={styles.remoteSelectionName}>{e.name}</span>
            </div>
          );
        }),
      )}
      {[...nodeCounts].map(([nodeId, c]) => {
        const b = box.get(nodeId);
        if (!b) return null;
        const p = toScreen(b.x + b.w, b.y);
        return (
          <button
            key={`pin-node-${nodeId}`}
            type="button"
            className={styles.nodeBadge}
            data-unread={c.unread || undefined}
            data-testid={`comment-badge-${nodeId}`}
            style={{ left: p.left - 10, top: p.top - 10 }}
            aria-label={intl.formatMessage({ id: 'collab.pin.node' }, { n: c.n })}
            onClick={() => onOpenThread(c.first)}
          >
            {intl.formatNumber(c.n)}
          </button>
        );
      })}
      {open.map((t) => {
        if (t.anchor.kind !== 'canvas') return null;
        const p = toScreen(t.anchor.x, t.anchor.y);
        return (
          <button
            key={t.id}
            type="button"
            className={styles.pin}
            data-unread={t.unread || undefined}
            data-testid="comment-pin"
            style={{ left: p.left, top: p.top }}
            aria-label={intl.formatMessage({ id: 'collab.pin.open' }, { name: t.createdBy.name })}
            onClick={() => onOpenThread(t.id)}
          >
            <PinIcon />
          </button>
        );
      })}
      {entries.map((e) =>
        e.cursor ? (
          <div
            key={e.id}
            className={styles.cursor}
            data-testid="remote-cursor"
            data-user={e.userId}
            style={{ transform: `translate(${vp.x + e.cursor.x * vp.zoom}px, ${vp.y + e.cursor.y * vp.zoom}px)` }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className={styles.cursorArrow}>
              <path d="M1 1l5.5 13 1.9-5.6L14 6.5z" />
            </svg>
            <span className={styles.cursorName}>{e.name}</span>
          </div>
        ) : null,
      )}
      {placing ? (
        <div
          className={styles.placing}
          data-testid="comment-placing"
          role="button"
          tabIndex={0}
          aria-label={intl.formatMessage({ id: 'collab.pin.place' })}
          onClick={(e) => {
            e.stopPropagation();
            onPlace(flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false }));
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onPlace(flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, { snapToGrid: false }));
          }}
        />
      ) : null}
    </div>
  );
}

export function PinIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
