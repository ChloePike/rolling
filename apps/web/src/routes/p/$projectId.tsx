import { createFileRoute } from '@tanstack/react-router';
import { CANVAS_OVERLAYS, CanvasPage, type CanvasOverlay } from '@/features/canvas';
import { Editor } from '@/features/canvas/editor';
import { NODE } from '@/features/canvas/mocks';

interface CanvasSearch {
  /** Opens one layer on load, like the design's `initOverlay` (plan, addMenu, script, share, edit, editAgent, at). */
  overlay?: CanvasOverlay;
}

/**
 * Canvas route. It renders outside the `_shell` layout: Canvas.dc.html has
 * its own floating top bar instead of the shared header.
 */
export const Route = createFileRoute('/p/$projectId')({
  validateSearch: (search: Record<string, unknown>): CanvasSearch => {
    const o = search.overlay;
    return typeof o === 'string' && (CANVAS_OVERLAYS as readonly string[]).includes(o) ? { overlay: o as CanvasOverlay } : {};
  },
  component: CanvasRoute,
});

function CanvasRoute() {
  const { projectId } = Route.useParams();
  const { overlay } = Route.useSearch();
  return (
    <CanvasPage
      key={projectId}
      projectId={projectId}
      initialOverlay={overlay ?? null}
      initialSelection={NODE.shotA}
      renderEditor={({ projectId: id, withProposal, onClose }) => (
        <Editor projectId={id} initialAsk={withProposal ? 'cut to 10s' : undefined} onClose={onClose} />
      )}
    />
  );
}
