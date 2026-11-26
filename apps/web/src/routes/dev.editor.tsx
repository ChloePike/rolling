import { createFileRoute } from '@tanstack/react-router';
import { Editor } from '@/features/canvas/editor';
import { isMockApi, mockData } from '@/lib/api/mode';
import { NotFound } from '@/pages/NotFound';

interface EditorSearch {
  /** `agent` opens with the “cut to 10s” proposal (CanvasEditAgent.dc.html). */
  state?: 'agent';
}

/** Dev-only (mock builds): the editor full screen, as the canvas mounts it. */
export const Route = createFileRoute('/dev/editor')({
  validateSearch: (search: Record<string, unknown>): EditorSearch => (search.state === 'agent' ? { state: 'agent' } : {}),
  component: DevEditor,
});

function DevEditor() {
  const { state } = Route.useSearch();
  // Mock builds only (the design's editor project).
  if (!isMockApi()) return <NotFound />;
  return (
    <div style={{ position: 'relative', height: '100vh', minHeight: 860, background: 'var(--c-bg)' }}>
      <Editor key={state ?? 'edit'} projectId={mockData().canvas.MOCK_PROJECT_ID} initialAsk={state === 'agent' ? 'cut to 10s' : undefined} />
    </div>
  );
}
