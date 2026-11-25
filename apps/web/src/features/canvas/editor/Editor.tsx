import { useToast } from '@rolling/ui';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import { useIntl } from 'react-intl';
import { getEditorProject, mockRun, proposeEdit, reassemble, type RunOutcome, type RunRequest } from './api';
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
import { snapToFrame } from '@rolling/core/timeline';
import { clipEnd, edlDuration, findClip, isCaptionClip, type Clip, type Edl, type MediaClip, type Track } from '@rolling/core/timeline';

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
  if (!project) return <div className={styles.root} />;
  return <EditorLoaded {...props} project={project} />;
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
  const [state, dispatch] = useReducer(reducer, project, (p) => initEditorState(p.edl, p.marks, p.view.selection));
  const [playhead] = useState(() => new PlayheadStore(project.view.playhead, edlDuration(project.edl)));
  const [ask, setAsk] = useState(initialAsk ?? '');
  const [shown, setShown] = useState(false);
  const [closing, setClosing] = useState(false);
  const [focusCaption, setFocusCaption] = useState(0);
  const [focusProposal, setFocusProposal] = useState(false);
  const gainSession = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

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
      const proposal = await proposeEdit(project, stateRef.current.edl, request);
      setFocusProposal(fromUser);
      dispatch({ type: 'proposal', proposal });
      if (!proposal) toast.show({ message: t('editor.proposal.failed') });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project],
  );

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
    dispatch({ type: 'commit', ops: p.ops, animate: true });
    dispatch({ type: 'proposalClose' });
    setAsk('');
    toast.show({ message: t('editor.proposal.applied'), action: { label: t('editor.undoAction'), onAction: undo } });
  };
  const discard = () => dispatch({ type: 'proposalClose' });

  const run = async (clipId: string) => {
    const ref = findClip(state.edl, clipId);
    const clip = ref?.clip as MediaClip | undefined;
    if (!clip?.nodeId || state.running.includes(clipId)) return;
    const shot = project.shots[clip.nodeId];
    const request: RunRequest = {
      kind: clip.assetId === null ? 'generate' : 'regenerate',
      clipId,
      nodeId: clip.nodeId,
      credits: shot?.credits ?? 0,
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
          onClick={() => void reassemble(project.id).then((edl) => dispatch({ type: 'reset', edl }))}
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
        {/* TODO: export format popover is not designed yet. */}
        <button type="button" className={`${styles.btn} ${styles.secondary} ${styles.format}`} aria-haspopup="menu">
          {t('editor.format', { width: fmt(state.edl.width), height: fmt(state.edl.height), fps: fmt(state.edl.fps) })}
          <Icon name="chevronDown" size={12} />
        </button>
        <button type="button" className={`${styles.btn} ${styles.primary} ${styles.export}`} onClick={() => onExport?.(state.edl)}>
          <Icon name="export" size={14} stroke={2.4} />
          {t('editor.export')}
        </button>
      </div>
      <div className={styles.body}>
        <Bin items={project.bin} currentId={binCurrent} onPick={pickBin} />
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
          onRun={(clipId) => void run(clipId)}
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
        onGenerate={(clipId) => void run(clipId)}
        onTextTool={() => setFocusCaption((n) => n + 1)}
        clipName={clipName}
      />
      <ProposalCard proposal={state.proposalPhase === 'open' ? state.proposal : null} onApply={apply} onDiscard={discard} focusOnOpen={focusProposal} />
    </section>
  );
}
