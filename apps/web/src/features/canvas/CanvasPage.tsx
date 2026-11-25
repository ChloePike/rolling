import { cx, presenceProps, usePresence, useToast } from '@rolling/ui';
import { Link, useNavigate } from '@tanstack/react-router';
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
  type OnConnectStart,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { ReferencePicker, type RefItem } from '@/features/prompt';
import { Paywall, ResultViewer, RunConfirm, type PaywallOption, type ResultActionId, type RunPlanRow, type RunRowKind } from '@/features/overlays';
import { AgentPanel, type AgentPlan } from './agent/AgentPanel';
import {
  getProject,
  openProject,
  publishShare,
  quoteRun,
  renameProject,
  setActiveVersion,
  startRun,
  stopSharing,
  topUp,
  updateShare,
  useCredits,
  useProject,
  useShare,
  applyAgentProposal,
  fetchProjectRuns,
  requestQuote,
  runError,
  type GraphProposal,
  type ProjectFatal,
  type Quote,
  type QuoteItem,
  type QuoteRequest,
  type QuoteScope,
  type ProjectSession,
  type StartRunResult,
} from './api';
import { CanvasError } from './CanvasError';
import { assetMediaUrl, isMockApi, savePendingAction, takePendingAction } from '@/features/overlays/backend';
import { downloadAsset } from '@/features/overlays/media';
import { resolveAssetId } from '@/lib/transfers';
import canvas from './canvas.module.css';
import type { LocalOp } from './graph/store';
import {
  blockedByBypass,
  inputPorts,
  outputType,
  rerouteIndex,
  type GraphNode,
  type GraphState,
  type NodeKind,
  type PortType,
  type Refusal,
  type XY,
} from '@rolling/core/graph';
import { CanvasIcon, CanvasLogo, type CanvasIconName } from './icons';
import {
  AddNodeMenu,
  CreditsPopover,
  HistoryDrawer,
  MOCK_RUNS,
  PlanDialog,
  ScriptDialog,
  ShareDialog,
  TemplatesPanel,
  type AddPick,
  type HistoryRow,
} from './layers/Layers';
import { MenuPopover, PointMenu, type MenuEntry } from './layers/Menu';
import { MOCK_PRICE, MOCK_REFS, mockVideoCredits, SCRIPT_ROWS, type CanvasTemplate, type PromptRef, type ScriptRow } from './mocks';
import { useSession, checkoutPlan } from '@/lib/session';
import { PLAN_ORDER } from '@rolling/core/pricing/config';
import { NodeActionsContext, NodeCard, NODE_WIDTH, runCost, willRun, type CardNode, type NodeActions } from './nodes/NodeCard';
import styles from './nodes/nodes.module.css';
import { ConnectionLine, EdgeActionsContext, Wire, type EdgeActions, type WireEdge } from './nodes/Wire';
import { PromptPanel } from './prompt/PromptPanel';
import { formatLabel, usePricedNodes } from './pricing';
import { getPrefs } from '@/lib/prefs';
import { modeLabel, modelLabel, type CatalogModel } from '@/lib/models';

/** Layers the design opens through `initOverlay` (Canvas.dc.html), plus the canvas' own. */
export type CanvasOverlay = 'plan' | 'addMenu' | 'script' | 'share' | 'edit' | 'editAgent' | 'at';
export const CANVAS_OVERLAYS: readonly CanvasOverlay[] = ['plan', 'addMenu', 'script', 'share', 'edit', 'editAgent', 'at'];

export interface CanvasEditorSlotProps {
  projectId: string;
  /** Opened with the agent's edit proposal (CanvasEditAgent). */
  withProposal: boolean;
  onClose: () => void;
  /** "Open on canvas" from the editor: closes it and selects the node. */
  onOpenOnCanvas: (nodeId: string) => void;
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
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.5, 2];
const nodeTypes = { card: NodeCard };
const edgeTypes = { wire: Wire };

