import { cx, presenceProps, usePresence, useToast } from '@rolling/ui';
import { Link } from '@tanstack/react-router';
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type EdgeChangeset,
  type FinalConnectionState,
  type NodeChangeset,
  type OnConnectEnd,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { ReferencePicker, type RefItem } from '../prompt';
import type { RunPlanRow, RunRowKind } from '../overlays';
import { AgentPanel, type AgentPlan } from './agent/AgentPanel';
import { getAccount, getProject, getShare, openProject, quoteRun, startRun, type ProjectSession } from './api';
import canvas from './canvas.module.css';
import type { LocalOp } from './graph/store';
import type { GraphNode, GraphState, NodeKind, Refusal } from './graph/types';
import { CanvasIcon, CanvasLogo, type CanvasIconName } from './icons';
import { AddNodeMenu, CreditsPopover, HistoryDrawer, MOCK_RUNS, PlanDialog, ScriptDialog, ShareDialog, type HistoryRow } from './layers/Layers';
import { MOCK_ACCOUNT, MOCK_CREDITS, type PromptRef } from './mocks';
import { NodeActionsContext, NodeCard, NODE_WIDTH, runCost, willRun, type CardNode, type NodeActions } from './nodes/NodeCard';
import styles from './nodes/nodes.module.css';
import { ConnectionLine, Wire, type WireEdge } from './nodes/Wire';
import { PromptPanel } from './prompt/PromptPanel';
import { CONFIRM_THRESHOLD, formatLabel, usePricedNodes } from './pricing';

/** Layers the design opens through `initOverlay` (Canvas.dc.html), plus the canvas' own. */
export type CanvasOverlay = 'plan' | 'addMenu' | 'script' | 'share' | 'edit' | 'editAgent' | 'at';
export const CANVAS_OVERLAYS: readonly CanvasOverlay[] = ['plan', 'addMenu', 'script', 'share', 'edit', 'editAgent', 'at'];

export interface CanvasEditorSlotProps {
  projectId: string;
  /** Opened with the agent's edit proposal (CanvasEditAgent). */
  withProposal: boolean;
  onClose: () => void;
}

export interface CanvasPageProps {
  projectId: string;
  initialOverlay?: CanvasOverlay | null;
  /** Node selected when the canvas opens (restored per user). */
  initialSelection?: string | null;
  /** The timeline editor (owned by `features/canvas/editor`) rendered over the canvas. */
  renderEditor?: (props: CanvasEditorSlotProps) => ReactNode;
}

type Tool = 'add' | 'asset' | 'flow' | 'dir' | 'cut' | 'hist';
const TOOLS: Array<{ key: Tool; icon: CanvasIconName; label: string }> = [
  { key: 'add', icon: 'plus', label: 'canvas.tools.add' },
  { key: 'asset', icon: 'image', label: 'canvas.tools.assets' },
  { key: 'flow', icon: 'flow', label: 'canvas.tools.flow' },
  { key: 'dir', icon: 'director', label: 'canvas.tools.director' },
  { key: 'cut', icon: 'cut', label: 'canvas.tools.edit' },
  { key: 'hist', icon: 'history', label: 'canvas.tools.history' },
];

/** Default drop point of the add menu when opened from the tool rail (Canvas.dc.html). */
const ADD_AT = { x: 360, y: 500 };
/** Right inset of the top-right cluster: clear of the 340px agent panel, or 16px. */
const AGENT_INSET = 368;
/** Gap between a node and its prompt editor (Canvas.dc.html genY). */
const PROMPT_GAP = { image: 10, video: 6 };
const nodeTypes = { card: NodeCard };
const edgeTypes = { wire: Wire };

function useGraph(session: ProjectSession): GraphState {
  return useSyncExternalStore(session.store.subscribe, session.store.getState);
}

function runKind(kind: NodeKind): RunRowKind {
  if (kind === 'video' || kind === 'render') return 'video';
  if (kind === 'audio') return 'audio';
  if (kind === 'image' || kind === 'asset') return 'image';
  return 'text';
}

