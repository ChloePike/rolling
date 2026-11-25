import { useEffect, useRef, useState, type Dispatch, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { useIntl } from 'react-intl';
import styles from './Editor.module.css';
import { Icon, type IconName } from './icons';
import type { EditorProject } from './mocks';
import { meterLevel, mixPeak } from './playback';
import { usePlayhead, type PlayheadStore } from './playhead';
import type { EditorAction, EditorState, Tool } from './state';
import { TimelineCanvas } from './TimelineCanvas';
import { clampPps, clampScroll, ppsToZoom, rowLayout, zoomToPps } from '@rolling/core/timeline';
import type { Highlight } from '@rolling/core/timeline';
import { formatTimecode } from '@rolling/core/timeline';
import { edlDuration, findClip, isCaptionClip, type Clip, type Track } from '@rolling/core/timeline';

const TOOLS: Array<{ tool: Tool; icon: IconName; label: string }> = [
  { tool: 'select', icon: 'select', label: 'editor.timeline.select' },
  { tool: 'razor', icon: 'razor', label: 'editor.timeline.razor' },
  { tool: 'slip', icon: 'slip', label: 'editor.timeline.slip' },
  { tool: 'text', icon: 'text', label: 'editor.timeline.text' },
  { tool: 'hand', icon: 'hand', label: 'editor.timeline.hand' },
];

const TRACK_NAME: Record<Track['kind'], string> = {
  caption: 'editor.timeline.captions',
  video: 'editor.timeline.video',
  voice: 'editor.timeline.voice',
  music: 'editor.timeline.music',
};

export interface TimelinePanelProps {
  project: EditorProject;
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  playhead: PlayheadStore;
  reducedMotion: boolean;
  highlights: readonly Highlight[];
  ask: string;
  onAskChange: (v: string) => void;
  onAsk: (request: string) => void;
  onGenerate: (clipId: string) => void;
  onTextTool: (clipId: string) => void;
  clipName: (clip: Clip, track: Track) => string;
}

export function TimelinePanel(props: TimelinePanelProps) {
  const { state, dispatch, project, playhead } = props;
  const intl = useIntl();
  const t = (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values);
  const { rows } = rowLayout(state.edl.tracks);
  const selectedTrack = state.selection ? findClip(state.edl, state.selection)?.track.id : undefined;
  const lanesRef = useRef<HTMLDivElement>(null);

  const zoomTo = (pps: number) => {
    const w = lanesRef.current?.firstElementChild?.getBoundingClientRect().width ?? 1000;
    const next = clampPps(pps);
    // Keep the playhead in place on screen while zooming.
    const anchor = playhead.time * state.pps - state.scrollX;
    const scrollX = clampScroll(playhead.time * next - anchor, edlDuration(state.edl), next, w);
    dispatch({ type: 'view', pps: next, scrollX });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (props.ask.trim() && state.proposalPhase !== 'pending') props.onAsk(props.ask.trim());
  };

  return (
    <section aria-label={t('editor.timeline.label')} className={styles.timeline}>
      <div className={styles.toolbar} role="toolbar" aria-label={t('editor.timeline.tools')}>
        {TOOLS.map(({ tool, icon, label }) => (
          <button
            key={tool}
            type="button"
            aria-label={t(label)}
            title={t(label)}
            aria-pressed={state.tool === tool}
            className={`${styles.btn} ${styles.icon}`}
            onClick={() => dispatch({ type: 'tool', tool })}
          >
            <Icon name={icon} />
          </button>
        ))}
        <span className={styles.toolSep} />
        <button
          type="button"
          aria-label={t('editor.timeline.snapping')}
          title={t('editor.timeline.snapping')}
          aria-pressed={state.snapping}
          className={`${styles.btn} ${styles.icon}`}
          onClick={() => dispatch({ type: 'snapping', on: !state.snapping })}
        >
          <Icon name="snapping" />
        </button>
        {/* TODO: markers and effects panels are not designed yet. */}
        <button type="button" aria-label={t('editor.timeline.addMarker')} title={t('editor.timeline.addMarker')} className={`${styles.btn} ${styles.icon}`}>
          <Icon name="marker" />
        </button>
        <button type="button" aria-label={t('editor.timeline.effects')} title={t('editor.timeline.effects')} className={`${styles.btn} ${styles.icon}`}>
          <Icon name="effects" />
        </button>
        <span className={styles.spacer} />
        <form className={styles.agentField} onSubmit={submit}>
          <label htmlFor="edask" className={styles.agentLabel}>
            {t('editor.timeline.agent')}
          </label>
          <input
            id="edask"
            className={styles.agentInput}
            placeholder={t('editor.timeline.askPlaceholder')}
            value={props.ask}
            autoComplete="off"
            onChange={(e) => props.onAskChange(e.target.value)}
          />
          <button
            type="submit"
            aria-label={t('editor.timeline.send')}
            aria-busy={state.proposalPhase === 'pending' || undefined}
            className={`${styles.btn} ${styles.primary} ${styles.send}`}
          >
            <Icon name="send" size={13} stroke={2.6} />
          </button>
        </form>
        <button
          type="button"
          aria-label={t('editor.timeline.zoomOut')}
          title={t('editor.timeline.zoomOut')}
          className={`${styles.btn} ${styles.icon}`}
          onClick={() => zoomTo(state.pps / 1.25)}
        >
          <Icon name="zoomOut" />
        </button>
        <ZoomSlider value={ppsToZoom(state.pps)} label={t('editor.timeline.zoom')} onChange={(z) => zoomTo(zoomToPps(z))} />
        <button
          type="button"
          aria-label={t('editor.timeline.zoomIn')}
          title={t('editor.timeline.zoomIn')}
          className={`${styles.btn} ${styles.icon}`}
          onClick={() => zoomTo(state.pps * 1.25)}
        >
          <Icon name="zoomIn" />
        </button>
      </div>
      <div className={styles.tlBody}>
        <div className={styles.heads} role="list" aria-label={t('editor.timeline.tracks')}>
          <HeadTime playhead={playhead} fps={state.edl.fps} />
          {state.edl.tracks.map((track, i) => {
            const flags = state.tracks[track.id]!;
            const name = t(TRACK_NAME[track.kind]);
            const audio = track.kind === 'voice' || track.kind === 'music';
            return (
              <div key={track.id} role="listitem" className={styles.head} style={{ height: rows[i]!.height + 1 }}>
                <span className={styles.badge} data-active={selectedTrack === track.id}>
                  {track.id}
                </span>
                <span className={styles.headName}>{name}</span>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.toggle}`}
                  aria-label={t(audio ? 'editor.timeline.muteTrack' : 'editor.timeline.hideTrack', { track: name })}
                  aria-pressed={audio ? flags.muted : flags.hidden}
                  onClick={() => dispatch({ type: 'trackFlag', trackId: track.id, flag: audio ? 'muted' : 'hidden' })}
                >
                  <Icon name={audio ? 'mute' : 'eye'} size={13} />
                </button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.toggle}`}
                  aria-label={t('editor.timeline.lockTrack', { track: name })}
                  aria-pressed={flags.locked}
                  onClick={() => dispatch({ type: 'trackFlag', trackId: track.id, flag: 'locked' })}
                >
                  <Icon name="lock" size={13} />
                </button>
              </div>
            );
          })}
        </div>
        <div ref={lanesRef} style={{ display: 'contents' }}>
          <TimelineCanvas
            project={project}
            state={state}
            dispatch={dispatch}
            playhead={playhead}
            reducedMotion={props.reducedMotion}
            highlights={props.highlights}
            onGenerate={props.onGenerate}
            onTextTool={props.onTextTool}
            generateLabel={(count) => t('editor.timeline.generate', { count })}
            clipName={props.clipName}
            clipListLabel={(clip, track) =>
              t('editor.timeline.clip', {
                name: isCaptionClip(clip) ? clip.text : props.clipName(clip, track),
                start: formatTimecode(clip.start, state.edl.fps),
                end: formatTimecode(clip.start + (isCaptionClip(clip) ? clip.end - clip.start : clip.out - clip.in), state.edl.fps),
              })
            }
            ariaLabel={t('editor.timeline.label')}
            clipsLabel={t('editor.timeline.clips')}
          />
        </div>
        <Meter project={project} state={state} playhead={playhead} label={t('editor.timeline.meter')} />
      </div>
    </section>
  );
}

