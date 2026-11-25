import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useIntl } from 'react-intl';
import styles from './Editor.module.css';
import type { EditorProject } from './mocks';
import { formatClipLength, formatTimecode } from '@rolling/core/timeline';
import { clipEnd, isCaptionClip, type Clip, type MediaClip, type Track } from '@rolling/core/timeline';

/** Volume fader range in dB (−6 dB sits at 62.5%). */
const DB_MIN = -26;
const DB_MAX = 6;

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
  const { clip, track, project, busy, onGain, onRun, onOpenOnCanvas } = props;
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
      : t('editor.inspector.shotMeta', { model: shot?.model ?? '', resolution: shot?.resolution ?? '', seconds: shot?.seconds ?? 0 })
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
            <Row name={t('editor.inspector.scale')} fill={0.5} value={pct(1)} />
            <Row name={t('editor.inspector.position')} value={t('editor.inspector.position.value', { x: 0, y: 0 })} />
            <Row name={t('editor.inspector.rotation')} value={t('editor.inspector.degrees', { value: 0 })} />
            <Row name={t('editor.inspector.opacity')} fill={1} value={pct(1)} />
          </Section>
          <Section label={t('editor.inspector.speed')}>
            <Row name={t('editor.inspector.speed')} fill={0.5} value={pct(1)} />
            <Row name={t('editor.inspector.reverse')} value={t('editor.inspector.off')} />
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
          <Row name={t('editor.inspector.fadeIn')} value={t('editor.inspector.seconds', { value: clip.fadeIn ?? 0.5 })} />
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
              <span className={styles.regenerateCost}>{t('editor.inspector.credits', { count: shot.credits })}</span>
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

function Row({ name, value, fill, slider }: { name: string; value: string; fill?: number; slider?: SliderSpec }) {
  return (
    <div className={styles.inspRow}>
      <span className={styles.inspName}>{name}</span>
      {fill === undefined ? <span className={styles.spacer} /> : slider ? <Slider spec={slider} name={name} valueText={value} /> : <Bar fill={fill} />}
      <span className={styles.inspValue}>{value}</span>
    </div>
  );
}

function Bar({ fill }: { fill: number }) {
  return (
    <span className={styles.slider} aria-hidden="true">
      <span className={styles.sliderFill} style={{ width: `${Math.round(fill * 100)}%` }} />
    </span>
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