export function CanvasPage(props: CanvasPageProps) {
  const toast = useToast();
  const intl = useIntl();
  const [session, setSession] = useState<ProjectSession | null>(null);
  const titles = useRef(new Map<string, string>());
  const retryRef = useRef<(id: string) => void>(() => {});

  useEffect(() => {
    const s = openProject(props.projectId, {
      onRefused: (r) => toast.show({ message: refusalText(intl, r) }),
      onJobFailed: (nodeId, refunded) =>
        toast.show({
          message: intl.formatMessage({ id: 'canvas.toast.failed' }, { title: titles.current.get(nodeId) ?? '', n: refunded }),
          action: { label: intl.formatMessage({ id: 'canvas.toast.retry' }), onAction: () => retryRef.current(nodeId) },
        }),
    });
    setSession(s);
    return () => s.dispose();
    // The session lives as long as the project is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId]);

  return (
    <div className={canvas.root} data-testid="canvas">
      <h1 className="rl-visually-hidden">
        <FormattedMessage id="canvas.pageTitle" />
      </h1>
      {session ? (
        <ReactFlowProvider>
          <CanvasInner {...props} session={session} titles={titles.current} retryRef={retryRef} />
        </ReactFlowProvider>
      ) : null}
    </div>
  );
}

function planMeta(intl: ReturnType<typeof useIntl>, n: GraphNode): string {
  const p = n.params;
  const parts: string[] = [];
  if (n.kind === 'script' || n.kind === 'text') return intl.formatMessage({ id: 'canvas.plan.meta.text' });
  if (n.kind === 'asset') return intl.formatMessage({ id: 'canvas.plan.meta.asset' });
  if (n.kind === 'audio') {
    return intl.formatMessage({ id: 'canvas.plan.meta.tts' }, { voice: String(p.voice ?? ''), seconds: Number(p.seconds ?? 0) });
  }
  if (typeof p.model === 'string') parts.push(p.model);
  if (typeof p.mode === 'string' && n.kind === 'video') parts.push(p.mode);
  const format = formatLabel(n);
  if (format) parts.push(format);
  if (n.status === 'done' && n.version) parts.push(intl.formatMessage({ id: 'canvas.plan.meta.current' }, { n: n.version.n }));
  if (n.status === 'outdated') parts.push(intl.formatMessage({ id: 'canvas.node.status.outdated' }));
  return parts.join(' · ');
}

export function refusalText(intl: ReturnType<typeof useIntl>, r: Refusal): string {
  switch (r.code) {
    case 'PORT_TYPE_MISMATCH':
      return intl.formatMessage({ id: 'canvas.refusal.PORT_TYPE_MISMATCH' }, { kind: r.data?.kind ?? 'other', type: r.data?.type ?? 'other' });
    case 'SELF_CONNECTION':
    case 'DUPLICATE_EDGE':
    case 'CYCLE':
    case 'PORT_FULL':
      return intl.formatMessage({ id: `canvas.refusal.${r.code}` });
    default:
      return intl.formatMessage({ id: 'canvas.refusal.other' }, { message: r.message });
  }
}

interface InnerProps extends CanvasPageProps {
  session: ProjectSession;
  titles: Map<string, string>;
  retryRef: { current: (id: string) => void };
}

function CanvasInner({ projectId, initialOverlay = null, initialSelection = null, renderEditor, session, titles, retryRef }: InnerProps) {
  const intl = useIntl();
  const toast = useToast();
  const flow = useReactFlow<CardNode, WireEdge>();
  const viewport = useViewport();
  const storeGraph = useGraph(session);
  const { nodes: pricedNodes, models } = usePricedNodes(storeGraph.nodes);
  const graph = useMemo(() => ({ ...storeGraph, nodes: pricedNodes }), [storeGraph, pricedNodes]);
  const syncStatus = useSyncExternalStore(session.sync.subscribe, session.sync.getStatus);
  const project = getProject(projectId);

  const [selected, setSelected] = useState<string | null>(initialSelection);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<CanvasOverlay | null>(initialOverlay);
  const [tool, setTool] = useState<Tool>('add');
  const [agentOpen, setAgentOpen] = useState(true);
  const [isMember, setIsMember] = useState(() => getAccount().isMember);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [addAt, setAddAt] = useState(ADD_AT);
  const [refused, setRefused] = useState<string | null>(null);
  const [extraRefs, setExtraRefs] = useState<Record<string, PromptRef[]>>({});
  const [sessionRuns, setSessionRuns] = useState<HistoryRow[]>([]);
  const [size, setSize] = useState({ w: typeof window === 'undefined' ? 1440 : window.innerWidth, h: 900 });
  const rootRef = useRef<HTMLDivElement>(null);

  for (const n of graph.nodes) titles.set(n.id, n.title);

  useEffect(() => {
    const el = rootRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------- xyflow nodes and edges, driven by the graph store ---------- */

  const [rfNodes, setRfNodes] = useState<CardNode[]>([]);
  const dragging = useRef(new Set<string>());

  useEffect(() => {
    setRfNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return graph.nodes.map((node) => {
        const old = byId.get(node.id);
        return {
          ...(old ?? {}),
          id: node.id,
          type: 'card' as const,
          position: old && dragging.current.has(node.id) ? old.position : node.position,
          width: NODE_WIDTH[node.kind],
          selected: node.id === selected,
          data: { node, buildIndex: session.store.buildIndex(node.id), refused: refused === node.id },
        };
      });
    });
  }, [graph, selected, refused, session]);

  const rfEdges = useMemo<WireEdge[]>(() => {
    const status = new Map(graph.nodes.map((n) => [n.id, n.status]));
    return graph.edges.map((e) => {
      const a = session.store.buildIndex(e.from.node);
      const b = session.store.buildIndex(e.to.node);
      return {
        id: e.id,
        type: 'wire' as const,
        source: e.from.node,
        target: e.to.node,
        sourceHandle: 'out',
        targetHandle: 'in',
        selected: e.id === selectedEdge,
        data: {
          highlight: e.to.node === selected,
          // Dashed: the frames a running job is rendering from.
          pending: status.get(e.to.node) === 'generating' && (e.to.port === 'frame' || e.to.port === 'refs' || e.to.port === 'clips'),
          build: a >= 0 && b >= 0 ? Math.max(a, b) : -1,
        },
      };
    });
  }, [graph, selected, selectedEdge, session]);

  const commit = useCallback(
    (ops: LocalOp[], options?: { actor?: 'user' | 'agent' }) => {
      const r = session.sync.commit(ops, options);
      if (!r.ok) toast.show({ message: refusalText(intl, r.refusal) });
      return r;
    },
    [session, toast, intl],
  );

  const onNodesChange = useCallback(
    (changes: NodeChangeset<CardNode>) => {
      const moved: LocalOp[] = [];
      for (const ch of changes) {
        if (ch.type === 'position') {
          if (ch.dragging) dragging.current.add(ch.id);
          else if (dragging.current.has(ch.id)) {
            dragging.current.delete(ch.id);
            const n = flow.getNode(ch.id);
            const pos = ch.position ?? n?.position;
            if (pos) moved.push({ op: 'moveNode', nodeId: ch.id, position: { x: Math.round(pos.x), y: Math.round(pos.y) } });
          }
        } else if (ch.type === 'select' && ch.selected) {
          setSelected(ch.id);
          setSelectedEdge(null);
        }
      }
      setRfNodes((prev) => changes.applyTo(prev).map((n) => ({ ...n, selected: n.selected })));
      if (moved.length) commit(moved);
    },
    [commit, flow],
  );

  const onEdgesChange = useCallback((changes: EdgeChangeset<WireEdge>) => {
    for (const ch of changes) {
      if (ch.type === 'select') setSelectedEdge(ch.selected ? ch.id : null);
    }
  }, []);

  const flashRefused = useCallback((nodeId: string, r: Refusal) => {
    setRefused(nodeId);
    window.setTimeout(() => setRefused((x) => (x === nodeId ? null : x)), 1200);
    toast.show({ message: refusalText(intl, r) });
  }, [toast, intl]);

  const onConnect = useCallback(
    (c: Connection) => {
      const plan = session.store.planConnect(c.source, c.target);
      if (!plan.ok) {
        flashRefused(c.target, plan.refusal);
        return;
      }
      commit([plan.op]);
    },
    [session, commit, flashRefused],
  );

  const isValidConnection = useCallback(
    (c: Connection | Edge) => session.store.planConnect(c.source, c.target).ok,
    [session],
  );

  const onConnectEnd: OnConnectEnd = useCallback(
    (_e: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid !== false || !state.toNode || !state.fromNode) return;
      const fromIsSource = state.fromHandle?.type === 'source';
      const source = fromIsSource ? state.fromNode.id : state.toNode.id;
      const target = fromIsSource ? state.toNode.id : state.fromNode.id;
      const plan = session.store.planConnect(source, target);
      if (!plan.ok) flashRefused(target, plan.refusal);
    },
    [session, flashRefused],
  );

  const onDelete = useCallback(
    ({ nodes, edges }: { nodes: CardNode[]; edges: WireEdge[] }) => {
      const removed = new Set(nodes.map((n) => n.id));
      const ops: LocalOp[] = [
        ...edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)).map((e) => ({ op: 'disconnect' as const, edgeId: e.id })),
        ...nodes.map((n) => ({ op: 'removeNode' as const, nodeId: n.id })),
      ];
      if (!ops.length) return;
      const r = commit(ops);
      if (r.ok && nodes.length) {
        if (selected && removed.has(selected)) setSelected(null);
        toast.show({
          message: intl.formatMessage({ id: 'canvas.toast.deleted' }, { n: nodes.length }),
          action: { label: intl.formatMessage({ id: 'canvas.toast.undo' }), onAction: () => session.sync.undo() },
        });
      }
    },
    [commit, selected, toast, intl, session],
  );

  /* ---------- Keyboard: undo / redo ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        session.sync.undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        session.sync.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  /* ---------- Runs ---------- */

  const selectedNode = graph.nodes.find((n) => n.id === selected) ?? null;

  const run = useCallback(
    (ids: string[]) => {
      const startable = ids.filter((id) => {
        const n = session.store.getState().nodes.find((x) => x.id === id);
        return n && n.status !== 'generating' && n.status !== 'queued';
      });
      if (!startable.length) return;
      startRun(startable);
      const now = new Date();
      setSessionRuns((rows) => [
        ...startable.map((id) => {
          const n = session.store.getState().nodes.find((x) => x.id === id)!;
          return { id: `run_${id}_${now.getTime()}`, title: n.title, model: typeof n.params.model === 'string' ? n.params.model : '', credits: runCost(n) ?? 0, status: 'running' as const, at: now, nodeId: id } as HistoryRow & { nodeId: string };
        }),
        ...rows,
      ]);
      toast.show({ message: intl.formatMessage({ id: 'canvas.toast.started' }, { n: startable.length }) });
    },
    [session, toast, intl],
  );
  retryRef.current = (id) => run([id]);

  const generate = useCallback(
    (id: string) => {
      const n = graph.nodes.find((x) => x.id === id);
      if (!n) return;
      // Runs under the user's "Confirm before running" threshold start without the quote dialog.
      if ((runCost(n) ?? 0) < CONFIRM_THRESHOLD) run([id]);
      else setOverlay('plan');
    },
    [graph.nodes, run],
  );

  const quote = useMemo(() => quoteRun(graph.nodes, graph.edges), [graph.nodes, graph.edges]);
  const runAllEstimate = graph.nodes.filter(willRun).reduce((s, n) => s + (runCost(n) ?? 0), 0);
  const planRows: RunPlanRow[] = useMemo(
    () =>
      quote.items.map((it) => {
        const n = graph.nodes.find((x) => x.id === it.nodeId)!;
        return {
          id: n.id,
          name: n.kind === 'script' ? `${intl.formatMessage({ id: 'canvas.node.kind.script' })} · ${String(n.params.versionLabel ?? '')}` : n.title,
          meta: planMeta(intl, n),
          kind: runKind(n.kind),
          state: it.action === 'none' ? 'free' : it.action === 'run' || n.status === 'generating' ? 'run' : it.action,
          cost: it.action === 'none' ? 0 : runCost(n) ?? 0,
          tone: typeof n.params.tone === 'string' ? n.params.tone : undefined,
        };
      }),
    [quote, graph.nodes, intl],
  );

  /* ---------- Agent: Build on canvas (a free graph patch from the plan proposal) ---------- */

  const buildPlan = useCallback(
    (plan: AgentPlan) => {
      const nodes = session.store.getState().nodes;
      const bottom = Math.max(0, ...nodes.map((n) => n.position.y + (n.kind === 'image' ? 263 : 193)));
      const y = bottom + 80;
      const ops: LocalOp[] = [];
      const ids: string[] = [];
      plan.shots.forEach((s, i) => {
        const key = `k${s.n}`;
        const shot = `v${s.n}`;
        ids.push(key, shot);
        ops.push(
          { op: 'addNode', tempId: key, kind: 'image', title: `${s.title} keyframe`, params: { tone: '#26232A', prompt: s.visual, model: 'Seedream 5.0 Pro', mode: 'Image to image', ratio: '9:16', resolution: '2K', count: 1, quick: ['Style', 'Framing', 'Lighting', 'Camera'], refs: ['m1'], runCost: 2 }, position: { x: 448 + i * 600, y } },
          { op: 'addNode', tempId: shot, kind: 'video', title: `Shot ${String.fromCharCode(65 + i)}: ${s.title}`, params: { tone: '#202330', seconds: s.seconds, prompt: s.visual, model: 'Seedance 2.5', mode: 'First frame', ratio: '9:16', resolution: '720p', length: s.seconds, extra: '×1 · Audio on', quick: ['Style', 'Camera', 'Lighting', 'Pace'], refs: [], runCost: 8 }, position: { x: 448 + i * 600 + 270, y } },
          { op: 'connect', from: { node: key, port: 'out' }, to: { node: shot, port: 'frame' } },
        );
      });
      ops.push({ op: 'group', nodeIds: ids, title: plan.title });
      // Applying a proposal is a normal patch by the user (harness §2); the agent only proposed it.
      const r = commit(ops);
      return r.ok ? ids.length : 0;
    },
    [session, commit],
  );

  /* ---------- Layout of the floating prompt editor ---------- */

  const visibleRight = size.w - (agentOpen ? AGENT_INSET : 16);
  const promptNode = selectedNode && (selectedNode.kind === 'image' || selectedNode.kind === 'video') ? selectedNode : null;
  const promptPos = useMemo(() => {
    if (!promptNode) return null;
    const rf = rfNodes.find((n) => n.id === promptNode.id);
    const pos = rf?.position ?? promptNode.position;
    const h = rf?.measured?.height ?? (promptNode.kind === 'image' ? 263 : 193);
    const x = viewport.x + pos.x * viewport.zoom;
    const y = viewport.y + (pos.y + h) * viewport.zoom + PROMPT_GAP[promptNode.kind === 'image' ? 'image' : 'video'];
    return { left: Math.round(Math.max(16, Math.min(x, visibleRight - 500))), top: Math.round(y) };
  }, [promptNode, rfNodes, viewport, visibleRight]);

  const lastPromptNode = useRef<GraphNode | null>(null);
  if (promptNode) lastPromptNode.current = promptNode;
  const lastPromptPos = useRef(promptPos);
  if (promptPos) lastPromptPos.current = promptPos;
  const promptPresence = usePresence(!!promptNode && overlay !== 'edit' && overlay !== 'editAgent');

  /* ---------- Overlays ---------- */

  const close = useCallback(() => setOverlay(null), []);
  const addP = usePresence(overlay === 'addMenu');
  const scriptP = usePresence(overlay === 'script');
  const shareP = usePresence(overlay === 'share');
  const planP = usePresence(overlay === 'plan');
  const atP = usePresence(overlay === 'at' && !!promptNode);
  const agentP = usePresence(agentOpen);
  const creditsP = usePresence(creditsOpen);
  const historyP = usePresence(historyOpen);
  const editorOpen = overlay === 'edit' || overlay === 'editAgent';

  const pickTool = (k: Tool) => {
    setTool(k);
    if (k === 'add') {
      setAddAt(ADD_AT);
      setOverlay((o) => (o === 'addMenu' ? null : 'addMenu'));
    } else if (k === 'cut') {
      setOverlay((o) => (o === 'edit' ? null : 'edit'));
    } else if (k === 'hist') {
      setHistoryOpen((h) => !h);
    } else if (k === 'asset' && promptNode) {
      setOverlay('at');
    }
  };

  const addNode = (kind: NodeKind) => {
    const pos = flow.screenToFlowPosition({ x: addAt.x, y: addAt.y });
    const tempId = 'new';
    const defaults: Record<string, Record<string, unknown>> = {
      text: { text: '' },
      script: { rows: [], versionLabel: 'v1' },
      image: { tone: '#26232A', prompt: '', model: 'Seedream 5.0 Pro', mode: 'Text to image', ratio: '9:16', resolution: '2K', count: 1, quick: ['Style', 'Framing', 'Lighting', 'Camera'], refs: [], runCost: 2 },
      video: { tone: '#202330', seconds: 5, prompt: '', model: 'Seedance 2.5', mode: 'First frame', ratio: '9:16', resolution: '720p', length: 5, extra: '×1 · Audio on', quick: ['Style', 'Camera', 'Lighting', 'Pace'], refs: [], runCost: 8 },
      audio: { voice: 'Clear female', seconds: 0, wave: [], runCost: 2 },
    };
    const r = commit([
      { op: 'addNode', tempId, kind, title: intl.formatMessage({ id: `canvas.add.newTitle.${kind}` }), params: defaults[kind] ?? {}, position: { x: Math.round(pos.x), y: Math.round(pos.y) } },
    ]);
    if (r.ok) setSelected(r.idMap[tempId] ?? null);
    setOverlay(null);
  };

  const actions: NodeActions = useMemo(
    () => ({
      openScript: () => setOverlay('script'),
      retry: (id) => run([id]),
      generateStoryboard: () => setOverlay('script'),
    }),
    [run],
  );

  const historyRows: HistoryRow[] = useMemo(() => {
    const live = (nodeId: string, row: HistoryRow): HistoryRow => {
      const n = graph.nodes.find((x) => x.id === nodeId);
      if (!n || row.status === 'done') return row;
      if (n.status === 'generating') return { ...row, status: 'running', progress: n.progress ?? 0 };
      if (n.status === 'failed') return { ...row, status: 'failed', refunded: n.refunded ?? row.credits };
      return { ...row, status: 'done' };
    };
    const session = sessionRuns.map((r) => live((r as HistoryRow & { nodeId: string }).nodeId, r));
    return [...session, ...MOCK_RUNS.map((r) => live(r.nodeId, r))];
  }, [graph.nodes, sessionRuns]);

  const pickRefs = (items: RefItem[]) => {
    if (!promptNode) return;
    const label = { mine: 'Mine', team: 'Team', builtin: 'Built-in', public: 'Public' } as const;
    setExtraRefs((m) => ({
      ...m,
      [promptNode.id]: [
        ...(m[promptNode.id] ?? []),
        ...items.map((it) => ({ id: it.id, name: it.name, source: label[it.source], tone: it.tone, letter: it.glyph.type === 'letter' ? it.glyph.letter : '' })),
      ],
    }));
    setOverlay(null);
  };

  const bg: CSSProperties = {
    backgroundPosition: `${viewport.x}px ${viewport.y}px`,
    backgroundSize: `${22 * viewport.zoom}px ${22 * viewport.zoom}px`,
  };

  return (
    <NodeActionsContext.Provider value={actions}>
      <div ref={rootRef} className={canvas.flow} style={bg}>
        <ReactFlow<CardNode, WireEdge>
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          onDelete={onDelete}
          connectionLineComponent={ConnectionLine}
          onPaneClick={(e) => {
            setSelected(null);
            setSelectedEdge(null);
            if (e.detail === 2) {
              const rect = rootRef.current!.getBoundingClientRect();
              setAddAt({ x: e.clientX - rect.left, y: e.clientY - rect.top });
              setOverlay('addMenu');
            } else if (overlay === 'addMenu' || overlay === 'at') {
              setOverlay(null);
            }
          }}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          minZoom={0.25}
          maxZoom={2}
          zoomOnDoubleClick={false}
          panOnScroll
          deleteKeyCode={['Delete', 'Backspace']}
          multiSelectionKeyCode="Shift"
          proOptions={{ hideAttribution: true }}
          ariaLabelConfig={{}}
        >
          <GroupFrames graph={graph} rfNodes={rfNodes} />
        </ReactFlow>
      </div>

      {promptPresence.mounted && lastPromptNode.current && lastPromptPos.current ? (
        <PromptPanel
          node={promptNode ?? lastPromptNode.current}
          left={(promptPos ?? lastPromptPos.current).left}
          top={(promptPos ?? lastPromptPos.current).top}
          state={promptPresence.state}
          extraRefs={extraRefs[(promptNode ?? lastPromptNode.current).id] ?? []}
          pickerOpen={overlay === 'at'}
          onOpenPicker={() => setOverlay((o) => (o === 'at' ? null : 'at'))}
          onGenerate={generate}
          models={models}
          plan={MOCK_ACCOUNT.plan}
          onSetResolution={(nodeId, resolution) => commit([{ op: 'updateNode', nodeId, params: { resolution } }])}
        />
      ) : null}

      <div className={canvas.topLeft}>
        <Link to="/" className={canvas.logo} aria-label={intl.formatMessage({ id: 'canvas.backHome' })}>
          <CanvasLogo />
        </Link>
        <button type="button" className={canvas.project} aria-label={intl.formatMessage({ id: 'canvas.projectMenu' }, { title: project.title })}>
          {project.title}
          <CanvasIcon name="caret" size={12} strokeWidth={2.4} className={canvas.caret} />
        </button>
        <span className={canvas.saved} data-status={syncStatus} role="status" data-testid="sync-status">
          <span className={canvas.savedDot} />
          <FormattedMessage id={`canvas.sync.${syncStatus}`} />
        </span>
      </div>

      <div className={canvas.topRight} style={{ right: agentOpen ? AGENT_INSET : 16 }}>
        <button
          type="button"
          className={canvas.credits}
          aria-expanded={creditsOpen}
          aria-haspopup="dialog"
          aria-label={intl.formatMessage({ id: 'canvas.credits.label' })}
          onClick={() => setCreditsOpen((o) => !o)}
        >
          <CanvasIcon name="coin" size={15} stroke="#9A9AA0" />
          <span className={canvas.creditsValue}>{intl.formatNumber(MOCK_CREDITS.balance)}</span>
          <span className={canvas.creditsPlus}>
            <CanvasIcon name="plus" size={13} strokeWidth={2.2} stroke="#F5F5F5" />
          </span>
        </button>
        <button type="button" className={canvas.share} onClick={() => setOverlay('share')} aria-haspopup="dialog">
          <FormattedMessage id="canvas.share" />
        </button>
        <button
          type="button"
          className={cx(canvas.runAll, canvas.press)}
          aria-expanded={overlay === 'plan'}
          aria-haspopup="dialog"
          aria-label={intl.formatMessage({ id: 'canvas.runAll.label' }, { n: runAllEstimate })}
          onClick={() => setOverlay('plan')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" />
          </svg>
          <FormattedMessage id="canvas.runAll" />
          <span className={canvas.runAllBadge}>
            <FormattedMessage id="canvas.runAll.estimate" values={{ n: runAllEstimate }} />
          </span>
        </button>
        {!agentOpen ? (
          <button type="button" className={cx(canvas.agentBtn, 'rl-fade')} data-state="open" data-motion="" onClick={() => setAgentOpen(true)}>
            <FormattedMessage id="canvas.agent.open" />
          </button>
        ) : null}
        {creditsP.mounted ? <CreditsPopover state={creditsP.state} onClose={() => setCreditsOpen(false)} /> : null}
      </div>

      <div role="toolbar" aria-label={intl.formatMessage({ id: 'canvas.tools.label' })} aria-orientation="vertical" className={canvas.toolbar}>
        {TOOLS.map((t) => {
          const label = intl.formatMessage({ id: t.label });
          return (
            <button key={t.key} type="button" className={canvas.tool} aria-label={label} title={label} aria-pressed={tool === t.key} onClick={() => pickTool(t.key)}>
              <CanvasIcon name={t.icon} size={18} />
            </button>
          );
        })}
      </div>

      <div className={canvas.bottomLeft}>
        <Minimap graph={graph} rfNodes={rfNodes} selected={selected} size={size} />
        <div className={canvas.zoom}>
          <button type="button" className={canvas.zoomBtn} aria-label={intl.formatMessage({ id: 'canvas.zoomOut' })} onClick={() => flow.zoomOut({ duration: 200 })}>
            <CanvasIcon name="minus" size={16} />
          </button>
          <span className={canvas.zoomValue} data-testid="zoom-value">
            <FormattedMessage id="canvas.zoom" values={{ zoom: viewport.zoom }} />
          </span>
          <button type="button" className={canvas.zoomBtn} aria-label={intl.formatMessage({ id: 'canvas.zoomIn' })} onClick={() => flow.zoomIn({ duration: 200 })}>
            <CanvasIcon name="plus" size={16} />
          </button>
          <button type="button" className={canvas.fit} onClick={() => flow.fitView({ duration: 320, padding: 0.15 })}>
            <FormattedMessage id="canvas.fit" />
          </button>
        </div>
      </div>

      {agentP.mounted ? <AgentPanel state={agentP.state} onClose={() => setAgentOpen(false)} onBuild={buildPlan} isMember={isMember} onJoined={() => setIsMember(true)} /> : null}

      {historyP.mounted ? <HistoryDrawer state={historyP.state} onClose={() => setHistoryOpen(false)} rows={historyRows} /> : null}

      {atP.mounted && lastPromptPos.current ? (
        <div className={cx(canvas.picker, 'rl-pop')} style={{ left: lastPromptPos.current.left, top: lastPromptPos.current.top + 68 }} {...presenceProps(atP.state)}>
          <ReferencePicker
            initialSelected={[]}
            onAdd={pickRefs}
            onClose={close}
          />
        </div>
      ) : null}

      {addP.mounted ? (
        <AddNodeMenu state={addP.state} onClose={close} x={addAt.x} y={addAt.y} suggested={selectedNode?.kind ?? null} onPick={addNode} />
      ) : null}

      {scriptP.mounted ? (
        <ScriptDialog
          state={scriptP.state}
          onClose={close}
          title={graph.nodes.find((n) => n.kind === 'script')?.title ?? ''}
          version={String(graph.nodes.find((n) => n.kind === 'script')?.params.versionLabel ?? '')}
        />
      ) : null}

      {editorOpen ? (
        renderEditor ? (
          renderEditor({ projectId, withProposal: overlay === 'editAgent', onClose: close })
        ) : (
          // TODO(editor): replaced by the editor from features/canvas/editor once it exports one.
          <section aria-label={intl.formatMessage({ id: 'canvas.editor.placeholder' })} className={canvas.editorPlaceholder} data-testid="editor-placeholder">
            <FormattedMessage id="canvas.editor.placeholder" />
          </section>
        )
      ) : null}

      {shareP.mounted ? (
        <ShareDialog
          state={shareP.state}
          onClose={close}
          url={getShare().url}
          snapshotAt={getShare().snapshotAt}
          onCopy={() => {
            void navigator.clipboard?.writeText(`https://${getShare().url}`).catch(() => {});
            toast.show({ message: intl.formatMessage({ id: 'canvas.shareDialog.copied' }) });
          }}
        />
      ) : null}

      {planP.mounted ? (
        <PlanDialog
          state={planP.state}
          onClose={close}
          rows={planRows}
          onConfirm={() => {
            run(quote.items.filter((i) => i.action === 'run').map((i) => i.nodeId));
            close();
          }}
        />
      ) : null}
    </NodeActionsContext.Provider>
  );
}

