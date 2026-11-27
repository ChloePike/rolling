import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useIntl, type IntlShape } from 'react-intl';
import styles from './Editor.module.css';
import type { EditorProject } from './mocks';
import { formatClipLength, formatTimecode } from '@rolling/core/timeline';
import { clipEnd, IDENTITY_TRANSFORM, isCaptionClip, MIN_SPEED, type Clip, type ClipTransform, type MediaClip, type Track } from '@rolling/core/timeline';

/** Volume fader range in dB (−6 dB sits at 62.5%). */
const DB_MIN = -26;
const DB_MAX = 6;


/**
 * “Model, 720p, 5s” from the parts a shot has (no “, , 0s” for a shot without a
 * model, resolution or length yet): an Intl list of the present parts, or ''.
 */
export function shotMetaLine(intl: Pick<IntlShape, 'formatMessage' | 'formatList'>, shot: { model?: string | null; resolution?: string | null; seconds?: number | null } | undefined): string {
  if (!shot) return '';
  const parts = [
    shot.model?.trim() || null,
    shot.resolution?.trim() || null,
    typeof shot.seconds === 'number' && shot.seconds > 0 ? intl.formatMessage({ id: 'editor.inspector.seconds' }, { value: shot.seconds }) : null,
  ].filter((p): p is string => !!p);
  return parts.length ? intl.formatList(parts, { type: 'unit', style: 'short' }) : '';
}

export interface InspectorProps {
  project: EditorProject;
  selected: { clip: Clip; track: Track } | null;
  fps: number;
  busy: boolean;
  /** Bumped by the Text tool to focus the caption field. */
  focusCaption: number;
  onGain: (clipId: string, db: number, commit: boolean) => void;
  onCaption: (clipId: string, text: string) => void;
  onRun: (clipId: string) => void;
  onOpenOnCanvas: (nodeId: string) => void;
  /** Credits to (re)generate a shot, from the catalog (D-006). */
  credits: (nodeId: string) => number;
  onTransform: (clipId: string, transform: Partial<ClipTransform>, commit: boolean) => void;
  onSpeed: (clipId: string, speed: number, reverse?: boolean) => void;
  onFade: (clipId: string, fadeIn: number, commit: boolean) => void;
}

export function Inspector(props: InspectorProps) {
  const intl = useIntl();
  const { selected } = props;
  const t = (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values);
  const key = selected?.clip.id ?? 'none';
  return (
    <aside aria-label={t('editor.inspector.label')} className={styles.inspector}>
      <div key={key} className={`${styles.inspBody} ${styles.panelSwap}`}>
        {!selected ? (
          <p className={styles.inspEmpty}>{t('editor.inspector.none')}</p>
        ) : isCaptionClip(selected.clip) ? (
          <CaptionPanel {...props} clip={selected.clip} />
        ) : (
          <MediaPanel {...props} clip={selected.clip} track={selected.track} />
        )}
      </div>
    </aside>
  );
}

function CaptionPanel({ clip, fps, onCaption, focusCaption }: InspectorProps & { clip: Extract<Clip, { text: string }> }) {
  const intl = useIntl();
  const [text, setText] = useState(clip.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setText(clip.text), [clip.text]);
  useEffect(() => {
    if (focusCaption) ref.current?.focus();
  }, [focusCaption]);
  const commit = () => {
    if (text.trim() && text !== clip.text) onCaption(clip.id, text.trim());
  };
  return (
    <>
      <div className={styles.inspHead}>
        <span className={styles.inspTitle}>{intl.formatMessage({ id: 'editor.inspector.captionTitle' })}</span>
        <span className={styles.inspMeta}>
          {intl.formatMessage(
            { id: 'editor.inspector.captionMeta' },
            { start: formatTimecode(clip.start, fps), end: formatTimecode(clip.end, fps) },
          )}
        </span>
      </div>
      <div className={styles.inspSection}>
        <label className={styles.inspLabel} htmlFor={`cap-${clip.id}`}>
          {intl.formatMessage({ id: 'editor.inspector.captionText' })}
        </label>
        <textarea
          ref={ref}
          id={`cap-${clip.id}`}
          className={styles.captionText}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commit();
              e.currentTarget.blur();
            }
          }}
        />
      </div>
    </>
  );
}

