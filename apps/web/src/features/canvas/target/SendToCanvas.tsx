import { Dialog, cx, staggerStyle, useToast } from '@rolling/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { activeWorkspace, canvasesQuery, createCanvas } from './projects';
import { saveIncoming, type IncomingItem } from './incoming';
import styles from './target.module.css';

/** How many recent canvases the picker lists. */
const RECENT = 6;

export interface SendOptions {
  /** The project the item came from: it goes straight there, no picker. */
  projectId?: string | null;
}

export interface SendToCanvas {
  /** Sends `item` to its source project, or opens "Choose a canvas". */
  send: (item: IncomingItem, opts?: SendOptions) => void;
  /** Render once in the page. */
  dialog: ReactNode;
}

/**
 * "Send to canvas" / "Use in canvas" / "Edit in canvas" (Activity, Assets,
 * public library, tools). Lands on the canvas with the item added as an asset
 * node, selected and in view (`incoming.ts`).
 */
export function useSendToCanvas(): SendToCanvas {
  const navigate = useNavigate();
  const router = useRouter();
  // The next route is the canvas: fetch its chunk while the user picks or as the send starts.
  const preloadCanvas = () => {
    const canvas = router.routesById['/p/$projectId'];
    if (canvas) void Promise.resolve(router.loadRouteChunk(canvas)).catch(() => undefined);
  };
  const [pending, setPending] = useState<IncomingItem | null>(null);
  const go = (projectId: string, item: IncomingItem) => {
    const insert = saveIncoming(projectId, [item]);
    void navigate({ to: '/p/$projectId', params: { projectId }, search: { insert } });
  };
  return {
    send: (item, opts) => {
      preloadCanvas();
      if (opts?.projectId) go(opts.projectId, item);
      else setPending(item);
    },
    dialog: (
      <ChooseCanvasDialog
        item={pending}
        onClose={() => setPending(null)}
        onPick={(projectId) => {
          const item = pending;
          setPending(null);
          if (item) go(projectId, item);
        }}
      />
    ),
  };
}

/** "Choose a canvas": recent canvases of the workspace plus "New canvas". */
export function ChooseCanvasDialog({ item, onClose, onPick }: { item: IncomingItem | null; onClose: () => void; onPick: (projectId: string) => void }) {
  const intl = useIntl();
  const toast = useToast();
  const ws = activeWorkspace();
  const open = !!item;
  const q = useQuery({ ...canvasesQuery(ws), enabled: open });
  const [creating, setCreating] = useState(false);
  const rows = useRef<Array<HTMLButtonElement | null>>([]);
  // Keep the last item's name through the exit animation.
  const name = useRef('');
  if (item) name.current = item.name;

  const recent = (q.data ?? []).slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT);

  const createNew = () => {
    if (creating) return;
    setCreating(true);
    void createCanvas(intl.formatMessage({ id: 'home.project.untitled' })).then(
      (id) => {
        setCreating(false);
        onPick(id);
      },
      () => {
        setCreating(false);
        toast.show({ message: intl.formatMessage({ id: 'canvas.target.createFailed' }) });
      },
    );
  };

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const n = recent.length + 1;
    const next = e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (next === null) return;
    e.preventDefault();
    rows.current[next]?.focus();
  };

  const updated = (at: number) => intl.formatDate(at, { month: 'short', day: 'numeric' });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={<FormattedMessage id="canvas.target.title" />}
      description={<FormattedMessage id="canvas.target.description" values={{ name: name.current }} />}
      width={400}
    >
      <div role="list" aria-label={intl.formatMessage({ id: 'canvas.target.listLabel' })} className={styles.list} data-testid="choose-canvas">
        {q.isPending ? (
          <p className={styles.note}>
            <FormattedMessage id="canvas.target.loading" />
          </p>
        ) : q.isError ? (
          <p className={styles.note} role="alert">
            <FormattedMessage id="canvas.target.loadFailed" />
          </p>
        ) : null}
        {recent.map((p, i) => (
          <div role="listitem" key={p.id} style={{ display: 'contents' }}>
            <button
              ref={(el) => {
                rows.current[i] = el;
              }}
              type="button"
              className={cx('rl-stagger', styles.row)}
              style={staggerStyle(i)}
              data-project={p.id}
              onClick={() => onPick(p.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              <span className={styles.label}>{p.title || intl.formatMessage({ id: 'home.project.untitled' })}</span>
              <span className={styles.hint}>
                <FormattedMessage id="canvas.target.updated" values={{ date: updated(p.updatedAt) }} />
              </span>
            </button>
          </div>
        ))}
        <div role="listitem" style={{ display: 'contents' }}>
          <button
            ref={(el) => {
              rows.current[recent.length] = el;
            }}
            type="button"
            className={cx('rl-stagger', styles.row)}
            style={staggerStyle(recent.length)}
            aria-disabled={creating || undefined}
            data-testid="choose-canvas-new"
            onClick={createNew}
            onKeyDown={(e) => onKeyDown(e, recent.length)}
          >
            <span className={styles.icon} aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
            <span className={styles.label}>
              <FormattedMessage id={creating ? 'canvas.target.creating' : 'canvas.target.new'} />
            </span>
          </button>
        </div>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.cancel} onClick={onClose}>
          <FormattedMessage id="canvas.target.cancel" />
        </button>
      </div>
    </Dialog>
  );
}