/** New-node defaults per kind. */
const NODE_DEFAULTS: Record<string, Record<string, unknown>> = {
  text: { text: '' },
  script: { rows: [], versionLabel: 'v1' },
  image: { tone: 'var(--c-tone-plum)', prompt: '', model: 'Seedream 5.0 Pro', mode: 'Text to image', ratio: '9:16', resolution: '2K', count: 1, quick: ['Style', 'Framing', 'Lighting', 'Camera'], refs: [], runCost: MOCK_PRICE.image },
  video: { tone: 'var(--c-tone-indigo)', seconds: 5, prompt: '', model: 'Seedance 2.5', mode: 'First frame', ratio: '9:16', resolution: '720p', length: 5, extra: '×1 · Audio on', quick: ['Style', 'Camera', 'Lighting', 'Pace'], refs: [], runCost: mockVideoCredits(5) },
  audio: { voice: 'Clear female', seconds: 0, wave: [], runCost: MOCK_PRICE.voice },
};
const ADDABLE: NodeKind[] = ['text', 'script', 'image', 'video', 'audio'];

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
  const [fatal, setFatal] = useState<ProjectFatal | null>(null);
  const titles = useRef(new Map<string, string>());
  const retryRef = useRef<(id: string) => void>(() => {});

  useEffect(() => {
    setFatal(null);
    const s = openProject(props.projectId, {
      onFatal: setFatal,
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

  if (fatal) return <CanvasError reason={fatal} />;

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

function planMeta(intl: ReturnType<typeof useIntl>, n: GraphNode, item?: QuoteItem, models?: CatalogModel[]): string {
  const p = n.params;
  const parts: string[] = [];
  if (item?.action === 'bypassed') return intl.formatMessage({ id: 'canvas.plan.meta.bypassed' });
  if (item?.action === 'blocked') {
    const why = quoteCodeText(intl, item);
    if (why) return why;
  }
  if (item?.action === 'reuse' && item.reason && !isMockApi()) parts.push(item.reason === 'Already running' ? intl.formatMessage({ id: 'canvas.plan.meta.running' }) : item.reason);
  if (n.kind === 'script' || n.kind === 'text') return intl.formatMessage({ id: 'canvas.plan.meta.text' });
  if (n.kind === 'asset') return intl.formatMessage({ id: 'canvas.plan.meta.asset' });
  if (n.kind === 'audio') {
    return intl.formatMessage({ id: 'canvas.plan.meta.tts' }, { voice: String(p.voice ?? ''), seconds: Number(p.seconds ?? 0) });
  }
  if (item?.modelName) parts.push(item.modelName);
  else if (typeof p.model === 'string') parts.push(modelLabel(models, p.model));
  if (typeof p.mode === 'string' && n.kind === 'video') parts.push(modeLabel(p.mode));
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

/** Input port of a node of `kind` that takes `type`, if any. */
function inputFor(kind: NodeKind, type: PortType): string | null {
  return inputPorts({ kind }).find((p) => p.type === type)?.name ?? null;
}

/** Node kinds that can sit at the other end of a wire dragged from a port. */
function acceptingKinds(type: PortType, from: 'out' | 'in'): NodeKind[] {
  return ADDABLE.filter((k) => (from === 'out' ? !!inputFor(k, type) : outputType({ kind: k, params: {} }) === type));
}

type RunGate =
  | { type: 'confirm'; quote: Quote; request: QuoteRequest; nodeId: string }
  | { type: 'join'; request: QuoteRequest }
  | { type: 'credits'; request: QuoteRequest; total: number };

type Menu =
  | { kind: 'node'; id: string; x: number; y: number }
  | { kind: 'edge'; id: string; x: number; y: number; flow: XY }
  | { kind: 'versions'; id: string; x: number; y: number };

interface PendingWire {
  nodeId: string;
  type: PortType;
  from: 'out' | 'in';
}

interface InnerProps extends CanvasPageProps {
  session: ProjectSession;
  titles: Map<string, string>;
  retryRef: { current: (id: string) => void };
}

function CanvasInner({ projectId, initialOverlay = null, initialSelection = null, renderEditor, session, titles, retryRef }: InnerProps) {
  const intl = useIntl();
  const toast = useToast();
  const navigate = useNavigate();
  const flow = useReactFlow<CardNode, WireEdge>();
  const viewport = useViewport();
  const storeGraph = useGraph(session);
  const { nodes: pricedNodes, models } = usePricedNodes(storeGraph.nodes);
  const graph = useMemo(() => ({ ...storeGraph, nodes: pricedNodes }), [storeGraph, pricedNodes]);
  const syncStatus = useSyncExternalStore(session.sync.subscribe, session.sync.getStatus);
  // Result thumbnails follow `node.version` / `job.done` (active version asset per node).
  const mediaVersion = useSyncExternalStore(session.sync.subscribeMedia, session.sync.getMediaVersion);
  const project = useProject(projectId);
  const credits = useCredits();
  const share = useShare(projectId);

  const [selected, setSelected] = useState<string | null>(initialSelection);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<CanvasOverlay | null>(initialOverlay);
  const [agentOpen, setAgentOpen] = useState(true);
  // Membership and plan caps come from the shared session (D-006, D-007).
  const { isMember, planId } = useSession();
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toolPanel, setToolPanel] = useState<'templates' | 'assets' | null>(null);
  const [projectMenu, setProjectMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [zoomMenu, setZoomMenu] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [resultFor, setResultFor] = useState<string | null>(null);
  const [gate, setGate] = useState<RunGate | null>(null);
  const [planScope, setPlanScope] = useState<{ scope: QuoteScope; nodeId?: string }>({ scope: 'all' });
  const [scriptMenu, setScriptMenu] = useState<'fields' | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [addAt, setAddAt] = useState(ADD_AT);
  const [wire, setWire] = useState<PendingWire | null>(null);
  const [dropWire, setDropWire] = useState<PendingWire | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [proposed, setProposed] = useState<string[] | null>(null);
  const [refRegistry, setRefRegistry] = useState<Record<string, PromptRef>>(MOCK_REFS);
  const pickerFromTyping = useRef(false);
  const [sessionRuns, setSessionRuns] = useState<HistoryRow[]>([]);
  const [serverRuns, setServerRuns] = useState<HistoryRow[] | null>(null);
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
        const blocked = node.bypass || !willRun(node) ? null : blockedByBypass(graph, node.id);
        return {
          ...(old ?? {}),
          id: node.id,
          type: 'card' as const,
          position: old && dragging.current.has(node.id) ? old.position : node.position,
          width: NODE_WIDTH[node.kind],
          selected: node.id === selected,
          data: {
            node,
            buildIndex: session.store.buildIndex(node.id),
            refused: refused === node.id,
            proposed: proposed?.includes(node.id) ?? false,
            connecting: wire,
            blockedReason: blocked?.message ?? null,
            mediaUrl: mediaUrlOf(session, node.id),
            mediaRating: session.sync.getMedia(node.id)?.rating ?? null,
            readOnly: !session.sync.canEdit,
          },
        };
      });
    });
  }, [graph, selected, refused, session, proposed, wire, mediaVersion]);

  // Real mode: the first time the graph shows, frame it in the area left of the agent panel.
  const framed = useRef(false);
  useEffect(() => {
    if (isMockApi() || framed.current || !rfNodes.length || !rfNodes.every((n) => n.measured?.width)) return;
    framed.current = true;
    const b = flow.getNodesBounds(rfNodes);
    const pad = 48;
    const w = Math.max(200, size.w - (agentOpen ? AGENT_INSET : 16) - pad * 2);
    const h = Math.max(200, size.h - 160 - pad);
    const zoom = Math.min(1, w / Math.max(1, b.width), h / Math.max(1, b.height));
    void flow.setViewport({ x: pad - b.x * zoom, y: 96 + (h - b.height * zoom) / 2 - b.y * zoom, zoom });
  }, [rfNodes, flow, size, agentOpen]);

  const rfEdges = useMemo<WireEdge[]>(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return graph.edges.map((e) => {
      const a = session.store.buildIndex(e.from.node);
      const b = session.store.buildIndex(e.to.node);
      const src = byId.get(e.from.node);
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
          pending: byId.get(e.to.node)?.status === 'generating' && (e.to.port === 'frame' || e.to.port === 'refs' || e.to.port === 'clips'),
          build: a >= 0 && b >= 0 ? Math.max(a, b) : -1,
          type: src ? outputType(src) : null,
          reroutes: e.reroutes,
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

  const flashRefused = useCallback(
    (nodeId: string, r: Refusal) => {
      setRefused(nodeId);
      window.setTimeout(() => setRefused((x) => (x === nodeId ? null : x)), 1200);
      toast.show({ message: refusalText(intl, r) });
    },
    [toast, intl],
  );

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

  const isValidConnection = useCallback((c: Connection | Edge) => session.store.planConnect(c.source, c.target).ok, [session]);

  const onConnectStart: OnConnectStart = useCallback(
    (_e, params) => {
      const node = session.store.getState().nodes.find((n) => n.id === params.nodeId);
      if (!node) return;
      const from = params.handleType === 'source' ? 'out' : 'in';
      const type = from === 'out' ? outputType(node) : (inputPorts(node)[0]?.type ?? null);
      if (type) setWire({ nodeId: node.id, type, from });
    },
    [session],
  );

  const onConnectEnd: OnConnectEnd = useCallback(
    (e: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      const pending = wire;
      setWire(null);
      if (!state.toNode && state.fromNode && pending) {
        // Dropped on empty canvas: node search filtered to what can take the wire.
        const pt = 'changedTouches' in e ? e.changedTouches[0]! : (e as MouseEvent);
        const rect = rootRef.current!.getBoundingClientRect();
        setAddAt({ x: pt.clientX - rect.left, y: pt.clientY - rect.top });
        setDropWire(pending);
        setOverlay('addMenu');
        return;
      }
      if (state.isValid !== false || !state.toNode || !state.fromNode) return;
      const fromIsSource = state.fromHandle?.type === 'source';
      const source = fromIsSource ? state.fromNode.id : state.toNode.id;
      const target = fromIsSource ? state.toNode.id : state.fromNode.id;
      const plan = session.store.planConnect(source, target);
      if (!plan.ok) flashRefused(target, plan.refusal);
    },
    [session, flashRefused, wire],
  );

  const removeNodes = useCallback(
    (nodeIds: string[], edgeIds: string[] = []) => {
      const removed = new Set(nodeIds);
      const ops: LocalOp[] = [
        ...edgeIds.map((edgeId) => ({ op: 'disconnect' as const, edgeId })),
        ...nodeIds.map((nodeId) => ({ op: 'removeNode' as const, nodeId })),
      ];
      if (!ops.length) return;
      const r = commit(ops);
      if (r.ok && nodeIds.length) {
        if (selected && removed.has(selected)) setSelected(null);
        toast.show({
          message: intl.formatMessage({ id: 'canvas.toast.deleted' }, { n: nodeIds.length }),
          action: { label: intl.formatMessage({ id: 'canvas.toast.undo' }), onAction: () => session.sync.undo() },
        });
      } else if (r.ok && edgeIds.length) {
        toast.show({
          message: intl.formatMessage({ id: 'canvas.toast.disconnected' }, { n: edgeIds.length }),
          action: { label: intl.formatMessage({ id: 'canvas.toast.undo' }), onAction: () => session.sync.undo() },
        });
      }
    },
    [commit, selected, toast, intl, session],
  );

  const onDelete = useCallback(
    ({ nodes, edges }: { nodes: CardNode[]; edges: WireEdge[] }) => {
      const removed = new Set(nodes.map((n) => n.id));
      removeNodes(
        nodes.map((n) => n.id),
        edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)).map((e) => e.id),
      );
    },
    [removeNodes],
  );

  /* ---------- Node commands ---------- */

  const selectNode = useCallback(
    (id: string, center = false) => {
      setSelected(id);
      setSelectedEdge(null);
      const n = flow.getNode(id);
      if (center && n) void flow.setCenter(n.position.x + (n.measured?.width ?? 240) / 2, n.position.y + (n.measured?.height ?? 200) / 2, { zoom: viewport.zoom, duration: 320 });
    },
    [flow, viewport.zoom],
  );

  const duplicate = useCallback(
    (id: string) => {
      const n = session.store.getState().nodes.find((x) => x.id === id);
      if (!n) return;
      const r = commit([
        {
          op: 'addNode',
          tempId: 'dup',
          kind: n.kind,
          title: intl.formatMessage({ id: 'canvas.node.copyTitle' }, { title: n.title }),
          params: { ...n.params },
          position: { x: n.position.x + 40, y: n.position.y + 40 },
        },
      ]);
      if (r.ok) setSelected(r.idMap.dup ?? null);
    },
    [session, commit, intl],
  );

  const toggleBypass = useCallback(
    (id: string) => {
      const n = session.store.getState().nodes.find((x) => x.id === id);
      if (!n) return;
      const r = commit([{ op: 'setBypass', nodeId: id, bypass: !n.bypass }]);
      if (r.ok) toast.show({ message: intl.formatMessage({ id: n.bypass ? 'canvas.toast.bypassOff' : 'canvas.toast.bypassOn' }, { title: n.title }) });
    },
    [session, commit, toast, intl],
  );

  const toggleCollapsed = useCallback(
    (id: string) => {
      const n = session.store.getState().nodes.find((x) => x.id === id);
      if (n) commit([{ op: 'setCollapsed', nodeId: id, collapsed: !n.collapsed }]);
    },
    [session, commit],
  );

  /* ---------- Runs: quote → (paywall | top-up | confirm per threshold) → hold → jobs ---------- */

  const recordRuns = useCallback(
    (items: QuoteItem[]) => {
      const now = new Date();
      setSessionRuns((rows) => [
        ...items.map((it) => {
          const n = session.store.getState().nodes.find((x) => x.id === it.nodeId)!;
          return { id: `run_${it.nodeId}_${now.getTime()}`, nodeId: it.nodeId, title: n.title, model: it.model, credits: it.credits, status: 'running' as const, at: now };
        }),
        ...rows,
      ]);
    },
    [session],
  );

  /** What `POST /api/runs` answered (or the mock room), turned into the next gate or a message. */
  const handleStart = useCallback(
    (r: StartRunResult, quote: Quote, request: QuoteRequest, retry: (q: Quote) => void) => {
      const runs = quote.items.filter((i) => i.action === 'run');
      if (r.ok) {
        setGate(null);
        recordRuns(runs);
        toast.show({ message: intl.formatMessage({ id: 'canvas.toast.started' }, { n: runs.length }) });
        return;
      }
      switch (r.code) {
        case 'NO_PLAN':
          // D-007: keep the run and resume it after checkout (also across the Stripe redirect).
          savePendingAction('canvas.run', { projectId, request });
          setGate({ type: 'join', request });
          return;
        case 'INSUFFICIENT_CREDITS':
          setGate({ type: 'credits', request, total: quote.total });
          return;
        case 'QUOTE_EXPIRED':
          // Prices are held 10 minutes: re-quote and show the new total.
          void requestQuote(projectId, request, session.store.getState()).then(
            (q) => {
              if (q.needsConfirm) {
                toast.show({ message: intl.formatMessage({ id: 'canvas.toast.requoted' }, { n: q.total }) });
                setGate({ type: 'confirm', quote: q, request, nodeId: request.nodeIds?.[0] ?? '' });
              } else retry(q);
            },
            () => toast.show({ message: intl.formatMessage({ id: 'canvas.toast.offline' }) }),
          );
          return;
        case 'MEMBER_LIMIT_REACHED':
          setGate(null);
          toast.show({ message: intl.formatMessage({ id: 'canvas.toast.memberLimit' }), duration: 0 });
          return;
        case 'CONCURRENCY_LIMIT':
          setGate(null);
          toast.show({ message: intl.formatMessage({ id: 'canvas.toast.concurrency' }, { limit: r.limit ?? 0 }) });
          return;
        case 'NOTHING_TO_RUN':
          setGate(null);
          toast.show({ message: intl.formatMessage({ id: 'canvas.toast.nothingToRunAll' }) });
          return;
        case 'OFFLINE':
          toast.show({ message: intl.formatMessage({ id: 'canvas.toast.offline' }) });
          return;
        default:
          setGate(null);
          toast.show({ message: intl.formatMessage({ id: 'canvas.toast.runError' }, { message: r.message }) });
      }
    },
    [projectId, session, recordRuns, toast, intl],
  );

  const executeRun = useCallback(
    (quote: Quote, request: QuoteRequest, attempt = 0) => {
      const runs = quote.items.filter((i) => i.action === 'run');
      if (!runs.length) return;
      // Mock mode gates on the mock session; the real API answers NO_PLAN itself.
      if (isMockApi() && !isMember) {
        setGate({ type: 'join', request });
        return;
      }
      void startRun(quote).then(
        (r) => handleStart(r, quote, request, (q) => attempt < 1 && executeRunRef.current(q, request, attempt + 1)),
        (e: unknown) => handleStart(runError(e), quote, request, () => {}),
      );
    },
    [isMember, handleStart],
  );
  executeRunRef.current = executeRun;

  /** Quotes `request` and runs it (or asks first, per the confirm threshold). Quote-time blocks explain themselves. */
  const runRequest = useCallback(
    (request: QuoteRequest) => {
      const state = session.store.getState();
      const nodes = graph.nodes.length ? graph.nodes : state.nodes;
      void requestQuote(projectId, request, { nodes, edges: state.edges }).then(
        (q) => {
          const runs = q.items.filter((i) => i.action === 'run');
          if (!runs.length) {
            const id = request.nodeIds?.[0];
            const item = q.items.find((i) => i.nodeId === id) ?? q.items[0];
            const n = nodes.find((x) => x.id === item?.nodeId);
            toast.show({ message: quoteBlockText(intl, item, n?.title ?? '') });
            return;
          }
          // Runs under the user's "Confirm before running" threshold start without the quote dialog (D-006).
          if (!q.needsConfirm) executeRun(q, request);
          else setGate({ type: 'confirm', quote: q, request, nodeId: request.nodeIds?.[0] ?? '' });
        },
        (e: unknown) => handleStart(runError(e), { quoteId: null, scope: request.scope, items: [], total: 0, balance: 0, balanceAfter: 0, expiresAt: null, confirmThreshold: 0, needsConfirm: false }, request, () => {}),
      );
    },
    [projectId, session, graph.nodes, executeRun, handleStart, toast, intl],
  );
  runRequestRef.current = runRequest;

  /** Run one node, or a node with its upstream (`upTo`) or downstream (`from`). */
  const requestRun = useCallback(
    (id: string, scope: Exclude<QuoteScope, 'all'> = 'node') => {
      if (scope !== 'node') {
        setPlanScope({ scope, nodeId: id });
        setOverlay('plan');
        return;
      }
      runRequest({ scope: 'node', nodeIds: [id] });
    },
    [runRequest],
  );
  retryRef.current = (id) => requestRun(id);

  // A run interrupted by the join paywall resumes once the plan is active (after checkout, even after a redirect).
  useEffect(() => {
    if (isMockApi() || syncStatus !== 'saved') return;
    const pending = takePendingAction<{ projectId: string; request: QuoteRequest }>('canvas.run');
    if (pending?.projectId === projectId) runRequest(pending.request);
    // Only once the canvas has loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncStatus === 'saved']);

  const planRequest: QuoteRequest = useMemo(
    () => (planScope.scope === 'all' || !planScope.nodeId ? { scope: 'all' } : { scope: planScope.scope, nodeIds: [planScope.nodeId] }),
    [planScope],
  );
  const planQuote = usePlanQuote(projectId, overlay === 'plan', planRequest, graph);
  const runAllEstimate = graph.nodes.filter((n) => willRun(n) && !n.bypass).reduce((s, n) => s + (runCost(n) ?? 0), 0);
  const planRows: RunPlanRow[] = useMemo(
    () =>
      (planQuote?.items ?? []).flatMap((it) => {
        const n = graph.nodes.find((x) => x.id === it.nodeId);
        if (!n) return [];
        const real = !isMockApi();
        return [
          {
            id: n.id,
            name: n.kind === 'script' ? `${intl.formatMessage({ id: 'canvas.node.kind.script' })} · ${String(n.params.versionLabel ?? '')}` : n.title,
            meta: planMeta(intl, n, it, models),
            kind: runKind(n.kind),
            state: it.action === 'none' || it.action === 'bypassed' ? 'free' : it.action === 'run' || (n.status === 'generating' && it.action !== 'blocked') ? 'run' : it.action,
            cost: real ? it.credits : it.action === 'run' || n.status === 'generating' ? runCost(n) ?? 0 : 0,
            tone: typeof n.params.tone === 'string' ? n.params.tone : undefined,
          } satisfies RunPlanRow,
        ];
      }),
    [planQuote, graph.nodes, intl, models],
  );

  /* ---------- Agent: Build on canvas (a free graph patch from the plan proposal) ---------- */

  const buildShots = useCallback(
    (shots: Array<{ n: number | string; title: string; seconds: number; visual: string }>, title: string, from?: string) => {
      const nodes = session.store.getState().nodes;
      const bottom = Math.max(0, ...nodes.map((n) => n.position.y + (n.kind === 'image' ? 263 : 193)));
      const y = bottom + 80;
      const ops: LocalOp[] = [];
      const ids: string[] = [];
      shots.forEach((s, i) => {
        const key = `k${s.n}`;
        const shot = `v${s.n}`;
        ids.push(key, shot);
        ops.push(
          { op: 'addNode', tempId: key, kind: 'image', title: `${s.title} keyframe`, params: { ...NODE_DEFAULTS.image, prompt: s.visual, mode: 'Image to image', refs: ['m1'] }, position: { x: 448 + i * 600, y } },
          { op: 'addNode', tempId: shot, kind: 'video', title: `Shot ${String.fromCharCode(65 + i)}: ${s.title}`, params: { ...NODE_DEFAULTS.video, seconds: s.seconds, prompt: s.visual, length: s.seconds, runCost: mockVideoCredits(s.seconds) }, position: { x: 448 + i * 600 + 270, y } },
          { op: 'connect', from: { node: key, port: 'out' }, to: { node: shot, port: 'frame' } },
        );
        if (from) ops.push({ op: 'connect', from: { node: from, port: 'out' }, to: { node: key, port: 'prompt' } });
      });
      ops.push({ op: 'group', nodeIds: ids, title });
      // Applying a proposal is a normal patch by the user (harness §2); the agent only proposed it.
      const r = commit(ops);
      return r.ok ? ids.length : 0;
    },
    [session, commit],
  );

  const buildPlan = useCallback((plan: AgentPlan) => buildShots(plan.shots, plan.title), [buildShots]);

  const scriptNode = graph.nodes.find((n) => n.kind === 'script') ?? null;
  const scriptRows = (scriptNode && Array.isArray(scriptNode.params.script) ? scriptNode.params.script : undefined) as ScriptRow[] | undefined;

  const generateStoryboard = useCallback(
    (rows: Array<{ n: string; visual: string; seconds: number }>, scriptId?: string) => {
      if (!rows.length) return;
      const added = buildShots(
        rows.map((r) => ({ n: r.n, title: r.visual.split(',')[0]!.slice(0, 32), seconds: r.seconds, visual: r.visual })),
        intl.formatMessage({ id: 'canvas.script.storyboardGroup' }, { version: String(scriptNode?.params.versionLabel ?? '') }),
        scriptId,
      );
      if (added) {
        setOverlay(null);
        toast.show({ message: intl.formatMessage({ id: 'canvas.toast.storyboard' }, { n: added }) });
      }
    },
    [buildShots, intl, scriptNode, toast],
  );

  const saveScript = useCallback(
    (rows: ScriptRow[], version: string) => {
      if (!scriptNode) return;
      commit([
        {
          op: 'updateNode',
          nodeId: scriptNode.id,
          params: { script: rows, rows: rows.filter((r) => r.selected).map((r) => ({ n: r.n, visual: r.visual, seconds: r.seconds })), versionLabel: version },
        },
      ]);
    },
    [scriptNode, commit],
  );

  const applyProposal = useCallback(
    (p: GraphProposal): boolean | Promise<boolean> => {
      if (!isMockApi()) {
        // Exactly the stored ops go to the room as the user (origin agent); they arrive as graph.patched.
        return applyAgentProposal(p.id).then(
          () => {
            toast.show({ message: intl.formatMessage({ id: 'canvas.toast.proposalApplied' }) });
            return true;
          },
          () => false,
        );
      }
      const r = commit(p.ops);
      if (r.ok) {
        toast.show({
          message: intl.formatMessage({ id: 'canvas.toast.proposalApplied' }),
          action: { label: intl.formatMessage({ id: 'canvas.toast.undo' }), onAction: () => session.sync.undo() },
        });
      }
      return r.ok;
    },
    [commit, toast, intl, session],
  );

  /* ---------- Layout of the floating prompt editor ---------- */

  const selectedNode = graph.nodes.find((n) => n.id === selected) ?? null;
  const visibleRight = size.w - (agentOpen ? AGENT_INSET : 16);
  const promptNode = selectedNode && (selectedNode.kind === 'image' || selectedNode.kind === 'video') && !selectedNode.collapsed ? selectedNode : null;
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

  const refsOf = (node: GraphNode): PromptRef[] =>
    ((Array.isArray(node.params.refs) ? node.params.refs : []) as string[]).map((id) => refRegistry[id]).filter((r): r is PromptRef => !!r);

  /* ---------- Overlays ---------- */

  const close = useCallback(() => {
    setOverlay(null);
    setDropWire(null);
    setScriptMenu(null);
  }, []);
  const addP = usePresence(overlay === 'addMenu');
  const scriptP = usePresence(overlay === 'script');
  const shareP = usePresence(overlay === 'share');
  const planP = usePresence(overlay === 'plan');
  const atP = usePresence(overlay === 'at' && !!promptNode);
  const agentP = usePresence(agentOpen);
  const creditsP = usePresence(creditsOpen);
  const historyP = usePresence(historyOpen);
  // Real mode: the drawer lists this project's runs from the Activity index, refreshed while it is open.
  useEffect(() => {
    if (isMockApi() || !historyOpen) return;
    let live = true;
    const load = () => void fetchProjectRuns(projectId).then((rows) => live && setServerRuns(rows), () => {});
    load();
    const t = window.setInterval(load, 5000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [historyOpen, projectId]);
  const templatesP = usePresence(toolPanel === 'templates');
  const assetsP = usePresence(toolPanel === 'assets');
  const menuP = usePresence(!!menu);
  const lastMenu = useRef(menu);
  if (menu) lastMenu.current = menu;
  const editorOpen = overlay === 'edit' || overlay === 'editAgent';

  const pickTool = (k: Tool) => {
    if (k === 'add') {
      setAddAt(ADD_AT);
      setDropWire(null);
      setOverlay((o) => (o === 'addMenu' ? null : 'addMenu'));
    } else if (k === 'cut') {
      setOverlay((o) => (o === 'edit' ? null : 'edit'));
    } else if (k === 'hist') {
      setHistoryOpen((h) => !h);
    } else if (k === 'asset') {
      setToolPanel((p) => (p === 'assets' ? null : 'assets'));
    } else if (k === 'flow') {
      setToolPanel((p) => (p === 'templates' ? null : 'templates'));
    } else if (k === 'dir') {
      toast.show({ message: intl.formatMessage({ id: 'canvas.tools.directorSoon' }) });
    }
  };
  const toolPressed = (k: Tool) =>
    k === 'add' ? overlay === 'addMenu' : k === 'cut' ? editorOpen : k === 'hist' ? historyOpen : k === 'asset' ? toolPanel === 'assets' : k === 'flow' ? toolPanel === 'templates' : false;

  /** Flow position of the screen point (relative to the canvas). */
  const toFlow = (p: XY) => {
    const rect = rootRef.current?.getBoundingClientRect();
    return flow.screenToFlowPosition({ x: p.x + (rect?.left ?? 0), y: p.y + (rect?.top ?? 0) });
  };

  const addFromMenu = (pick: AddPick) => {
    const pos = toFlow(addAt);
    const at = { x: Math.round(pos.x), y: Math.round(pos.y) };
    const tempId = 'new';
    const ops: LocalOp[] = [];
    let kind: NodeKind;
    if (pick.type === 'resource') {
      const r = pick.item;
      kind = r.group === 'voice' ? 'audio' : 'asset';
      ops.push({
        op: 'addNode',
        tempId,
        kind,
        title: r.name,
        params: kind === 'audio' ? { voice: r.name, seconds: 0, wave: [], runCost: MOCK_PRICE.voice } : { media: 'image', label: r.meta, tone: r.tone, refId: r.id },
        position: at,
      });
    } else {
      kind = pick.kind;
      ops.push({
        op: 'addNode',
        tempId,
        kind,
        title: intl.formatMessage({ id: `canvas.add.newTitle.${kind}` }),
        params: { ...withCatalogModel(NODE_DEFAULTS[kind] ?? {}, kind, models), ...(pick.variant ? { source: pick.variant } : {}) },
        position: at,
      });
    }
    // Dropped from a wire: connect the new node to the other end in the same patch.
    if (dropWire) {
      if (dropWire.from === 'out') {
        const port = inputFor(kind, dropWire.type);
        if (port) ops.push({ op: 'connect', from: { node: dropWire.nodeId, port: 'out' }, to: { node: tempId, port } });
      } else {
        const target = session.store.getState().nodes.find((n) => n.id === dropWire.nodeId);
        const port = target ? inputPorts(target).find((p) => p.type === dropWire.type)?.name : undefined;
        if (port) ops.push({ op: 'connect', from: { node: tempId, port: 'out' }, to: { node: dropWire.nodeId, port } });
      }
    }
    const r = commit(ops);
    if (r.ok) setSelected(r.idMap[tempId] ?? null);
    close();
  };

  const useTemplate = (tpl: CanvasTemplate) => {
    const center = toFlow({ x: size.w / 2 - 300, y: size.h / 2 - 120 });
    const ops: LocalOp[] = [];
    tpl.nodes.forEach((n, i) => {
      ops.push({
        op: 'addNode',
        tempId: `t${i}`,
        kind: n.kind,
        title: n.title,
        params: { ...(NODE_DEFAULTS[n.kind] ?? {}), ...(n.prompt ? { prompt: n.prompt } : {}) },
        position: { x: Math.round(center.x + i * 330), y: Math.round(center.y) },
      });
      const prev = tpl.nodes[i - 1];
      if (prev) {
        const type = outputType({ kind: prev.kind, params: {} });
        const port = type ? inputFor(n.kind, type) : null;
        if (port) ops.push({ op: 'connect', from: { node: `t${i - 1}`, port: 'out' }, to: { node: `t${i}`, port } });
      }
    });
    ops.push({ op: 'group', nodeIds: tpl.nodes.map((_, i) => `t${i}`), title: tpl.name });
    const r = commit(ops);
    if (r.ok) {
      setToolPanel(null);
      toast.show({
        message: intl.formatMessage({ id: 'canvas.toast.template' }, { name: tpl.name, n: tpl.nodes.length }),
        action: { label: intl.formatMessage({ id: 'canvas.toast.undo' }), onAction: () => session.sync.undo() },
      });
    }
  };

  const addAssets = (items: RefItem[]) => {
    const center = toFlow({ x: 120, y: size.h / 2 - 100 });
    const place = (resolved: string[]) => {
      const r = commit(
        items.map((it, i) => ({
          op: 'addNode' as const,
          tempId: `a${i}`,
          kind: it.group === 'voice' ? ('audio' as const) : ('asset' as const),
          title: it.name,
          params:
            it.group === 'voice'
              ? { voice: it.name, voiceId: it.id, seconds: 0, wave: [], runCost: MOCK_PRICE.voice }
              : {
                  media: /^video/i.test(it.meta) || (it.glyph.type === 'icon' && it.glyph.icon === 'video') ? 'video' : it.glyph.type === 'wave' ? 'audio' : 'image',
                  label: it.meta,
                  tone: it.tone,
                  refId: it.id,
                  // Real mode: the planner reads `params.assetId` (uploads resolved from `upl_` first).
                  ...(isMockApi() ? {} : { assetId: resolved[i] }),
                },
          position: { x: Math.round(center.x + i * 230), y: Math.round(center.y) },
        })),
      );
      if (r.ok) {
        setToolPanel(null);
        toast.show({ message: intl.formatMessage({ id: 'canvas.toast.assetsAdded' }, { n: items.length }) });
      }
    };
    if (isMockApi()) return place([]);
    void Promise.all(items.map((it) => resolveAssetId(it.id))).then(place, () => toast.show({ message: intl.formatMessage({ id: 'canvas.toast.offline' }) }));
  };

  const actions: NodeActions = useMemo(
    () => ({
      openScript: () => setOverlay('script'),
      openFields: () => {
        setScriptMenu('fields');
        setOverlay('script');
      },
      retry: (id) => requestRun(id),
      generateStoryboard: (id) => {
        const n = session.store.getState().nodes.find((x) => x.id === id);
        const rows = (Array.isArray(n?.params.rows) ? n!.params.rows : []) as Array<{ n: string; visual: string; seconds: number }>;
        generateStoryboard(rows, id);
      },
      run: (id) => requestRun(id),
      openResult: (id) => setResultFor(id),
      openVersions: (id, r) => setMenu({ kind: 'versions', id, x: r.left, y: r.bottom + 6 }),
    }),
    [requestRun, generateStoryboard, session],
  );

  const edgeActions: EdgeActions = useMemo(
    () => ({
      moveReroute: (edgeId, index, position) => commit([{ op: 'moveReroute', edgeId, index, position }]),
      removeReroute: (edgeId, index) => commit([{ op: 'removeReroute', edgeId, index }]),
      rerouteLabel: (i) => intl.formatMessage({ id: 'canvas.edge.reroute' }, { n: i + 1 }),
    }),
    [commit, intl],
  );

  const addReroute = (edgeId: string, at: XY) => {
    const e = session.store.getState().edges.find((x) => x.id === edgeId);
    const a = flow.getNode(e?.from.node ?? '');
    const b = flow.getNode(e?.to.node ?? '');
    if (!e || !a || !b) return;
    const from = { x: a.position.x + (a.measured?.width ?? 240), y: a.position.y + (a.measured?.height ?? 200) / 2 };
    const to = { x: b.position.x, y: b.position.y + (b.measured?.height ?? 200) / 2 };
    commit([{ op: 'addReroute', edgeId, index: rerouteIndex(from, to, e.reroutes ?? [], at), position: { x: Math.round(at.x), y: Math.round(at.y) } }]);
  };

  const historyRows: HistoryRow[] = useMemo(() => {
    const live = (nodeId: string | undefined, row: HistoryRow): HistoryRow => {
      const n = graph.nodes.find((x) => x.id === nodeId);
      if (!n || row.status === 'done') return row;
      if (n.status === 'generating' || n.status === 'queued') return { ...row, status: 'running', progress: n.progress ?? 0 };
      if (n.status === 'failed') return { ...row, status: 'failed', refunded: n.refunded ?? row.credits };
      return { ...row, status: 'done' };
    };
    if (!isMockApi()) return (serverRuns ?? sessionRuns).map((r) => live(r.nodeId, r));
    return [...sessionRuns.map((r) => live(r.nodeId, r)), ...MOCK_RUNS.map((r) => live(r.nodeId, r))];
  }, [graph.nodes, sessionRuns, serverRuns]);

  const pickRefs = (items: RefItem[]) => {
    if (!promptNode) return;
    const label = { mine: 'Mine', team: 'Team', builtin: 'Built-in', public: 'Public' } as const;
    const refs = (Array.isArray(promptNode.params.refs) ? promptNode.params.refs : []) as string[];
    setRefRegistry((m) => ({
      ...m,
      ...Object.fromEntries(items.map((it) => [it.id, { id: it.id, name: it.name, source: label[it.source], tone: it.tone, letter: it.glyph.type === 'letter' ? it.glyph.letter : '' }])),
    }));
    const params: Record<string, unknown> = { refs: [...refs, ...items.map((it) => it.id).filter((id) => !refs.includes(id))] };
    if (pickerFromTyping.current) {
      // Typed `@`: the mention replaces it in the prompt.
      const prompt = typeof promptNode.params.prompt === 'string' ? promptNode.params.prompt : '';
      params.prompt = `${prompt.replace(/@$/, '')}${items.map((it) => `@[${it.name}]`).join(' ')} `;
    }
    pickerFromTyping.current = false;
    commit([{ op: 'updateNode', nodeId: promptNode.id, params }]);
    setOverlay(null);
  };

  /* ---------- Keyboard: undo / redo, bypass, node menu, duplicate ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (editorOpen) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z' && !e.shiftKey) {
        e.preventDefault();
        session.sync.undo();
      } else if (mod && ((k === 'z' && e.shiftKey) || k === 'y')) {
        e.preventDefault();
        session.sync.redo();
      } else if (mod && k === 'b' && selected) {
        e.preventDefault();
        toggleBypass(selected);
      } else if (mod && k === 'd' && selected) {
        e.preventDefault();
        duplicate(selected);
      } else if (selected && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
        e.preventDefault();
        const el = document.querySelector(`[data-testid="node-${selected}"]`)?.getBoundingClientRect();
        if (el) setMenu({ kind: 'node', id: selected, x: el.left + 12, y: el.top + 12 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, selected, toggleBypass, duplicate, editorOpen]);

  /* ---------- Menus ---------- */

  const menuEntries = (m: Menu): MenuEntry[] => {
    const n = graph.nodes.find((x) => x.id === m.id);
    if (m.kind === 'versions') {
      if (!n?.version) return [];
      return Array.from({ length: n.version.total }, (_, i) => i + 1).map((v) => ({
        key: `v${v}`,
        label: intl.formatMessage({ id: 'canvas.node.versionItem' }, { n: v }),
        meta: v === n.version!.total ? intl.formatMessage({ id: 'canvas.node.latest' }) : undefined,
        checked: v === n.version!.n,
        onSelect: () => {
          void setActiveVersion(projectId, n.id, v).then((ok) => {
            if (ok) toast.show({ message: intl.formatMessage({ id: 'canvas.toast.version' }, { title: n.title, n: v }) });
          });
        },
      }));
    }
    if (m.kind === 'edge') {
      return [
        { key: 'reroute', label: intl.formatMessage({ id: 'canvas.edge.addReroute' }), onSelect: () => addReroute(m.id, m.flow) },
        { key: 'disconnect', label: intl.formatMessage({ id: 'canvas.edge.disconnect' }), danger: true, onSelect: () => removeNodes([], [m.id]) },
      ];
    }
    if (!n) return [];
    const generative = n.kind === 'image' || n.kind === 'video' || n.kind === 'audio';
    const inputs = graph.edges.filter((e) => e.to.node === n.id);
    const cost = runCost(n);
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
    return [
      ...(generative
        ? [
            {
              key: 'run',
              label: intl.formatMessage({ id: 'canvas.node.menu.run' }),
              meta: cost !== undefined ? intl.formatMessage({ id: 'canvas.node.menu.credits' }, { n: cost }) : undefined,
              disabled: n.status === 'generating' || n.status === 'queued' || n.bypass,
              reason: intl.formatMessage({ id: n.bypass ? 'canvas.node.menu.bypassedReason' : 'canvas.node.menu.runningReason' }),
              onSelect: () => requestRun(n.id),
            },
            { key: 'upTo', label: intl.formatMessage({ id: 'canvas.node.menu.runUpTo' }), onSelect: () => requestRun(n.id, 'upTo') },
            { key: 'from', label: intl.formatMessage({ id: 'canvas.node.menu.runFrom' }), onSelect: () => requestRun(n.id, 'from') },
          ]
        : []),
      ...(n.version ? [{ key: 'result', label: intl.formatMessage({ id: 'canvas.node.menu.result' }), onSelect: () => setResultFor(n.id) }] : []),
      ...(n.kind === 'script' ? [{ key: 'script', label: intl.formatMessage({ id: 'canvas.node.fullScreen' }), onSelect: () => setOverlay('script') }] : []),
      { key: 'duplicate', label: intl.formatMessage({ id: 'canvas.node.menu.duplicate' }), meta: `${mod}D`, onSelect: () => duplicate(n.id) },
      {
        key: 'bypass',
        label: intl.formatMessage({ id: 'canvas.node.menu.bypass' }),
        kind: 'checkbox' as const,
        checked: !!n.bypass,
        meta: `${mod}B`,
        onSelect: () => toggleBypass(n.id),
      },
      { key: 'collapse', label: intl.formatMessage({ id: n.collapsed ? 'canvas.node.menu.expand' : 'canvas.node.menu.collapse' }), onSelect: () => toggleCollapsed(n.id) },
      ...(inputs.length
        ? [{ key: 'disconnect', label: intl.formatMessage({ id: 'canvas.node.menu.disconnect' }, { n: inputs.length }), onSelect: () => removeNodes([], inputs.map((e) => e.id)) }]
        : []),
      { key: 'delete', label: intl.formatMessage({ id: 'canvas.node.menu.delete' }), meta: intl.formatMessage({ id: 'canvas.node.menu.deleteKey' }), danger: true, onSelect: () => removeNodes([n.id], []) },
    ];
  };

  /* ---------- Result viewer ---------- */

  const resultNode = graph.nodes.find((n) => n.id === resultFor) ?? null;
  const lastResult = useRef(resultNode);
  if (resultNode) lastResult.current = resultNode;
  const shownResult = resultNode ?? lastResult.current;
  const resultMedia = shownResult ? session.sync.getMedia(shownResult.id) : undefined;

  const onResultAction = (id: ResultActionId) => {
    const n = shownResult;
    if (!n) return;
    if (id === 'edit') {
      setResultFor(null);
      selectNode(n.id, true);
    } else if (id === 'regenerate') {
      setResultFor(null);
      requestRun(n.id);
    } else if (id === 'download') {
      toast.show({ message: intl.formatMessage({ id: 'canvas.toast.download' }, { title: n.title }) });
      const assetId = session.sync.getMedia(n.id)?.assetId;
      if (!isMockApi() && assetId) {
        void downloadAsset(assetId, n.title).then(
          (ok) => !ok && toast.show({ message: intl.formatMessage({ id: 'canvas.toast.downloadFailed' }, { title: n.title }) }),
          () => toast.show({ message: intl.formatMessage({ id: 'canvas.toast.downloadFailed' }, { title: n.title }) }),
        );
      }
    }
  };

  const bg: CSSProperties = {
    backgroundPosition: `${viewport.x}px ${viewport.y}px`,
    backgroundSize: `${22 * viewport.zoom}px ${22 * viewport.zoom}px`,
  };

  const gateRows: RunPlanRow[] =
    gate?.type === 'confirm'
      ? gate.quote.items.flatMap((it) => {
          const n = graph.nodes.find((x) => x.id === it.nodeId);
          if (!n || it.action !== 'run') return [];
          return [{ id: it.nodeId, name: n.title, meta: planMeta(intl, n, it, models), kind: runKind(n.kind), state: 'run' as const, cost: it.credits, tone: typeof n.params.tone === 'string' ? n.params.tone : undefined }];
        })
      : [];

  return (
    <NodeActionsContext.Provider value={actions}>
      <EdgeActionsContext.Provider value={edgeActions}>
        <div ref={rootRef} className={canvas.flow} style={bg}>
          <ReactFlow<CardNode, WireEdge>
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            onDelete={onDelete}
            connectionLineComponent={ConnectionLine}
            onNodeContextMenu={(e, n) => {
              e.preventDefault();
              selectNode(n.id);
              setMenu({ kind: 'node', id: n.id, x: e.clientX, y: e.clientY });
            }}
            onEdgeContextMenu={(e, edge) => {
              e.preventDefault();
              setMenu({ kind: 'edge', id: edge.id, x: e.clientX, y: e.clientY, flow: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
            }}
            onEdgeDoubleClick={(e, edge) => {
              e.stopPropagation();
              addReroute(edge.id, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
            }}
            onPaneClick={(e) => {
              setSelected(null);
              setSelectedEdge(null);
              if (e.detail === 2) {
                const rect = rootRef.current!.getBoundingClientRect();
                setAddAt({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                setDropWire(null);
                setOverlay('addMenu');
              } else if (overlay === 'addMenu' || overlay === 'at') {
                close();
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
      </EdgeActionsContext.Provider>

      {promptPresence.mounted && lastPromptNode.current && lastPromptPos.current ? (
        <PromptPanel
          node={promptNode ?? lastPromptNode.current}
          left={(promptPos ?? lastPromptPos.current).left}
          top={(promptPos ?? lastPromptPos.current).top}
          state={promptPresence.state}
          refs={refsOf(promptNode ?? lastPromptNode.current)}
          pickerOpen={overlay === 'at'}
          onOpenPicker={(fromTyping) => {
            pickerFromTyping.current = !!fromTyping;
            setOverlay((o) => (o === 'at' && !fromTyping ? null : 'at'));
          }}
          onGenerate={(id) => requestRun(id)}
          models={models}
          plan={planId ?? PLAN_ORDER[0]!}
          onUpdate={(nodeId, params) => commit([{ op: 'updateNode', nodeId, params }])}
          onRemoveRef={(nodeId, index) => {
            const n = graph.nodes.find((x) => x.id === nodeId);
            const refs = (Array.isArray(n?.params.refs) ? n!.params.refs : []) as string[];
            commit([{ op: 'updateNode', nodeId, params: { refs: refs.filter((_, i) => i !== index) } }]);
          }}
        />
      ) : null}

      <div className={canvas.topLeft}>
        <Link to="/" className={canvas.logo} aria-label={intl.formatMessage({ id: 'canvas.backHome' })}>
          <CanvasLogo />
        </Link>
        {renaming ? (
          <ProjectRename
            title={project.title}
            onDone={(title) => {
              setRenaming(false);
              if (title === null || title === project.title) return;
              void renameProject(projectId, title).then((r) =>
                toast.show({ message: r.ok ? intl.formatMessage({ id: 'canvas.toast.renamed' }, { title: r.title }) : intl.formatMessage({ id: 'canvas.toast.renameEmpty' }) }),
              );
            }}
          />
        ) : (
          <MenuPopover
            open={projectMenu}
            onOpenChange={setProjectMenu}
            label={intl.formatMessage({ id: 'canvas.projectMenu' }, { title: project.title })}
            entries={[
              { key: 'rename', label: intl.formatMessage({ id: 'canvas.project.rename' }), onSelect: () => setRenaming(true) },
              { key: 'share', label: intl.formatMessage({ id: 'canvas.share' }), onSelect: () => setOverlay('share') },
              { key: 'edit', label: intl.formatMessage({ id: 'canvas.project.openEditor' }), onSelect: () => setOverlay('edit') },
              { key: 'history', label: intl.formatMessage({ id: 'canvas.tools.history' }), onSelect: () => setHistoryOpen(true) },
              { key: 'home', label: intl.formatMessage({ id: 'canvas.backHome' }), onSelect: () => void navigate({ to: '/' }) },
            ]}
            trigger={(t) => (
              <button {...t} type="button" className={canvas.project} aria-label={intl.formatMessage({ id: 'canvas.projectMenu' }, { title: project.title })}>
                {project.title}
                <CanvasIcon name="caret" size={12} strokeWidth={2.4} className={canvas.caret} />
              </button>
            )}
          />
        )}
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
          <CanvasIcon name="coin" size={15} stroke="var(--c-text-3)" />
          <span className={canvas.creditsValue} data-testid="credits-balance">
            {intl.formatNumber(credits.available)}
          </span>
          <span className={canvas.creditsPlus}>
            <CanvasIcon name="plus" size={13} strokeWidth={2.2} stroke="var(--c-text-1)" />
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
          onClick={() => {
            setPlanScope({ scope: 'all' });
            setOverlay('plan');
          }}
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
        {creditsP.mounted ? <CreditsPopover state={creditsP.state} onClose={() => setCreditsOpen(false)} credits={credits} /> : null}
      </div>

      <div role="toolbar" aria-label={intl.formatMessage({ id: 'canvas.tools.label' })} aria-orientation="vertical" className={canvas.toolbar}>
        {TOOLS.map((t) => {
          const label = intl.formatMessage({ id: t.label });
          const soon = t.key === 'dir';
          return (
            <button
              key={t.key}
              type="button"
              className={canvas.tool}
              aria-label={label}
              title={soon ? intl.formatMessage({ id: 'canvas.tools.directorSoon' }) : label}
              aria-pressed={soon ? undefined : toolPressed(t.key)}
              aria-disabled={soon || undefined}
              onClick={() => pickTool(t.key)}
            >
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
          <MenuPopover
            open={zoomMenu}
            onOpenChange={setZoomMenu}
            label={intl.formatMessage({ id: 'canvas.zoomMenu' })}
            side="top"
            entries={[
              ...ZOOM_PRESETS.map((z) => ({
                key: String(z),
                label: intl.formatMessage({ id: 'canvas.zoom' }, { zoom: z }),
                checked: Math.abs(viewport.zoom - z) < 0.005,
                onSelect: () => void flow.zoomTo(z, { duration: 200 }),
              })),
              { key: 'fit', label: intl.formatMessage({ id: 'canvas.fitAll' }), onSelect: () => void flow.fitView({ duration: 320, padding: 0.15 }) },
            ]}
            trigger={(t) => (
              <button {...t} type="button" className={cx(canvas.zoomValue, canvas.zoomValueBtn)} data-testid="zoom-value" aria-label={intl.formatMessage({ id: 'canvas.zoomLabel' }, { zoom: viewport.zoom })}>
                <FormattedMessage id="canvas.zoom" values={{ zoom: viewport.zoom }} />
              </button>
            )}
          />
          <button type="button" className={canvas.zoomBtn} aria-label={intl.formatMessage({ id: 'canvas.zoomIn' })} onClick={() => flow.zoomIn({ duration: 200 })}>
            <CanvasIcon name="plus" size={16} />
          </button>
          <button type="button" className={canvas.fit} onClick={() => flow.fitView({ duration: 320, padding: 0.15 })}>
            <FormattedMessage id="canvas.fit" />
          </button>
        </div>
      </div>

      {agentP.mounted ? (
        <AgentPanel
          state={agentP.state}
          onClose={() => setAgentOpen(false)}
          onBuild={buildPlan}
          isMember={isMember}
          onApplyProposal={applyProposal}
          onPreview={setProposed}
          projectId={projectId}
          selection={selected ? [selected] : undefined}
          nodes={graph.nodes}
        />
      ) : null}

      {historyP.mounted ? <HistoryDrawer state={historyP.state} onClose={() => setHistoryOpen(false)} rows={historyRows} onOpen={(id) => selectNode(id, true)} /> : null}

      {templatesP.mounted ? <TemplatesPanel state={templatesP.state} onClose={() => setToolPanel(null)} onUse={useTemplate} /> : null}

      {assetsP.mounted ? (
        <div className={cx(canvas.assetPanel, 'rl-pop')} {...presenceProps(assetsP.state)} data-testid="assets-panel">
          <ReferencePicker autoFocus onAdd={addAssets} onClose={() => setToolPanel(null)} />
        </div>
      ) : null}

      {atP.mounted && lastPromptPos.current ? (
        <div className={cx(canvas.picker, 'rl-pop')} style={{ left: lastPromptPos.current.left, top: lastPromptPos.current.top + 68 }} {...presenceProps(atP.state)}>
          <ReferencePicker
            initialSelected={[]}
            attachedIds={promptNode && Array.isArray(promptNode.params.refs) ? (promptNode.params.refs as string[]) : []}
            onAdd={pickRefs}
            onClose={() => {
              pickerFromTyping.current = false;
              close();
            }}
          />
        </div>
      ) : null}

      {addP.mounted ? (
        <AddNodeMenu
          state={addP.state}
          onClose={close}
          x={addAt.x}
          y={addAt.y}
          suggested={dropWire ? null : (selectedNode?.kind ?? null)}
          onPick={addFromMenu}
          onSoon={(key) => toast.show({ message: intl.formatMessage({ id: `canvas.add.soonReason.${key}` }) })}
          accept={dropWire ? { kinds: acceptingKinds(dropWire.type, dropWire.from), resources: dropWire.type === 'image' || dropWire.type === 'audio' ? (dropWire.from === 'in' ? [dropWire.type] : []) : [] } : null}
        />
      ) : null}

      {scriptP.mounted ? (
        <ScriptDialog
          state={scriptP.state}
          onClose={close}
          title={scriptNode?.title ?? ''}
          version={String(scriptNode?.params.versionLabel ?? '')}
          rows={scriptRows ?? SCRIPT_ROWS}
          onChange={saveScript}
          onGenerate={(rows) => generateStoryboard(rows, scriptNode?.id)}
          initialMenu={scriptMenu}
        />
      ) : null}

      {editorOpen ? (
        renderEditor ? (
          renderEditor({
            projectId,
            withProposal: overlay === 'editAgent',
            onClose: close,
            onOpenOnCanvas: (nodeId) => {
              close();
              if (graph.nodes.some((n) => n.id === nodeId)) selectNode(nodeId, true);
              else toast.show({ message: intl.formatMessage({ id: 'canvas.toast.notOnCanvas' }) });
            },
          })
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
          share={share}
          busy={shareBusy}
          onCopy={() => {
            const url = `https://${share.url}`;
            const done = () => toast.show({ message: intl.formatMessage({ id: 'canvas.shareDialog.copied' }) });
            const failed = () => toast.show({ message: intl.formatMessage({ id: 'canvas.shareDialog.copyFailed' }, { url }) });
            if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(url).then(done, failed);
            else failed();
          }}
          onUpdate={(patch) => void updateShare(projectId, patch)}
          onStop={() => {
            setShareBusy(true);
            void stopSharing(projectId).then(() => {
              setShareBusy(false);
              toast.show({
                message: intl.formatMessage({ id: 'canvas.toast.shareStopped' }),
                action: { label: intl.formatMessage({ id: 'canvas.shareDialog.shareAgain' }), onAction: () => void publishShare(projectId) },
              });
            });
          }}
          onPublish={() => {
            setShareBusy(true);
            const wasActive = share.active;
            void publishShare(projectId).then(() => {
              setShareBusy(false);
              toast.show({ message: intl.formatMessage({ id: wasActive ? 'canvas.toast.snapshotPublished' : 'canvas.toast.shareOn' }) });
            });
          }}
        />
      ) : null}

      {planP.mounted ? (
        <PlanDialog
          state={planP.state}
          onClose={close}
          rows={planRows}
          balance={planQuote && !isMockApi() ? planQuote.balance : credits.available}
          onConfirm={() => {
            close();
            if (planQuote) executeRun(planQuote, planRequest);
          }}
        />
      ) : null}

      <RunConfirm
        open={gate?.type === 'confirm'}
        onOpenChange={(o) => !o && setGate(null)}
        variant="single"
        rows={gateRows}
        balance={credits.available}
        eta={intl.formatMessage({ id: 'canvas.plan.etaSingle' })}
        subtitle={gateRows[0]?.meta}
        actionLabel={intl.formatMessage({ id: 'canvas.run.action' })}
        onConfirm={() => gate?.type === 'confirm' && executeRun(gate.quote, gate.request)}
      />
      <Paywall
        open={gate?.type === 'join'}
        onOpenChange={(o) => !o && setGate(null)}
        variant="join"
        onContinue={(option: PaywallOption) => {
          const request = gate?.type === 'join' ? gate.request : null;
          void checkoutPlan(option.id).then(() => {
            setGate(null);
            takePendingAction('canvas.run');
            // The run resumes after checkout: re-quoted (prices may have changed) and confirmed per threshold.
            if (request) window.setTimeout(() => runRequestRef.current(request), 0);
          });
        }}
      />
      <Paywall
        open={gate?.type === 'credits'}
        onOpenChange={(o) => !o && setGate(null)}
        variant="credits"
        runCost={gate?.type === 'credits' ? gate.total : undefined}
        balance={credits.available}
        plan={planId}
        onContinue={(option: PaywallOption) => {
          const request = gate?.type === 'credits' ? gate.request : null;
          const usd = typeof option.amountUsd === 'number' ? option.amountUsd : Number(/^topup_(\d+(?:\.\d+)?)$/.exec(option.id)?.[1] ?? 0);
          void topUp(usd).then(
            () => {
              setGate(null);
              if (request) window.setTimeout(() => runRequestRef.current(request), 50);
            },
            () => toast.show({ message: intl.formatMessage({ id: 'canvas.toast.topUpFailed' }) }),
          );
        }}
      />

      {shownResult?.version ? (
        <ResultViewer
          open={!!resultNode}
          onOpenChange={(o) => !o && setResultFor(null)}
          title={shownResult.title}
          author={intl.formatMessage({ id: 'canvas.result.author' })}
          createdAt={new Date()}
          aspectRatio={String(shownResult.params.ratio ?? '9:16').replace(':', '/')}
          mediaKind={shownResult.kind === 'video' ? 'video' : 'image'}
          versions={Array.from({ length: shownResult.version.total }, (_, i) => ({ id: `v${i + 1}`, label: `v${i + 1}`, tone: typeof shownResult.params.tone === 'string' ? shownResult.params.tone : undefined }))}
          versionId={`v${shownResult.version.n}`}
          currentVersionId={`v${shownResult.version.n}`}
          onVersionChange={(id) => void setActiveVersion(projectId, shownResult.id, Number(id.slice(1)))}
          src={resultMedia?.assetId ? assetMediaUrl(resultMedia.assetId) : undefined}
          durationSec={typeof shownResult.params.seconds === 'number' ? shownResult.params.seconds : undefined}
          prompt={String(shownResult.params.prompt ?? '').replace(/@\[([^\]]+)\]/g, '@$1')}
          params={[
            { label: intl.formatMessage({ id: 'canvas.result.model' }), value: modelLabel(models, shownResult.params.model) },
            { label: intl.formatMessage({ id: 'canvas.result.format' }), value: formatLabel(shownResult) },
          ]}
          assets={refsOf(shownResult).map((r) => ({ id: r.id, name: r.name, tone: r.tone }))}
          actions={[{ id: 'edit' }, { id: 'regenerate', cost: runCost(shownResult) }, { id: 'download' }]}
          onAction={onResultAction}
        />
      ) : null}

      {menuP.mounted && lastMenu.current ? (
        <PointMenu
          state={menuP.state}
          x={lastMenu.current.x}
          y={lastMenu.current.y}
          label={intl.formatMessage({ id: `canvas.menu.${lastMenu.current.kind}` })}
          entries={menuEntries(lastMenu.current)}
          onClose={() => setMenu(null)}
          testId={`menu-${lastMenu.current.kind}`}
        />
      ) : null}
    </NodeActionsContext.Provider>
  );
}

/**
 * New nodes store gateway model ids (D-009) when the catalog knows the
 * default's display name (or offers a default for the kind); mock mode keeps
 * the design's display names.
 */
function withCatalogModel(params: Record<string, unknown>, kind: NodeKind, models: CatalogModel[] | undefined): Record<string, unknown> {
  if (isMockApi() || !models?.length || (kind !== 'image' && kind !== 'video')) return params;
  const byName = models.find((m) => m.kind === kind && m.name === params.model);
  const fallback = models.find((m) => m.kind === kind && m.default && !m.hidden);
  const id = byName?.id ?? fallback?.id;
  return id ? { ...params, model: id } : params;
}

/** Result thumbnail of a node's active version (real mode: signed redirect per asset). */
function mediaUrlOf(session: ProjectSession, nodeId: string): string | null {
  if (isMockApi()) return null;
  const node = session.store.getState().nodes.find((n) => n.id === nodeId);
  if (node?.kind === 'asset' && typeof node.params.assetId === 'string') return assetMediaUrl(node.params.assetId);
  const m = session.sync.getMedia(nodeId);
  return m?.assetId ? assetMediaUrl(m.assetId) : null;
}

/** The resume path after checkout or a top-up needs the latest `executeRun`. */
const executeRunRef: { current: (quote: Quote, request: QuoteRequest, attempt?: number) => void } = { current: () => {} };
const runRequestRef: { current: (request: QuoteRequest) => void } = { current: () => {} };

/**
 * The plan dialog's quote: the local planner in mock mode (synchronous, for
 * the fidelity specs), `POST /api/runs/quote` in real mode — re-quoted when
 * the graph changes while the dialog is open.
 */
function usePlanQuote(projectId: string, open: boolean, request: QuoteRequest, graph: GraphState): Quote | null {
  const mock = isMockApi();
  const local = useMemo(() => {
    if (!mock) return null;
    const q = request.scope === 'all' ? quoteRun(graph.nodes, graph.edges) : quoteRun(graph.nodes, graph.edges, request.nodeIds, request.scope);
    return { ...q, balance: q.balanceAfter + q.total, expiresAt: null, confirmThreshold: getPrefs().confirmThreshold, needsConfirm: true } satisfies Quote;
  }, [mock, graph.nodes, graph.edges, request]);
  const [remote, setRemote] = useState<Quote | null>(null);
  const revision = graph.revision;
  useEffect(() => {
    if (mock || !open) return;
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      requestQuote(projectId, request, graph, ctl.signal).then(setRemote, () => {});
    }, 250);
    return () => {
      ctl.abort();
      window.clearTimeout(t);
    };
    // Re-quote on a new revision or scope, not on every runtime tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mock, open, projectId, request, revision]);
  return mock ? local : remote;
}

/** Why a quote has nothing to run for the node (quote codes, D-005 safety codes, plan caps). */
function quoteBlockText(intl: ReturnType<typeof useIntl>, item: QuoteItem | undefined, title: string): string {
  if (!item) return intl.formatMessage({ id: 'canvas.toast.nothingToRun' }, { title });
  if (item.action === 'bypassed') return intl.formatMessage({ id: 'canvas.toast.bypassedRun' }, { title });
  if (item.action === 'reuse') return intl.formatMessage({ id: 'canvas.toast.reuse' }, { title });
  if (item.action === 'blocked') return quoteCodeText(intl, item) ?? intl.formatMessage({ id: 'canvas.toast.nothingToRun' }, { title });
  return intl.formatMessage({ id: 'canvas.toast.nothingToRun' }, { title });
}

const QUOTE_CODES = new Set(['missing_input', 'upstream_blocked', 'bypassed_input', 'unknown_model', 'no_capable_model', 'unsupported', 'unpriced', 'resolution_locked', 'mature_not_allowed', 'identity_requires_platform_assets', 'empty_prompt', 'SAFETY_BLOCKED', 'MATURE_REQUIRED', 'SAFETY_REVIEW', 'NO_PLAN']);

/** Copy for a blocked quote row: mapped by `code` (plan cap names the plan), else the API's English `reason`. */
export function quoteCodeText(intl: ReturnType<typeof useIntl>, item: Pick<QuoteItem, 'code' | 'reason' | 'lowestPlan'>): string | undefined {
  if (item.code && QUOTE_CODES.has(item.code)) {
    const plan = item.lowestPlan ? (PLAN_LABELS[item.lowestPlan] ?? item.lowestPlan) : '';
    return intl.formatMessage({ id: `canvas.quote.code.${item.code}`, defaultMessage: item.reason ?? item.code }, { plan, reason: item.reason ?? '' });
  }
  return item.reason;
}

const PLAN_LABELS: Record<string, string> = { starter: 'Starter', plus: 'Plus', pro: 'Pro', team: 'Team' };

function ProjectRename({ title, onDone }: { title: string; onDone: (title: string | null) => void }) {
  const intl = useIntl();
  const [value, setValue] = useState(title);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className={canvas.projectInput}
      aria-label={intl.formatMessage({ id: 'canvas.project.renameLabel' })}
      value={value}
      maxLength={120}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value)}
      onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') onDone(value);
        else if (e.key === 'Escape') {
          e.stopPropagation();
          onDone(null);
        }
      }}
    />
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

/** Minimap: click or drag to move the view there; arrow keys pan (Shift for bigger steps). */
function Minimap({ graph, rfNodes, selected, size }: { graph: GraphState; rfNodes: CardNode[]; selected: string | null; size: { w: number; h: number } }) {
  const intl = useIntl();
  const flow = useReactFlow();
  const viewport = useViewport();
  const [drag, setDrag] = useState(false);
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
  // While dragging, the mapping stays the one from pointer down so the view follows the pointer.
  const frozen = useRef<{ minX: number; minY: number; s: number; ox: number; oy: number } | null>(null);
  const centerAt = (clientX: number, clientY: number, rect: DOMRect, animate: boolean) => {
    const m = frozen.current ?? { minX, minY, s, ox, oy };
    const fx = m.minX + (clientX - rect.left - m.ox) / m.s;
    const fy = m.minY + (clientY - rect.top - m.oy) / m.s;
    void flow.setCenter(fx, fy, { zoom: viewport.zoom, duration: animate ? 320 : 0 });
  };
  return (
    <div
      aria-label={intl.formatMessage({ id: 'canvas.minimap' })}
      aria-description={intl.formatMessage({ id: 'canvas.minimapHint' })}
      role="application"
      tabIndex={0}
      className={canvas.minimap}
      data-count={graph.nodes.length}
      data-dragging={drag ? '' : undefined}
      data-testid="minimap"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        frozen.current = { minX, minY, s, ox, oy };
        setDrag(true);
        centerAt(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), true);
      }}
      onPointerMove={(e) => {
        if (drag) centerAt(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), false);
      }}
      onPointerUp={() => {
        frozen.current = null;
        setDrag(false);
      }}
      onKeyDown={(e) => {
        const step = (e.shiftKey ? 240 : 60) * viewport.zoom;
        const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
        if (!d) return;
        e.preventDefault();
        void flow.setViewport({ x: viewport.x + d[0]!, y: viewport.y + d[1]!, zoom: viewport.zoom }, { duration: 140 });
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