function MediaPanel(props: InspectorProps & { clip: MediaClip; track: Track }) {
  const { clip, track, project, busy, onGain, onRun, onOpenOnCanvas, onTransform, onSpeed, onFade, credits } = props;
  const tf = { ...IDENTITY_TRANSFORM, ...clip.transform };
  const speed = clip.speed ?? 1;
  const fadeIn = clip.fadeIn ?? 0;
  const dur = clipEnd(clip) - clip.start;
  const intl = useIntl();
  const t = (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values);
  const pct = (v: number) => t('editor.inspector.percent', { value: v });
  const shot = clip.nodeId ? project.shots[clip.nodeId] : undefined;
  const audio = clip.assetId ? project.audio[clip.assetId] : undefined;
  const isVideo = track.kind === 'video';
  const gain = clip.gainDb ?? 0;
  const title = shot?.title ?? audio?.title ?? clip.id;
  const meta = isVideo
    ? clip.assetId === null
      ? t('editor.bin.notGenerated')
      : shotMetaLine(intl, shot)
    : t('editor.inspector.audioMeta', { length: formatClipLength(audio?.seconds ?? clipEnd(clip) - clip.start) });
  const dbText = t('editor.inspector.db', {
    value: intl.formatNumber(gain, { maximumFractionDigits: 1, signDisplay: 'negative' }).replace('-', '−'),
  });

  return (
    <>
      <div className={styles.inspHead}>
        <span className={styles.inspTitle}>{title}</span>
        <span className={styles.inspMeta}>{meta}</span>
      </div>
      {isVideo && clip.assetId !== null ? (
        <>
          <Section label={t('editor.inspector.transform')}>
            <Row
              name={t('editor.inspector.scale')}
              fill={tf.scale / 2}
              value={pct(tf.scale)}
              slider={{ min: 0, max: 2, value: tf.scale, step: 0.05, onChange: (v, c) => onTransform(clip.id, { scale: Math.max(0.1, v) }, c) }}
            />
            <Row
              name={t('editor.inspector.position')}
              value={t('editor.inspector.position.value', { x: Math.round(tf.x), y: Math.round(tf.y) })}
              control={
                <span className={styles.posInputs}>
                  {(['x', 'y'] as const).map((axis) => (
                    <NumberField
                      key={axis}
                      label={t(`editor.inspector.position.${axis}`)}
                      value={tf[axis]}
                      onCommit={(v) => onTransform(clip.id, { [axis]: v }, true)}
                    />
                  ))}
                </span>
              }
            />
            <Row
              name={t('editor.inspector.rotation')}
              fill={(tf.rotation + 180) / 360}
              value={t('editor.inspector.degrees', { value: Math.round(tf.rotation) })}
              slider={{ min: -180, max: 180, value: tf.rotation, step: 1, onChange: (v, c) => onTransform(clip.id, { rotation: v }, c) }}
            />
            <Row
              name={t('editor.inspector.opacity')}
              fill={tf.opacity}
              value={pct(tf.opacity)}
              slider={{ min: 0, max: 1, value: tf.opacity, step: 0.05, onChange: (v, c) => onTransform(clip.id, { opacity: v }, c) }}
            />
          </Section>
          <Section label={t('editor.inspector.speed')}>
            <Row
              name={t('editor.inspector.speed')}
              fill={speed / 2}
              value={pct(speed)}
              slider={{ min: 0, max: 2, value: Math.min(2, speed), step: 0.25, onChange: (v, c) => c && onSpeed(clip.id, Math.max(MIN_SPEED, v)) }}
            />
            <Row
              name={t('editor.inspector.reverse')}
              value=""
              control={
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!clip.reverse}
                  aria-label={t('editor.inspector.reverse')}
                  className={`${styles.btn} ${styles.inspToggle}`}
                  onClick={() => onSpeed(clip.id, speed, !clip.reverse)}
                >
                  {t(clip.reverse ? 'editor.inspector.on' : 'editor.inspector.off')}
                </button>
              }
            />
          </Section>
        </>
      ) : null}
      {clip.assetId !== null ? (
        <Section label={t('editor.inspector.audio')}>
          <Row
            name={t('editor.inspector.volume')}
            fill={(gain - DB_MIN) / (DB_MAX - DB_MIN)}
            value={dbText}
            slider={{
              min: DB_MIN,
              max: DB_MAX,
              value: gain,
              step: 1,
              onChange: (v, commit) => onGain(clip.id, v, commit),
            }}
          />
          <Row
            name={t('editor.inspector.fadeIn')}
            fill={Math.min(1, fadeIn / Math.min(2, dur))}
            value={t('editor.inspector.seconds', { value: fadeIn })}
            slider={{ min: 0, max: Math.min(2, Math.floor(dur * 10) / 10), value: fadeIn, step: 0.1, onChange: (v, c) => onFade(clip.id, Math.round(v * 10) / 10, c) }}
          />
        </Section>
      ) : null}
      {isVideo && shot ? (
        <div className={styles.inspCta}>
          <span className={styles.inspLabel} style={{ paddingBottom: 0 }}>
            {t('editor.inspector.cantFix')}
          </span>
          <div className={styles.inspCtaButtons}>
            <button
              type="button"
              className={`${styles.btn} ${styles.primary} ${styles.regenerate}`}
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={() => onRun(clip.id)}
            >
              <span>{t(clip.assetId === null ? 'editor.inspector.generate' : 'editor.inspector.regenerate')}</span>
              {credits(shot.nodeId) > 0 ? <span className={styles.regenerateCost}>{t('editor.inspector.credits', { count: credits(shot.nodeId) })}</span> : null}
            </button>
            <button type="button" className={`${styles.btn} ${styles.openCanvas}`} onClick={() => onOpenOnCanvas(shot.nodeId)}>
              {t('editor.inspector.openOnCanvas')}
            </button>
          </div>
          <span className={styles.inspNote}>{t('editor.inspector.regenerateNote')}</span>
        </div>
      ) : null}
    </>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.inspSection}>
      <span className={styles.inspLabel}>{label}</span>
      {children}
    </div>
  );
}

