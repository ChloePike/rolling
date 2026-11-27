import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import styles from './Editor.module.css';
import { Icon } from './icons';
import type { EditorProject } from './mocks';
import { gainAt, pictureAt } from './playback';
import { usePlayhead, type PlayheadStore } from './playhead';
import { captionPreviewStyle } from './post/usePostProduction';
import { formatTimecode } from '@rolling/core/timeline';
import { clipEnd, edlDuration, sourceTime, type Clip, type Edl, type MediaClip } from '@rolling/core/timeline';

/** Placeholder picture per shot (mock media): sky, ground and the product, tinted like the shot's clip. */
const SCENES = [
  { bg: 'var(--c-scene-1-bg)', ground: 'var(--c-scene-1-ground)', product: 'var(--c-scene-1-product)' },
  { bg: 'var(--c-scene-2-bg)', ground: 'var(--c-scene-2-ground)', product: 'var(--c-scene-2-product)' },
] as const;

/** Slow push-in on the placeholder so playback visibly advances. */
const PUSH_IN = 0.03;

export interface MonitorProps {
  project: EditorProject;
  edl: Edl;
  playhead: PlayheadStore;
  hiddenTracks: ReadonlySet<string>;
  mutedTracks: ReadonlySet<string>;
  onMarkIn: () => void;
  onMarkOut: () => void;
  onPrevEdit: () => void;
  onNextEdit: () => void;
}

export function Monitor({ project, edl, playhead, hiddenTracks, mutedTracks, onMarkIn, onMarkOut, onPrevEdit, onNextEdit }: MonitorProps) {
  const intl = useIntl();
  const fps = edl.fps;
  const frame = usePlayhead(playhead, (s) => Math.floor(s.time * fps + 1e-6));
  const playing = usePlayhead(playhead, (s) => s.playing);
  const t = frame / fps;
  const picture = pictureAt(edl, Math.min(playhead.time, edlDuration(edl) - 1e-6), hiddenTracks);
  const nodeOrder = Object.keys(project.shots);
  const t_ = (id: string) => intl.formatMessage({ id });
  // A caption look chosen in post-production (D-033) previews here; the default keeps the approved design.
  const captionStyle = edl.tracks.some((tr) => tr.kind === 'caption' && tr.style) ? captionPreviewStyle(edl) : undefined;

  return (
    <section aria-label={t_('editor.monitor.label')} className={styles.monitor}>
      <div className={styles.stage}>
        <div className={styles.frame} style={{ aspectRatio: `${edl.width} / ${edl.height}` }} data-testid="monitor-frame">
          {picture.layers.map(({ clip, opacity, local }) => (
            <Shot
              key={clip.id}
              clip={clip}
              opacity={opacity}
              local={local}
              playing={playing}
              tint={SCENES[Math.max(0, nodeOrder.indexOf(clip.nodeId ?? '')) % SCENES.length]!}
              title={clip.nodeId ? (project.shots[clip.nodeId]?.title ?? '') : ''}
              notGenerated={t_('editor.monitor.notGenerated')}
              src={clip.assetId ? project.mediaUrls?.[clip.assetId] : undefined}
            />
          ))}
          {picture.caption ? (
            <span className={styles.monitorCaption} data-testid="monitor-caption" style={captionStyle}>
              {picture.caption.text}
            </span>
          ) : null}
        </div>
        {project.mediaUrls ? <AudioTracks project={project} edl={edl} time={playhead.time} playing={playing} muted={mutedTracks} /> : null}
      </div>
      <div className={styles.transport}>
        <span className={styles.tcNow} data-testid="monitor-timecode">
          {formatTimecode(t, fps)}
        </span>
        <span className={styles.spacer} />
        <IconBtn label={t_('editor.monitor.markIn')} icon="markIn" onClick={onMarkIn} />
        <IconBtn label={t_('editor.monitor.prevEdit')} icon="prevEdit" onClick={onPrevEdit} />
        <button
          type="button"
          className={`${styles.btn} ${styles.primary} ${styles.play}`}
          aria-label={t_(playing ? 'editor.monitor.pause' : 'editor.monitor.play')}
          onClick={() => playhead.toggle()}
        >
          <Icon name={playing ? 'pause' : 'play'} size={15} />
        </button>
        <IconBtn label={t_('editor.monitor.nextEdit')} icon="nextEdit" onClick={onNextEdit} />
        <IconBtn label={t_('editor.monitor.markOut')} icon="markOut" onClick={onMarkOut} />
        <span className={styles.spacer} />
        <span className={styles.tcTotal}>{formatTimecode(edlDuration(edl), fps)}</span>
      </div>
    </section>
  );
}