function HeadTime({ playhead, fps }: { playhead: PlayheadStore; fps: number }) {
  const frame = usePlayhead(playhead, (s) => Math.floor(s.time * fps + 1e-6));
  return (
    <div className={styles.headTime} role="presentation">
      {formatTimecode(frame / fps, fps)}
    </div>
  );
}

function ZoomSlider({ value, label, onChange }: { value: number; label: string; onChange: (z: number) => void }) {
  const from = (e: PointerEvent<HTMLSpanElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const onKey = (e: KeyboardEvent) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 0.05 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -0.05 : 0;
    if (!d) return;
    e.preventDefault();
    onChange(Math.min(1, Math.max(0, value + d)));
  };
  const pct = `${value * 100}%`;
  return (
    <span
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className={styles.zoom}
      onKeyDown={onKey}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onChange(from(e));
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onChange(from(e));
      }}
    >
      <span className={styles.zoomFill} style={{ width: pct }} />
      <span className={styles.zoomThumb} style={{ left: pct }} />
    </span>
  );
}

/** Stereo peak meter of the program mix at the playhead (mock: derived from the waveform peaks). */
function Meter({ project, state, playhead, label }: { project: EditorProject; state: EditorState; playhead: PlayheadStore; label: string }) {
  const time = usePlayhead(playhead, (s) => s.time);
  const [held, setHeld] = useState(0);
  const muted = new Set(Object.entries(state.tracks).filter(([, f]) => f.muted).map(([id]) => id));
  const level = meterLevel(mixPeak(project, state.edl, time, muted));
  // Peak hold with a slow release while playing.
  useEffect(() => {
    setHeld((h) => (playhead.playing ? Math.max(level, h * 0.92) : level));
  }, [level, playhead.playing]);
  const l = Math.min(1, held);
  return (
    <div className={styles.meter} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(l * 100)}>
      <span className={styles.meterBar} style={{ height: `${l * 100}%` }} />
      <span className={styles.meterBar} style={{ height: `${l * 0.887 * 100}%` }} />
    </div>
  );
}
