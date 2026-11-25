import { createFileRoute } from '@tanstack/react-router';
import { Editor } from '@/features/canvas/editor';

interface EditorSearch {
  /** `agent` opens with the “cut to 10s” proposal (CanvasEditAgent.dc.html). */
  state?: 'agent';
}

/** Dev-only: the editor full screen, as the canvas mounts it. */
export const Route = createFileRoute('/dev/editor')({
  validateSearch: (search: Record<string, unknown>): EditorSearch => (search.state === 'agent' ? { state: 'agent' } : {}),
  component: DevEditor,
});

function DevEditor() {
  const { state } = Route.useSearch();
  return (
    <div style={{ position: 'relative', height: '100vh', minHeight: 860, background: 'var(--c-bg)' }}>
      <Editor key={state ?? 'edit'} projectId="prj_demo" initialAsk={state === 'agent' ? 'cut to 10s' : undefined} />
    </div>
  );
}
