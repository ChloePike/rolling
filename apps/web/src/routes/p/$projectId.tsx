import { createFileRoute } from '@tanstack/react-router';
import { CANVAS_OVERLAYS, CanvasError, CanvasPage, type CanvasOverlay } from '@/features/canvas';
import { Editor } from '@/features/canvas/editor';
import { mockData } from '@/lib/api/mode';
import { isMockApi } from '@/features/overlays/backend';

/** Mock mode: the editor mock names shots by its own node ids; these are the canvas mock's. */
const editorToCanvas = (): Record<string, string> => {
  const { NODE } = mockData().canvas;
  return { node_shot_a: NODE.shotA, node_shot_b: NODE.shotB };
};

interface CanvasSearch {
  /** Opens one layer on load, like the design's `initOverlay` (plan, addMenu, script, share, edit, editAgent, at). */
  overlay?: CanvasOverlay;
  /** One-time token of an item sent to this canvas (`features/canvas/target/incoming.ts`). */
  insert?: string;
}

/**
 * Canvas route. It renders outside the `_shell` layout: Canvas.dc.html has
 * its own floating top bar instead of the shared header.
 */
export const Route = createFileRoute('/p/$projectId')({
  validateSearch: (search: Record<string, unknown>): CanvasSearch => {
    const o = search.overlay;
    const insert = typeof search.insert === 'string' && /^[a-z0-9]{1,16}$/.test(search.insert) ? search.insert : undefined;
    return {
      ...(typeof o === 'string' && (CANVAS_OVERLAYS as readonly string[]).includes(o) ? { overlay: o as CanvasOverlay } : {}),
      ...(insert ? { insert } : {}),
    };
  },
  component: CanvasRoute,
  errorComponent: CanvasError,
});

function CanvasRoute() {
  const { projectId } = Route.useParams();
  const { overlay, insert } = Route.useSearch();
  return (
    <CanvasPage
      key={projectId}
      projectId={projectId}
      initialOverlay={overlay ?? null}
      incoming={insert ?? null}
      initialSelection={isMockApi() ? mockData().canvas.NODE.shotA : null}
      renderEditor={({ projectId: id, withProposal, onClose, onOpenOnCanvas }) => (
        <Editor
          projectId={id}
          initialAsk={withProposal && isMockApi() ? 'cut to 10s' : undefined}
          onClose={onClose}
          // The editor mock names shots by its own node ids; map them to the canvas mock's.
          onOpenOnCanvas={(nodeId) => onOpenOnCanvas(isMockApi() ? (editorToCanvas()[nodeId] ?? nodeId) : nodeId)}
        />
      )}
    />
  );
}
