import { createFileRoute } from '@tanstack/react-router';
import { CANVAS_OVERLAYS, CanvasError, CanvasPage, type CanvasOverlay } from '@/features/canvas';
import { Editor } from '@/features/canvas/editor';
import { NODE } from '@/features/canvas/mocks';
import { isMockApi } from '@/features/overlays/backend';

const EDITOR_TO_CANVAS: Record<string, string> = { node_shot_a: NODE.shotA, node_shot_b: NODE.shotB };

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
  errorComponent: CanvasError,
});

function CanvasRoute() {
  const { projectId } = Route.useParams();
  const { overlay } = Route.useSearch();
  return (
    <CanvasPage
      key={projectId}
      projectId={projectId}
      initialOverlay={overlay ?? null}
      initialSelection={isMockApi() ? NODE.shotA : null}
      renderEditor={({ projectId: id, withProposal, onClose, onOpenOnCanvas }) => (
        <Editor
          projectId={id}
          initialAsk={withProposal && isMockApi() ? 'cut to 10s' : undefined}
          onClose={onClose}
          // The editor mock names shots by its own node ids; map them to the canvas mock's.
          onOpenOnCanvas={(nodeId) => onOpenOnCanvas(isMockApi() ? (EDITOR_TO_CANVAS[nodeId] ?? nodeId) : nodeId)}
        />
      )}
    />
  );
}