/** Group frames drawn behind their nodes (GraphOp `group`). */
function GroupFrames({ graph, rfNodes }: { graph: GraphState; rfNodes: CardNode[] }) {
  const viewport = useViewport();
  if (!graph.groups.length) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
      {graph.groups.map((g) => {
        const members = rfNodes.filter((n) => g.nodeIds.includes(n.id));
        if (!members.length) return null;
        const x0 = Math.min(...members.map((n) => n.position.x)) - 20;
        const y0 = Math.min(...members.map((n) => n.position.y)) - 40;
        const x1 = Math.max(...members.map((n) => n.position.x + (n.measured?.width ?? n.width ?? 240))) + 20;
        const y1 = Math.max(...members.map((n) => n.position.y + (n.measured?.height ?? 200))) + 20;
        return (
          <div
            key={g.id}
            className={cx(styles.group, 'rl-fade')}
            data-state="open"
            data-motion=""
            data-testid={`group-${g.id}`}
            style={{
              left: viewport.x + x0 * viewport.zoom,
              top: viewport.y + y0 * viewport.zoom,
              width: (x1 - x0) * viewport.zoom,
              height: (y1 - y0) * viewport.zoom,
            }}
          >
            <span className={styles.groupTitle}>{g.title}</span>
          </div>
        );
      })}
    </div>
  );
}

