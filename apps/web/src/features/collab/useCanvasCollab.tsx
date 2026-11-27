import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePresence } from '@rolling/ui';
import type { ProjectSession } from '@/features/canvas/api';
import type { CardNode } from '@/features/canvas/nodes/NodeCard';
import { useSession } from '@/lib/session';
import { isMockApi } from '@/features/overlays/backend';
import { mockData } from '@/lib/api/mode';
import { useComments } from './api';
import { CanvasCollabLayer, type LayerNodeBox } from './CanvasCollabLayer';
import { CollabBar } from './CollabBar';
import { CollabPanel, type CollabTab } from './CollabPanel';
import { useProjectPresence } from './presence';

/**
 * Everything collaboration adds to the canvas (D-031), so the canvas page
 * places three slots: `bar` (top right: avatars, Comments), `layer` (a child
 * of <ReactFlow>: cursors, selections, pins) and `panel` (the side panel).
 * `?thread=<id>` and `?review=<id>` (notification links) open the panel there.
 */
export function useCanvasCollab(input: {
  projectId: string;
  session: ProjectSession;
  rfNodes: readonly CardNode[];
  selected: string | null;
  onShowNode: (nodeId: string) => void;
}): { bar: ReactNode; layer: ReactNode; panel: ReactNode } {
  const { projectId, session, rfNodes, selected, onShowNode } = input;
  const auth = useSession();
  // Mock mode: the mock collaboration store's own user (its threads say who wrote them).
  const me = isMockApi() ? mockData().collab.MOCK_ME : (auth.user?.id ?? null);
  const selection = useMemo(() => {
    const ids = rfNodes.filter((n) => n.selected).map((n) => n.id);
    return ids.length ? ids : selected ? [selected] : [];
  }, [rfNodes, selected]);
  const { client, entries } = useProjectPresence(projectId, session.send, selection);
  const comments = useComments(projectId, me);
  const initial = useMemo(() => {
    const q = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
    return { thread: q.get('thread'), review: q.get('review') };
  }, []);
  const [open, setOpen] = useState(!!(initial.thread || initial.review));
  const [tab, setTab] = useState<CollabTab>(initial.review ? 'reviews' : 'comments');
  const [focus, setFocus] = useState<string | null>(initial.thread);
  const [placing, setPlacing] = useState(false);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const panelP = usePresence(open);
  useEffect(() => {
    if (!placing) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setPlacing(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [placing]);

  const boxes: LayerNodeBox[] = useMemo(
    () => rfNodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, w: n.measured?.width ?? n.width ?? 240, h: n.measured?.height ?? 200 })),
    [rfNodes],
  );
  const nodeTitle = useCallback((id: string) => session.store.getState().nodes.find((n) => n.id === id)?.title ?? null, [session]);
  const activeVersion = useCallback((id: string) => session.sync.getMedia(id)?.versionId ?? null, [session]);
  const openThread = useCallback((id: string) => {
    setTab('comments');
    setFocus(id);
    setOpen(true);
  }, []);
  const role: 'owner' | 'editor' | 'viewer' = !session.sync.canEdit ? 'viewer' : auth.role === 'owner' ? 'owner' : 'editor';
  const canvasId = session.canvasId() ?? `cnv_${projectId.replace(/^prj_/, '')}`;

  return {
    bar: <CollabBar entries={entries} unread={comments.data?.unread ?? 0} open={open} onToggle={() => setOpen((o) => !o)} />,
    layer: (
      <CanvasCollabLayer
        client={client}
        entries={entries}
        nodes={boxes}
        threads={comments.data?.threads ?? []}
        placing={placing}
        onPlace={(at) => {
          setPlacing(false);
          setPoint(at);
          setTab('comments');
          setOpen(true);
        }}
        onOpenThread={openThread}
      />
    ),
    panel: panelP.mounted ? (
      <CollabPanel
        state={panelP.state}
        projectId={projectId}
        me={me}
        role={role}
        comments={comments.data}
        tab={tab}
        onTab={setTab}
        focusThread={focus}
        onFocusThread={setFocus}
        selection={selection}
        nodeTitle={nodeTitle}
        activeVersion={activeVersion}
        canvasId={canvasId}
        pendingPoint={point}
        onPickPoint={() => setPlacing(true)}
        onClearPoint={() => setPoint(null)}
        onShowNode={onShowNode}
        onClose={() => {
          setOpen(false);
          setPlacing(false);
        }}
      />
    ) : null,
  };
}
