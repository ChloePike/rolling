import { Skeleton, useToast } from '@rolling/ui';
import { useRunFlow } from '@/features/overlays';
import { UpgradeGate } from '@/lib/upgrade/store';
import { checkoutPlan, getSession, useCheckoutResume } from '@/lib/session';
import { useModels } from '@/lib/models';
import { MenuPopover, type MenuEntry } from '../layers/Menu';
import { catalogCredits, findModel } from '../pricing';
import { ExportDialog } from './ExportDialog';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import { useIntl } from 'react-intl';
import { agentFailure, applyEditProposal, EditorAgentReply, getEditorProject, mockRun, proposeEdit, quoteNode, reassemble, type EditorProjectReal, type RunOutcome, type RunRequest } from './api';
import { assetMediaUrl, isMockApi, savePendingAction, takePendingAction } from '@/features/overlays/backend';
import { discardProposal } from '@/features/overlays/agent';
import { subscribeProjectMessages } from '../api';
import { fetchTimeline, transitionOps, TimelineSync } from './realTimeline';
import type { TimelineOp } from '@rolling/core/timeline';
import { Bin } from './Bin';
import styles from './Editor.module.css';
import { Icon } from './icons';
import { Inspector } from './Inspector';
import type { BinItem, EditorProject } from './mocks';
import { Monitor } from './Monitor';
import { editPoints } from './playback';
import { PlayheadStore } from './playhead';
import { useReducedMotion } from './presence';
import { ProposalCard } from './ProposalCard';
import { initEditorState, makeReducer, type Tool } from './state';
import { TimelinePanel } from './TimelinePanel';
import { clampScroll, clampPps } from '@rolling/core/timeline';
import { formatTimecode, snapToFrame } from '@rolling/core/timeline';
import { clipEnd, edlDuration, findClip, isCaptionClip, nextClipId, type Clip, type Edl, type MediaClip, type Track } from '@rolling/core/timeline';
import type { GraphNode } from '@rolling/core/graph';
import type { BinInsert } from './Bin';

/** Output formats offered by the format menu. */
const FORMATS = [
  { key: '9:16', width: 1080, height: 1920 },
  { key: '16:9', width: 1920, height: 1080 },
  { key: '1:1', width: 1080, height: 1080 },
  { key: '4:5', width: 1080, height: 1350 },
] as const;
const FPS = [24, 25, 30] as const;

export interface EditorProps {
  projectId: string;
  /** Sends this edit request to the agent as soon as the editor opens (CanvasEditAgent state). */
  initialAsk?: string;
  /** Called after the close transition. */
  onClose?: () => void;
  onOpenOnCanvas?: (nodeId: string) => void;
  /**
   * Generate or regenerate a shot. The canvas passes its RunConfirm flow here;
   * without it the editor uses a mock run.
   */
  onRequestRun?: (run: RunRequest) => Promise<RunOutcome>;
  onExport?: (edl: Edl) => void;
}

/** Editor overlay: bin, program monitor, inspector and the canvas-drawn timeline. */
export function Editor(props: EditorProps) {
  const { data: project } = useQuery({
    queryKey: ['editor', props.projectId],
    queryFn: () => getEditorProject(props.projectId),
    staleTime: Infinity,
  });
  if (!project) return <EditorSkeleton />;
  return <EditorLoaded {...props} project={project} />;
}

/** The editor's regions while the project loads: top bar, bin, monitor, inspector and timeline, sized like the loaded editor. */
function EditorSkeleton() {
  const intl = useIntl();
  return (
    <div className={styles.root} data-shown="true" aria-busy="true" aria-label={intl.formatMessage({ id: 'editor.label' })} data-testid="editor-skeleton">
      <div className={styles.topbar}>
        <Skeleton width={64} height={20} />
        <Skeleton width={180} height={14} />
        <span className={styles.spacer} />
        <Skeleton width={90} height={30} />
      </div>
      <div className={styles.body}>
        <div className={styles.bin} style={{ padding: 8, gap: 8 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} height={36} />
          ))}
        </div>
        <div className={styles.monitor}>
          <div className={styles.stage}>
            <Skeleton width="38%" height="100%" radius={2} />
          </div>
        </div>
        <div className={styles.inspector} style={{ padding: 12, gap: 10 }}>
          <Skeleton text width="60%" height={14} />
          <Skeleton height={120} />
          <Skeleton text width="80%" height={12} />
        </div>
      </div>
      <div className={styles.timeline} style={{ padding: 12, gap: 8 }}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={30} width={`${90 - i * 12}%`} />
        ))}
      </div>
    </div>
  );
}