function Minimap({ graph, rfNodes, selected, size }: { graph: GraphState; rfNodes: CardNode[]; selected: string | null; size: { w: number; h: number } }) {
  const intl = useIntl();
  const flow = useReactFlow();
  const viewport = useViewport();
  const W = 150;
  const H = 92;
  const pad = 8;
  const view = { x: -viewport.x / viewport.zoom, y: -viewport.y / viewport.zoom, w: size.w / viewport.zoom, h: size.h / viewport.zoom };
  const boxes = rfNodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, w: n.measured?.width ?? n.width ?? 240, h: n.measured?.height ?? 200 }));
  const minX = Math.min(view.x, ...boxes.map((b) => b.x));
  const minY = Math.min(view.y, ...boxes.map((b) => b.y));
  const maxX = Math.max(view.x + view.w, ...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(view.y + view.h, ...boxes.map((b) => b.y + b.h));
  const s = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxY - minY));
  const ox = pad + ((W - pad * 2) - (maxX - minX) * s) / 2;
  const oy = pad + ((H - pad * 2) - (maxY - minY) * s) / 2;
  const tx = (x: number) => ox + (x - minX) * s;
  const ty = (y: number) => oy + (y - minY) * s;
  return (
    <div
      aria-label={intl.formatMessage({ id: 'canvas.minimap' })}
      role="img"
      className={canvas.minimap}
      data-count={graph.nodes.length}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const fx = minX + (e.clientX - r.left - ox) / s;
        const fy = minY + (e.clientY - r.top - oy) / s;
        void flow.setCenter(fx, fy, { zoom: viewport.zoom, duration: 320 });
      }}
    >
      {boxes.map((b) => (
        <span
          key={b.id}
          className={cx(canvas.mmNode, b.id === selected && canvas.mmNodeOn)}
          style={{ left: tx(b.x), top: ty(b.y), width: Math.max(3, b.w * s), height: Math.max(3, b.h * s) }}
        />
      ))}
      <span className={canvas.mmView} style={{ left: tx(view.x), top: ty(view.y), width: view.w * s, height: view.h * s }} />
    </div>
  );
}