interface SliderSpec {
  min: number;
  max: number;
  value: number;
  step: number;
  onChange: (value: number, commit: boolean) => void;
}

function Row({ name, value, fill, slider, control }: { name: string; value: string; fill?: number; slider?: SliderSpec; control?: React.ReactNode }) {
  return (
    <div className={styles.inspRow}>
      <span className={styles.inspName}>{name}</span>
      {control ? <span className={styles.spacer} /> : fill === undefined || !slider ? <span className={styles.spacer} /> : <Slider spec={slider} name={name} valueText={value} />}
      {control ?? <span className={styles.inspValue}>{value}</span>}
    </div>
  );
}

/** Whole-number field (position in output pixels): Enter or blur commits, arrows step by 1 (Shift 10). */
function NumberField({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(Math.round(value)));
  useEffect(() => setText(String(Math.round(value))), [value]);
  const commit = (v: number) => {
    if (Number.isFinite(v) && v !== value) onCommit(Math.max(-4000, Math.min(4000, Math.round(v))));
    else setText(String(Math.round(value)));
  };
  return (
    <input
      className={styles.posInput}
      inputMode="numeric"
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => commit(Number(text))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(Number(text));
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          commit(value + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
        }
      }}
    />
  );
}

function Slider({ spec, name, valueText }: { spec: SliderSpec; name: string; valueText: string }) {
  const { min, max, value, step, onChange } = spec;
  const fill = (value - min) / (max - min);
  const fromPointer = (e: PointerEvent<HTMLSpanElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return Math.round((min + p * (max - min)) / step) * step;
  };
  const onKey = (e: KeyboardEvent) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : 0;
    if (!d) return;
    e.preventDefault();
    onChange(Math.min(max, Math.max(min, value + d)), true);
  };
  return (
    <span
      role="slider"
      tabIndex={0}
      aria-label={name}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      className={styles.slider}
      onKeyDown={onKey}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onChange(fromPointer(e), false);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onChange(fromPointer(e), false);
      }}
      onPointerUp={(e) => onChange(fromPointer(e), true)}
    >
      <span className={styles.sliderFill} style={{ width: `${fill * 100}%` }} />
    </span>
  );
}