const CLOSE_MS = 200;
const TOOL_KEYS: Record<string, Tool> = { v: 'select', c: 'razor', y: 'slip', t: 'text', h: 'hand' };

function EditorLoaded({ project, initialAsk, onClose, onOpenOnCanvas, onRequestRun, onExport }: EditorProps & { project: EditorProject }) {
  const intl = useIntl();
  const toast = useToast();
  const reducedMotion = useReducedMotion();
  const t = (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values);

  const sourceDuration = useCallback(
    (clip: MediaClip) => {
      if (clip.assetId && project.audio[clip.assetId]) return project.audio[clip.assetId]!.seconds;
      return clip.nodeId ? project.shots[clip.nodeId]?.seconds : undefined;
    },
    [project],
  );
  const reducer = useMemo(() => makeReducer({ sourceDuration }), [sourceDuration]);
  const [state, rawDispatch] = useReducer(reducer, project, (p) => initEditorState(p.edl, p.marks, p.view.selection));

  /* ---------- Real mode: mirror committed changes to the ProjectRoom timeline ---------- */
  const real = !isMockApi() && 'canvasId' in project;
  const [tsync] = useState(() => (real ? new TimelineSync((project as EditorProjectReal).canvasId, (project as EditorProjectReal).revision) : null));
  /** Ops of the commit being dispatched (sent once the reducer accepted it). */
  const commitOps = useRef<TimelineOp[] | null>(null);
  /** The next change came from the server: don't send it back. */
  const fromServer = useRef(false);
  const syncedEdl = useRef<Edl>(project.edl);
  const dispatch = useCallback((action: Parameters<typeof rawDispatch>[0]) => {
    commitOps.current = action.type === 'commit' ? action.ops : null;
    rawDispatch(action);
  }, []);
  const resetFromServer = useCallback((edl: Edl) => {
    fromServer.current = true;
    rawDispatch({ type: 'reset', edl });
  }, []);
  const [playhead] = useState(() => new PlayheadStore(project.view.playhead, edlDuration(project.edl)));
  const [ask, setAsk] = useState(initialAsk ?? '');
  const [shown, setShown] = useState(false);
  const [closing, setClosing] = useState(false);
  const [focusCaption, setFocusCaption] = useState(0);
  const [focusProposal, setFocusProposal] = useState(false);
  const gainSession = useRef(0);
  const [formatOpen, setFormatOpen] = useState(false);
  const [effectsOpen, setEffectsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const runFlow = useRunFlow();
  const { data: catalog } = useModels('video');

  /**
   * Credits for a shot: the synced catalog at its model, resolution and length (D-006), or the shot's quoted price.
   * 0 means not priced yet: labels then show no number (a run never costs 0); the run flow quotes it for real.
   */
  const shotCredits = useCallback(
    (nodeId: string | undefined) => {
      const shot = nodeId ? project.shots[nodeId] : undefined;
      if (!shot) return 0;
      const node = { kind: 'video', params: { model: shot.model, resolution: shot.resolution, length: shot.seconds } } as unknown as GraphNode;
      const model = findModel(catalog, node);
      const priced = model ? catalogCredits(model, node) : null;
      return priced && priced > 0 ? priced : shot.credits > 0 ? shot.credits : 0;
    },
    [catalog, project.shots],
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!tsync) return;
    const prev = syncedEdl.current;
    const next = state.edl;
    if (prev === next) return;
    syncedEdl.current = next;
    if (fromServer.current) {
      fromServer.current = false;
      commitOps.current = null;
      return;
    }
    const committed = commitOps.current;
    commitOps.current = null;
    // Commits carry their ops (the server takes every op the editor applies); undo/redo/reset send a diff or the whole cut.
    const ops = committed ?? transitionOps(prev, next);
    void tsync.push(ops).then((outcome) => {
      if (outcome === 'synced') return;
      if (outcome === 'offline') return void toast.show({ message: t('editor.sync.offline') });
      // Conflict or refusal: the server's timeline wins.
      toast.show({ message: t(outcome === 'conflict' ? 'editor.sync.conflict' : 'editor.sync.refused') });
      void fetchTimeline(tsync.canvasId).then((tl) => {
        tsync.revision = tl.revision;
        resetFromServer(tl.edl);
      });
    });
    // Runs per timeline change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.change.version]);

  /**
   * A shot's new version arrived: the clip keeps its place, trims and effects;
   * only its shot reference changes (`replaceShot`, saved like any edit).
   */
  const replaceClipShot = useCallback(
    (clipId: string, nodeId: string, assetId: string) => {
      const current = findClip(stateRef.current.edl, clipId)?.clip as MediaClip | undefined;
      if (current && current.assetId !== assetId) {
        if (project.mediaUrls && !project.mediaUrls[assetId]) project.mediaUrls[assetId] = assetMediaUrl(assetId);
        dispatch({ type: 'commit', ops: [{ op: 'replaceShot', clipId, nodeId, assetId }], animate: false });
      }
      if (stateRef.current.running.includes(clipId)) dispatch({ type: 'running', clipId, on: false });
    },
    // stateRef and dispatch are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project],
  );

  // Edits from other tabs and people (`timeline.patched` on the project channel), and shots
  // generating from here (`node.version` / `job.failed` for a clip that is running).
  useEffect(() => {
    if (!tsync) return;
    return subscribeProjectMessages(project.id, (msg) => {
      if (msg.type === 'node.version' || msg.type === 'job.failed') {
        const p = msg.payload as { nodeId?: string; version?: { assetId?: string | null; active?: boolean } | null };
        const running = stateRef.current.running.filter((id) => (findClip(stateRef.current.edl, id)?.clip as MediaClip | undefined)?.nodeId === p.nodeId);
        for (const clipId of running) {
          if (msg.type === 'job.failed') dispatch({ type: 'running', clipId, on: false });
          else if (p.version?.assetId && p.version.active !== false) replaceClipShot(clipId, p.nodeId!, p.version.assetId);
        }
        return;
      }
      if (msg.type !== 'timeline.patched') return;
      const p = msg.payload as { canvasId: string; revision: number; edl?: Edl };
      if (p.canvasId !== tsync.canvasId || p.revision <= tsync.revision || tsync.busy) return;
      void fetchTimeline(tsync.canvasId).then((tl) => {
        if (tl.revision <= tsync.revision) return;
        tsync.revision = tl.revision;
        resetFromServer(tl.edl);
      });
    });
  }, [tsync, project.id, resetFromServer, replaceClipShot, dispatch]);

  useEffect(() => () => playhead.dispose(), [playhead]);
  useEffect(() => playhead.setDuration(edlDuration(state.edl)), [playhead, state.edl]);

  // Take keyboard focus so editor shortcuts work right away.
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  // Panel enter: 320ms, standard curve, 8px rise (opacity only with reduced motion).
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setShown(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  const close = useCallback(() => {
    playhead.pause();
    setClosing(true);
    setTimeout(() => onClose?.(), CLOSE_MS);
  }, [onClose, playhead]);

  const askAgent = useCallback(
    async (request: string, fromUser: boolean) => {
      dispatch({ type: 'proposalPending' });
      let proposal: Awaited<ReturnType<typeof proposeEdit>> = null;
      try {
        proposal = await proposeEdit(project, stateRef.current.edl, request);
      } catch (e) {
        dispatch({ type: 'proposal', proposal: null });
        if (e instanceof EditorAgentReply) return void toast.show({ message: e.text });
        const f = agentFailure(e);
        if (f.kind === 'join') {
          // D-007: keep the request; it is asked again after checkout (also after the Stripe redirect).
          savePendingAction('editor.ask', { projectId: project.id, request });
          setJoinOpen(true);
          return void toast.show({ message: t('editor.agent.join') });
        }
        if (f.kind === 'allowance') return void toast.show({ message: t('editor.agent.allowance') });
        return void toast.show({ message: t('editor.proposal.failed') });
      }
      setFocusProposal(fromUser);
      dispatch({ type: 'proposal', proposal });
      if (!proposal) toast.show({ message: t('editor.proposal.failed') });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project],
  );

  // The ask interrupted by the join paywall continues once the plan is active.
  const [joinOpen, setJoinOpen] = useState(false);
  const resumeAsk = useCallback(() => {
    const pending = takePendingAction<{ projectId: string; request: string }>('editor.ask', (d) => d.projectId === project.id);
    if (pending) void askAgent(pending.request, true);
  }, [project.id, askAgent]);
  useCheckoutResume(() => {
    if (!isMockApi()) resumeAsk();
  });
  useEffect(() => {
    // Opened by the canvas after the checkout return: ask right away when the plan is already active.
    if (!isMockApi() && getSession().isMember) resumeAsk();
    // Once per editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const asked = useRef(false);
  useEffect(() => {
    if (initialAsk && !asked.current) {
      asked.current = true;
      void askAgent(initialAsk, false);
    }
  }, [initialAsk, askAgent]);

  const undo = useCallback(() => dispatch({ type: 'undo' }), []);

  const apply = () => {
    const p = state.proposal;
    if (!p) return;
    if (tsync) {
      // The server applies exactly the proposed ops as the user; the editor shows the resulting EDL.
      dispatch({ type: 'proposalClose' });
      setAsk('');
      void applyEditProposal(project.id, p.id).then(
        (edl) => {
          void fetchTimeline(tsync.canvasId).then((tl) => (tsync.revision = Math.max(tsync.revision, tl.revision)));
          resetFromServer(edl);
          toast.show({ message: t('editor.proposal.applied'), action: { label: t('editor.undoAction'), onAction: undo } });
        },
        () => toast.show({ message: t('editor.proposal.stale') }),
      );
      return;
    }
    dispatch({ type: 'commit', ops: p.ops, animate: true });
    dispatch({ type: 'proposalClose' });
    setAsk('');
    toast.show({ message: t('editor.proposal.applied'), action: { label: t('editor.undoAction'), onAction: undo } });
  };
  const discard = () => {
    const id = state.proposal?.id;
    dispatch({ type: 'proposalClose' });
    if (tsync && id) void discardProposal(id).catch(() => {});
  };

  /**
   * Generate / Regenerate through the shared run flow (features/overlays
   * useRunFlow): join paywall without a plan (D-007), top-up when short,
   * RunConfirm at or over the threshold (D-006), toasts. A host can take over
   * with `onRequestRun` (the canvas run pipeline).
   */
  const requestRun = (clipId: string) => {
    const clip = findClip(state.edl, clipId)?.clip as MediaClip | undefined;
    if (!clip?.nodeId || state.running.includes(clipId)) return;
    if (onRequestRun) return void run(clipId);
    const nodeId = clip.nodeId;
    const shot = project.shots[nodeId];
    const regenerate = clip.assetId !== null;
    runFlow.request({
      cost: shotCredits(nodeId),
      kind: 'video',
      actionLabel: t(regenerate ? 'editor.run.action' : 'editor.run.generateAction'),
      meta: shot ? t('editor.inspector.shotMeta', { model: shot.model, resolution: shot.resolution, seconds: shot.seconds }) : '',
      // Real mode: the shot's canvas node runs in place (`scope: 'node'`); the clip updates on `node.version`.
      ...(tsync
        ? {
            projectId: project.id,
            quote: () => quoteNode(project.id, nodeId),
            onStarted: () => dispatch({ type: 'running', clipId, on: true }),
            onFailed: () => dispatch({ type: 'running', clipId, on: false }),
          }
        : {}),
      onDone: (r) => {
        // Regenerate keeps the clip's place, trims and effects: only the shot reference changes.
        if (tsync) {
          if (r.assetId) replaceClipShot(clipId, nodeId, r.assetId);
          else dispatch({ type: 'running', clipId, on: false });
          return;
        }
        dispatch({ type: 'commit', ops: [{ op: 'replaceShot', clipId, nodeId, assetId: `ast_${nodeId.replace(/^node_/, '')}_${r.id}` }], animate: false });
      },
    });
  };

  const run = async (clipId: string) => {
    const ref = findClip(stateRef.current.edl, clipId);
    const clip = ref?.clip as MediaClip | undefined;
    if (!clip?.nodeId || stateRef.current.running.includes(clipId)) return;
    const request: RunRequest = {
      kind: clip.assetId === null ? 'generate' : 'regenerate',
      clipId,
      nodeId: clip.nodeId,
      credits: shotCredits(clip.nodeId),
    };
    dispatch({ type: 'running', clipId, on: true });
    try {
      const outcome = await (onRequestRun ?? mockRun)(request);
      if (outcome.status === 'done') {
        // Regenerate keeps the clip's place, trims and effects: only the shot reference changes.
        dispatch({ type: 'commit', ops: [{ op: 'replaceShot', clipId, nodeId: outcome.nodeId, assetId: outcome.assetId }], animate: false });
      }
    } finally {
      dispatch({ type: 'running', clipId, on: false });
    }
  };

  const clipName = useCallback(
    (clip: Clip, _track: Track) => {
      if (isCaptionClip(clip)) return clip.text;
      if (clip.nodeId && project.shots[clip.nodeId]) return project.shots[clip.nodeId]!.title;
      if (clip.assetId && project.audio[clip.assetId]) return project.audio[clip.assetId]!.title;
      return clip.id;
    },
    [project],
  );

  const selected = state.selection ? findClip(state.edl, state.selection) : null;
  const binCurrent = useMemo(() => {
    const c = selected?.clip;
    if (!c || isCaptionClip(c)) return null;
    return project.bin.find((b) => (c.nodeId && b.nodeId === c.nodeId) || (c.assetId && b.assetId === c.assetId))?.id ?? null;
  }, [selected, project.bin]);

  const pickBin = (item: BinItem) => {
    for (const track of state.edl.tracks) {
      for (const c of track.clips as Clip[]) {
        if (isCaptionClip(c)) continue;
        if ((item.nodeId && c.nodeId === item.nodeId) || (item.assetId && c.assetId === item.assetId)) {
          dispatch({ type: 'select', clipId: c.id });
          return;
        }
      }
    }
  };

  const addMarker = () => {
    const time = snapToFrame(playhead.time, state.edl.fps);
    const removing = state.markers.some((m) => Math.abs(m - time) < 1 / state.edl.fps / 2 + 1e-6);
    dispatch({ type: 'marker', time });
    toast.show({ message: t(removing ? 'editor.marker.removed' : 'editor.marker.added', { time: formatTimecode(time, state.edl.fps) }) });
  };

  const selectedMedia = selected && !isCaptionClip(selected.clip) ? (selected.clip as MediaClip) : null;
  const selectedVideo = selectedMedia && selected?.track.kind === 'video' ? selectedMedia : null;
  const noClip = t('editor.effects.noClip');
  const effectEntries: MenuEntry[] = [
    {
      key: 'dissolve',
      label: t('editor.effects.dissolve'),
      kind: 'checkbox',
      checked: !!selectedVideo?.transitionOut,
      disabled: !selectedVideo,
      reason: t('editor.effects.needShot'),
      onSelect: () =>
        selectedVideo &&
        dispatch({ type: 'commit', ops: [{ op: 'setTransition', clipId: selectedVideo.id, transition: selectedVideo.transitionOut ? null : { type: 'dissolve', dur: 0.5 } }], animate: true }),
    },
    {
      key: 'fade',
      label: t('editor.effects.fadeIn'),
      kind: 'checkbox',
      checked: !!selectedMedia?.fadeIn,
      disabled: !selectedMedia,
      reason: noClip,
      onSelect: () => selectedMedia && dispatch({ type: 'commit', ops: [{ op: 'setFade', clipId: selectedMedia.id, fadeIn: selectedMedia.fadeIn ? 0 : 0.5 }], animate: false }),
    },
    {
      key: 'reverse',
      label: t('editor.inspector.reverse'),
      kind: 'checkbox',
      checked: !!selectedMedia?.reverse,
      disabled: !selectedMedia,
      reason: noClip,
      onSelect: () => selectedMedia && dispatch({ type: 'commit', ops: [{ op: 'setSpeed', clipId: selectedMedia.id, speed: selectedMedia.speed ?? 1, reverse: !selectedMedia.reverse }], animate: true }),
    },
    {
      key: 'reset',
      label: t('editor.effects.resetTransform'),
      disabled: !selectedVideo?.transform,
      reason: t('editor.effects.nothingToReset'),
      onSelect: () => selectedVideo && dispatch({ type: 'commit', ops: [{ op: 'setTransform', clipId: selectedVideo.id, transform: { scale: 1, x: 0, y: 0, rotation: 0, opacity: 1 } }], animate: false }),
    },
  ];

  /** Bin Assets / Public: adds the item at the end of the matching track. */
  const insertFromBin = (item: BinInsert) => {
    const kind = item.kind === 'audio' ? 'voice' : 'video';
    const track = state.edl.tracks.find((tr) => tr.kind === kind);
    if (!track) return;
    const start = Math.max(0, ...(track.clips as Clip[]).map((c) => clipEnd(c)));
    const id = nextClipId(state.edl, (track.clips as Clip[])[0]?.id ?? (kind === 'video' ? 'v1' : 'a1'));
    const seconds = item.seconds ?? 3;
    dispatch({
      type: 'commit',
      ops: [{ op: 'insert', trackId: track.id, clip: { id, assetId: item.assetId, in: 0, out: seconds, start } }],
      animate: true,
      select: id,
    });
    toast.show({ message: t('editor.bin.added', { name: item.name, time: formatTimecode(start, state.edl.fps) }), action: { label: t('editor.undoAction'), onAction: undo } });
  };

  const jumpEdit = (dir: -1 | 1) => {
    const points = editPoints(state.edl);
    const now = playhead.time;
    const target = dir < 0 ? [...points].reverse().find((p) => p < now - 1e-3) : points.find((p) => p > now + 1e-3);
    if (target !== undefined) playhead.seek(target);
  };

  const splitAtPlayhead = () => {
    const time = snapToFrame(playhead.time, state.edl.fps);
    const id = state.selection;
    let target: Clip | undefined;
    if (id) target = findClip(state.edl, id)?.clip;
    if (!target || time <= target.start || time >= clipEnd(target)) {
      // No selection under the playhead: split every unlocked clip it crosses.
      const ops = state.edl.tracks
        .filter((tr) => !state.tracks[tr.id]?.locked)
        .flatMap((tr) => (tr.clips as Clip[]).filter((c) => time > c.start + 0.1 && time < clipEnd(c) - 0.1))
        .map((c) => ({ op: 'split' as const, clipId: c.id, at: time }));
      if (ops.length) dispatch({ type: 'commit', ops, animate: true });
      return;
    }
    dispatch({ type: 'commit', ops: [{ op: 'split', clipId: target.id, at: time }], animate: true });
  };

  const removeSelected = (ripple: boolean) => {
    const id = state.selection;
    if (!id) return;
    const ref = findClip(state.edl, id);
    if (!ref || state.tracks[ref.track.id]?.locked) return;
    dispatch({ type: 'commit', ops: [{ op: 'remove', clipId: id, ripple }], animate: true, select: null });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      if (state.proposal) discard();
      else if (!typing && state.selection) dispatch({ type: 'select', clipId: null });
      return;
    }
    if (typing) return;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') {
      e.preventDefault();
      dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
    } else if (mod && key === 'y') {
      e.preventDefault();
      dispatch({ type: 'redo' });
    } else if (mod && key === 'k') {
      e.preventDefault();
      splitAtPlayhead();
    } else if (mod || (e.altKey && key !== 'backspace' && key !== 'delete')) {
      return;
    } else if (key === ' ' && target.tagName !== 'BUTTON') {
      e.preventDefault();
      playhead.toggle();
    } else if (key === 'delete' || key === 'backspace') {
      e.preventDefault();
      removeSelected(!e.altKey);
    } else if (TOOL_KEYS[key] && !e.shiftKey) {
      dispatch({ type: 'tool', tool: TOOL_KEYS[key]! });
    } else if (key === 'n') {
      dispatch({ type: 'snapping', on: !state.snapping });
    } else if (key === 'arrowleft' || key === 'arrowright') {
      if (target.getAttribute('role') === 'slider' || target.getAttribute('role') === 'tab') return;
      e.preventDefault();
      const step = e.shiftKey ? 1 : 1 / state.edl.fps;
      playhead.seek(snapToFrame(playhead.time + (key === 'arrowleft' ? -step : step), state.edl.fps));
    } else if (key === 'arrowup' || key === 'arrowdown') {
      if (target.getAttribute('role') === 'slider') return;
      e.preventDefault();
      jumpEdit(key === 'arrowup' ? -1 : 1);
    } else if (key === 'm') {
      addMarker();
    } else if (key === 'i' || key === 'o') {
      dispatch({ type: 'mark', edge: key === 'i' ? 'in' : 'out', time: playhead.time });
    } else if (key === '=' || key === '+' || key === '-') {
      const pps = clampPps(state.pps * (key === '-' ? 1 / 1.25 : 1.25));
      dispatch({ type: 'view', pps, scrollX: clampScroll(state.scrollX, edlDuration(state.edl), pps, 1000) });
    }
  };

  const highlights = state.proposalPhase === 'open' && state.proposal ? state.proposal.highlights : [];
  const hidden = useMemo(
    () => new Set(Object.entries(state.tracks).filter(([, f]) => f.hidden).map(([id]) => id)),
    [state.tracks],
  );
  const muted = useMemo(
    () => new Set(Object.entries(state.tracks).filter(([, f]) => f.muted).map(([id]) => id)),
    [state.tracks],
  );
  const fmt = (n: number) => intl.formatNumber(n, { useGrouping: false });
  /** Output format (frame size and rate): an undoable edit, saved like any other. */
  const setFormat = (width: number, height: number, fps: number) => {
    if (width === state.edl.width && height === state.edl.height && fps === state.edl.fps) return;
    dispatch({ type: 'commit', ops: [{ op: 'setFormat', width, height, fps }], animate: false });
  };


  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      aria-label={t('editor.label')}
      className={styles.root}
      data-shown={shown}
      data-closing={closing || undefined}
      onKeyDown={onKeyDown}
      data-testid="editor"
    >
      <div className={styles.topbar}>
        <button type="button" className={`${styles.btn} ${styles.back}`} onClick={close}>
          <Icon name="back" />
          {t('editor.back')}
        </button>
        <span className={styles.divider} />
        <span className={styles.title}>{project.title}</span>
        <span className={styles.subtitle}>{t('editor.subtitle', { script: project.scriptName })}</span>
        <button
          type="button"
          className={`${styles.btn} ${styles.secondary} ${styles.reassemble}`}
          onClick={() =>
            void reassemble(project.id).then((edl) => {
              if (!tsync) return dispatch({ type: 'reset', edl });
              // The server already holds the rebuilt cut.
              void fetchTimeline(tsync.canvasId).then((tl) => (tsync.revision = tl.revision));
              resetFromServer(edl);
            })
          }
        >
          {t('editor.reassemble')}
        </button>
        <span className={styles.spacer} />
        <button type="button" aria-label={t('editor.undo')} title={t('editor.undo')} className={`${styles.btn} ${styles.icon}`} onClick={undo} aria-disabled={!state.past.length}>
          <Icon name="undo" />
        </button>
        <button
          type="button"
          aria-label={t('editor.redo')}
          title={t('editor.redo')}
          className={`${styles.btn} ${styles.icon}`}
          onClick={() => dispatch({ type: 'redo' })}
          aria-disabled={!state.future.length}
        >
          <Icon name="redo" />
        </button>
        <span className={styles.divider} style={{ margin: '0 4px' }} />
        <MenuPopover
          open={formatOpen}
          onOpenChange={setFormatOpen}
          label={t('editor.formatMenu')}
          align="end"
          entries={[
            ...FORMATS.map((f) => ({
              key: f.key,
              label: t('editor.formatSize', { ratio: f.key, width: fmt(f.width), height: fmt(f.height) }),
              checked: state.edl.width === f.width && state.edl.height === f.height,
              onSelect: () => setFormat(f.width, f.height, state.edl.fps),
            })),
            ...FPS.map((fps) => ({
              key: `fps${fps}`,
              label: t('editor.formatFps', { fps }),
              checked: state.edl.fps === fps,
              onSelect: () => setFormat(state.edl.width, state.edl.height, fps),
            })),
          ]}
          trigger={(tp) => (
            <button {...tp} type="button" className={`${styles.btn} ${styles.secondary} ${styles.format}`}>
              {t('editor.format', { width: fmt(state.edl.width), height: fmt(state.edl.height), fps: fmt(state.edl.fps) })}
              <Icon name="chevronDown" size={12} />
            </button>
          )}
        />
        <button
          type="button"
          className={`${styles.btn} ${styles.primary} ${styles.export}`}
          aria-haspopup="dialog"
          onClick={() => {
            onExport?.(state.edl);
            setExportOpen(true);
          }}
        >
          <Icon name="export" size={14} stroke={2.4} />
          {t('editor.export')}
        </button>
      </div>
      <div className={styles.body}>
        <Bin items={project.bin} currentId={binCurrent} onPick={pickBin} onInsert={insertFromBin} />
        <Monitor
          project={project}
          edl={state.edl}
          playhead={playhead}
          hiddenTracks={hidden}
          mutedTracks={muted}
          onMarkIn={() => dispatch({ type: 'mark', edge: 'in', time: playhead.time })}
          onMarkOut={() => dispatch({ type: 'mark', edge: 'out', time: playhead.time })}
          onPrevEdit={() => jumpEdit(-1)}
          onNextEdit={() => jumpEdit(1)}
        />
        <Inspector
          project={project}
          selected={selected ? { clip: selected.clip, track: selected.track } : null}
          fps={state.edl.fps}
          busy={!!state.selection && state.running.includes(state.selection)}
          focusCaption={focusCaption}
          onGain={(clipId, db, commit) => {
            dispatch({ type: 'commit', ops: [{ op: 'setGain', clipId, gainDb: db }], animate: false, coalesce: `gain:${clipId}:${gainSession.current}` });
            if (commit) gainSession.current++;
          }}
          onCaption={(clipId, text) => dispatch({ type: 'commit', ops: [{ op: 'setCaption', clipId, text }], animate: false })}
          onRun={requestRun}
          credits={shotCredits}
          onTransform={(clipId, transform, commit) => {
            dispatch({ type: 'commit', ops: [{ op: 'setTransform', clipId, transform }], animate: false, coalesce: `tf:${clipId}:${gainSession.current}` });
            if (commit) gainSession.current++;
          }}
          onSpeed={(clipId, speed, reverse) => dispatch({ type: 'commit', ops: [{ op: 'setSpeed', clipId, speed, reverse }], animate: true })}
          onFade={(clipId, fadeIn, commit) => {
            dispatch({ type: 'commit', ops: [{ op: 'setFade', clipId, fadeIn }], animate: false, coalesce: `fade:${clipId}:${gainSession.current}` });
            if (commit) gainSession.current++;
          }}
          onOpenOnCanvas={(nodeId) => (onOpenOnCanvas ? onOpenOnCanvas(nodeId) : close())}
        />
      </div>
      <TimelinePanel
        project={project}
        state={state}
        dispatch={dispatch}
        playhead={playhead}
        reducedMotion={reducedMotion}
        highlights={highlights}
        ask={ask}
        onAskChange={setAsk}
        onAsk={(r) => void askAgent(r, true)}
        onGenerate={requestRun}
        generateCredits={shotCredits}
        onAddMarker={addMarker}
        effects={effectEntries}
        effectsOpen={effectsOpen}
        onEffectsOpenChange={setEffectsOpen}
        onTextTool={() => setFocusCaption((n) => n + 1)}
        clipName={clipName}
      />
      <ProposalCard proposal={state.proposalPhase === 'open' ? state.proposal : null} onApply={apply} onDiscard={discard} focusOnOpen={focusProposal} />
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        projectId={project.id}
        edl={state.edl}
        marks={state.marks}
        onDone={() => toast.show({ message: t('editor.export.toast') })}
      />
      {runFlow.element}
      {/* No plan (D-007): the shared upgrade modal; the kept ask continues once the plan is active. */}
      <UpgradeGate open={joinOpen} reason={{ kind: 'agent' }} onJoined={resumeAsk} onClose={() => setJoinOpen(false)} />
    </section>
  );
}