function IconBtn({ label, icon, onClick }: { label: string; icon: Parameters<typeof Icon>[0]['name']; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} className={`${styles.btn} ${styles.icon}`} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

interface ShotProps {
  clip: MediaClip;
  opacity: number;
  local: number;
  playing: boolean;
  tint: (typeof SCENES)[number];
  title: string;
  notGenerated: string;
  src?: string;
}

function Shot({ clip, opacity, local, playing, tint, title, notGenerated, src }: ShotProps) {
  if (clip.assetId === null) {
    return (
      <div className={styles.hatch} style={{ opacity }}>
        <span className={styles.hatchTitle}>{title}</span>
        <span>{notGenerated}</span>
      </div>
    );
  }
  const tf = clip.transform;
  const look = tf
    ? { opacity: opacity * tf.opacity, transform: `translate(${(tf.x / 1080) * 100}%, ${(tf.y / 1920) * 100}%) rotate(${tf.rotation}deg) scale(${tf.scale})` }
    : { opacity };
  if (src) return <ShotVideo src={src} time={sourceTime(clip, clip.start + local)} playing={playing} opacity={look.opacity} />;
  const progress = Math.min(1, Math.max(0, local / (clipEnd(clip) - clip.start)));
  return (
    <div className={styles.scene} style={{ background: tint.bg, ...look }} data-testid="monitor-shot" data-clip-id={clip.id} data-transform={tf ? '' : undefined}>
      <div className={styles.ground} style={{ background: tint.ground }} />
      <div className={styles.product} style={{ background: tint.product, transform: `scale(${1 + PUSH_IN * progress})` }} />
    </div>
  );
}

/** Real media: a muted <video> slaved to the playhead (audio plays from the audio tracks). */
function ShotVideo({ src, time, playing, opacity }: { src: string; time: number; playing: boolean; opacity: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (Math.abs(v.currentTime - time) > 0.15) v.currentTime = time;
    if (playing && v.paused) void v.play().catch(() => undefined);
    if (!playing && !v.paused) v.pause();
  }, [time, playing]);
  return <video ref={ref} className={styles.frameVideo} src={src} muted playsInline preload="auto" style={{ opacity }} />;
}

/** Real media: one <audio> per voice/music clip with a URL, slaved to the playhead, volume from gain and keyframes. */
function AudioTracks({ project, edl, time, playing, muted }: { project: EditorProject; edl: Edl; time: number; playing: boolean; muted: ReadonlySet<string> }) {
  const clips: Array<{ clip: MediaClip; src: string; trackMuted: boolean }> = [];
  for (const track of edl.tracks) {
    if (track.kind !== 'voice' && track.kind !== 'music') continue;
    for (const c of track.clips as Clip[]) {
      const m = c as MediaClip;
      const src = m.assetId ? project.mediaUrls?.[m.assetId] : undefined;
      if (src) clips.push({ clip: m, src, trackMuted: muted.has(track.id) });
    }
  }
  return (
    <>
      {clips.map(({ clip, src, trackMuted }) => (
        <ClipAudio key={clip.id} clip={clip} src={src} time={time} playing={playing} muted={trackMuted} />
      ))}
    </>
  );
}

function ClipAudio({ clip, src, time, playing, muted }: { clip: MediaClip; src: string; time: number; playing: boolean; muted: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const active = time >= clip.start && time < clipEnd(clip);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.volume = Math.min(1, gainAt(clip, time));
    a.muted = muted;
    const local = sourceTime(clip, time);
    if (active && Math.abs(a.currentTime - local) > 0.15) a.currentTime = local;
    if (active && playing && a.paused) void a.play().catch(() => undefined);
    if ((!active || !playing) && !a.paused) a.pause();
  }, [clip, time, playing, muted, active]);
  return <audio ref={ref} src={src} preload="auto" />;
}
