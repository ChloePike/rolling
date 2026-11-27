import { Dialog, Progress, SegmentedControl, Switch } from '@rolling/ui';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { formatTimecode, edlDuration, type Edl } from '@rolling/core/timeline';
import { exportSize, PREVIEW_SECONDS, SOCIAL_PRESETS, type ExportPreset } from '@rolling/core/export';
import { brandAppliesToExport, cuesOfEdl } from '@rolling/core/post';
import { exportDownloadUrl, startExport, type ExportEvent, type ExportOptions } from './api';
import styles from './Editor.module.css';
import pStyles from './post/PostDialogs.module.css';
import { downloadCaptions } from './post/usePostProduction';
import { getBrandKit } from './post/api';
import { BrandKitDialog } from './post/BrandKitDialog';
import { isMockApi } from '@/features/overlays/backend';
import { download } from '@/lib/transfers';

type Done = { exportId: string; url: string; fileName: string; seconds: number; preset: string };
type Phase =
  | { kind: 'setup' }
  | { kind: 'running'; progress: number }
  | { kind: 'done'; files: Done[] }
  | { kind: 'failed'; reason: string; code?: string };

type Smooth = 'off' | '48' | '60';

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  edl: Edl;
  marks: { in: number; out: number };
  /** Where a Smoother motion preview starts. */
  playheadTime?: number;
  /** Called once the export finished (e.g. to toast). */
  onDone?: (fileName: string) => void;
}

/**
 * Export (MP4): range and resolution, social presets (TikTok / Reels /
 * Shorts 9:16, square, YouTube 16:9; several at once), captions burn-in,
 * Smoother motion (frame interpolation, honestly labelled, with a 4 s
 * preview) and the brand kit (D-033 .. D-035); then real progress from the
 * export jobs (`export.progress` on the project channel), then Download
 * through the shared transfer queue (resumable, the signed URL refreshed
 * through `GET /api/exports/:id`). Stop stops following; a failure says so
 * and offers Retry. Caption files (SRT, WebVTT) download from here too.
 */
export function ExportDialog({ open, onOpenChange, projectId, edl, marks, playheadTime = 0, onDone }: ExportDialogProps) {
  const intl = useIntl();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const [range, setRange] = useState<'all' | 'marks'>('all');
  const [resolution, setResolution] = useState<ExportOptions['resolution']>('1080p');
  const [original, setOriginal] = useState(true);
  const [social, setSocial] = useState<ExportPreset[]>([]);
  const [burn, setBurn] = useState(true);
  const [brand, setBrand] = useState(false);
  const [brandReady, setBrandReady] = useState(false);
  const [smooth, setSmooth] = useState<Smooth>('off');
  const [preview, setPreview] = useState<{ kind: 'idle' } | { kind: 'running' } | { kind: 'ready'; url: string } | { kind: 'failed'; reason: string }>({ kind: 'idle' });
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  const [brandOpen, setBrandOpen] = useState(false);
  const [kitSeq, setKitSeq] = useState(0);
  const cancels = useRef<(() => void)[]>([]);
  const hasMarks = marks.out > marks.in;
  const hasCaptions = cuesOfEdl(edl).length > 0;
  const real = !isMockApi();

  const stopAll = () => {
    for (const c of cancels.current.splice(0)) c();
  };
  useEffect(() => {
    if (!open) {
      stopAll();
      setPhase({ kind: 'setup' });
      setPreview({ kind: 'idle' });
      return;
    }
    let live = true;
    getBrandKit().then(
      (k) => live && setBrandReady(brandAppliesToExport({ ...k, fonts: k.fonts })),
      () => live && setBrandReady(false),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kitSeq]);
  useEffect(() => () => stopAll(), []);

  const presets: (ExportPreset | null)[] = [...(original ? [null] : []), ...social];
  const optionsFor = (): ExportOptions['options'] => ({
    ...(hasCaptions && { burnCaptions: burn }),
    ...(smooth !== 'off' && { interpolate: Number(smooth) as 48 | 60 }),
    ...(brand && brandReady && { brand: true }),
  });

  const run = () => {
    stopAll();
    const list = presets.length ? presets : [null];
    const progress = list.map(() => 0);
    const files: (Done | null)[] = list.map(() => null);
    setPhase({ kind: 'running', progress: 0 });
    list.forEach((preset, i) => {
      const stop = startExport(projectId, edl, { range, marks, resolution, ...(preset && { preset }), options: optionsFor() }, (e: ExportEvent) => {
        if (e.type === 'started') return;
        if (e.type === 'progress') {
          progress[i] = e.progress;
          setPhase((p) => (p.kind === 'running' ? { kind: 'running', progress: progress.reduce((a, b) => a + b, 0) / list.length } : p));
        } else if (e.type === 'failed') {
          stopAll();
          setPhase({ kind: 'failed', reason: e.reason, ...(e.code ? { code: e.code } : {}) });
        } else {
          files[i] = { exportId: e.exportId, url: e.url, fileName: e.fileName, seconds: e.seconds, preset: preset ?? resolution };
          progress[i] = 1;
          if (files.every(Boolean)) {
            cancels.current = [];
            setPhase({ kind: 'done', files: files as Done[] });
            onDone?.(files[0]!.fileName);
          }
        }
      });
      cancels.current.push(stop);
    });
  };

  const runPreview = () => {
    const total = edlDuration(edl);
    const start = Math.max(0, Math.min(playheadTime, total - PREVIEW_SECONDS));
    setPreview({ kind: 'running' });
    const stop = startExport(projectId, edl, { range: { start, end: Math.min(total, start + PREVIEW_SECONDS) }, marks, resolution, ...(social[0] && !original && { preset: social[0] }), options: { ...optionsFor(), preview: true } }, (e) => {
      if (e.type === 'done') setPreview({ kind: 'ready', url: e.url });
      else if (e.type === 'failed') setPreview({ kind: 'failed', reason: e.reason || t('editor.export.unknown') });
    });
    cancels.current.push(stop);
  };

  const save = (f: Done) => {
    void download(f.url, { filename: f.fileName, refreshUrl: () => exportDownloadUrl(f.exportId) }).catch(() => {});
  };

  const failure = (p: Extract<Phase, { kind: 'failed' }>) => {
    if (p.code === 'NO_PLAN') return t('editor.export.join');
    if (p.code === 'NETWORK') return t('editor.export.offline');
    return p.reason || t('editor.export.unknown');
  };

  const length = range === 'marks' && hasMarks ? marks.out - marks.in : edlDuration(edl);
  const size = exportSize(edl, resolution === '720p' ? 'mp4_720p' : 'mp4_1080p');
  const count = presets.length;
  const fileBase = `captions-${projectId.slice(-8).toLowerCase()}`;

  return (
    <>
    <BrandKitDialog
      open={brandOpen}
      onClose={() => {
        setBrandOpen(false);
        setKitSeq((n) => n + 1);
      }}
      projectId={projectId}
    />
    <Dialog open={open && !brandOpen} onOpenChange={onOpenChange} title={t('editor.export.title')} closeLabel={t('editor.export.close')} width={480}>
      <div className={styles.exportBody} data-testid="export-dialog" data-phase={phase.kind}>
        {phase.kind === 'setup' ? (
          <>
            <div className={styles.exportRow}>
              <span className={styles.inspLabel}>{t('editor.export.range')}</span>
              <SegmentedControl
                label={t('editor.export.range')}
                value={range}
                onValueChange={(v) => setRange(v as 'all' | 'marks')}
                options={[
                  { value: 'all', label: t('editor.export.range.all') },
                  { value: 'marks', label: t('editor.export.range.marks'), disabled: !hasMarks },
                ]}
              />
            </div>
            <div className={styles.exportRow}>
              <span className={styles.inspLabel}>{t('editor.export.resolution')}</span>
              <SegmentedControl
                label={t('editor.export.resolution')}
                value={resolution}
                onValueChange={(v) => setResolution(v as ExportOptions['resolution'])}
                options={[
                  { value: '720p', label: '720p' },
                  { value: '1080p', label: '1080p' },
                ]}
              />
            </div>
            <div className={styles.exportRow} data-testid="export-presets">
              <span className={styles.inspLabel}>{t('post.export.presets')}</span>
              <div className={pStyles.presets}>
                <label className={pStyles.preset}>
                  <input type="checkbox" checked={original} onChange={(e) => setOriginal(e.target.checked)} />
                  {t(`post.export.preset.${resolution === '720p' ? 'mp4_720p' : 'mp4_1080p'}`)}
                  <span className={pStyles.presetMeta}>{t('post.export.presetMeta', { width: size.width, height: size.height })}</span>
                </label>
                {SOCIAL_PRESETS.map((p) => {
                  const s = exportSize(edl, p);
                  return (
                    <label key={p} className={pStyles.preset}>
                      <input type="checkbox" checked={social.includes(p)} onChange={(e) => setSocial((cur) => (e.target.checked ? [...cur, p] : cur.filter((x) => x !== p)))} />
                      {t(`post.export.preset.${p}`)}
                      <span className={pStyles.presetMeta}>{t('post.export.presetMeta', { width: s.width, height: s.height })}</span>
                    </label>
                  );
                })}
              </div>
              {social.length ? <p className={styles.exportHint}>{`${t('post.export.reframeNote')} ${t('post.export.loudness')}`}</p> : null}
            </div>
            {hasCaptions ? (
              <label className={pStyles.check}>
                <Switch checked={burn} onCheckedChange={setBurn} size="sm" aria-label={t('post.export.captions')} />
                <span>{t('post.export.captions')}</span>
              </label>
            ) : null}
            <label className={pStyles.check}>
              <Switch checked={brand && brandReady} onCheckedChange={setBrand} size="sm" aria-label={t('post.export.brand')} disabled={!brandReady} />
              <span>{brandReady ? t('post.export.brand') : t('post.export.brandNone')}</span>
            </label>
            <div className={pStyles.files}>
              <button type="button" className={`${styles.btn} ${styles.secondary}`} onClick={() => setBrandOpen(true)}>
                {t('post.export.brandSetup')}
              </button>
            </div>
            <div className={styles.exportRow}>
              <span className={styles.inspLabel}>{t('post.export.smooth')}</span>
              <SegmentedControl
                label={t('post.export.smooth')}
                value={smooth}
                onValueChange={(v) => {
                  setSmooth(v as Smooth);
                  setPreview({ kind: 'idle' });
                }}
                options={(['off', '48', '60'] as const).filter((v) => v === 'off' || Number(v) > edl.fps).map((v) => ({ value: v, label: t(`post.export.smooth.${v}`) }))}
              />
              {smooth !== 'off' ? (
                <>
                  <p className={styles.exportHint}>{t('post.export.smoothNote')}</p>
                  {preview.kind === 'ready' ? (
                    real ? (
                      <video className={pStyles.preview} src={preview.url} controls muted playsInline aria-label={t('post.export.previewLabel')} data-testid="smooth-preview" />
                    ) : (
                      <p className={styles.exportHint} data-testid="smooth-preview">{t('editor.export.mockNote')}</p>
                    )
                  ) : preview.kind === 'failed' ? (
                    <p className={styles.exportHint} role="alert">{t('editor.export.failed', { reason: preview.reason })}</p>
                  ) : null}
                  <div className={pStyles.files}>
                    <button type="button" className={`${styles.btn} ${styles.secondary}`} disabled={preview.kind === 'running'} onClick={runPreview}>
                      {preview.kind === 'running' ? t('post.export.previewing') : t('post.export.preview')}
                    </button>
                  </div>
                </>
              ) : null}
            </div>
            <p className={styles.exportNote}>
              {t('editor.export.summary', {
                length: formatTimecode(length, edl.fps),
                width: intl.formatNumber(size.width, { useGrouping: false }),
                height: intl.formatNumber(size.height, { useGrouping: false }),
                fps: smooth !== 'off' ? Number(smooth) : edl.fps,
              })}
            </p>
            {hasCaptions ? (
              <div className={styles.exportRow}>
                <span className={styles.inspLabel}>{t('post.export.captionFiles')}</span>
                <div className={pStyles.files}>
                  <button type="button" className={`${styles.btn} ${styles.secondary}`} onClick={() => downloadCaptions(edl, 'srt', fileBase)}>
                    SRT
                  </button>
                  <button type="button" className={`${styles.btn} ${styles.secondary}`} onClick={() => downloadCaptions(edl, 'vtt', fileBase)}>
                    WebVTT
                  </button>
                </div>
              </div>
            ) : null}
            <div className={styles.exportActions}>
              <button type="button" className={`${styles.btn} ${styles.secondary} ${styles.exportBtn}`} onClick={() => onOpenChange(false)}>
                {t('editor.export.cancel')}
              </button>
              <button type="button" className={`${styles.btn} ${styles.primary} ${styles.exportBtn}`} disabled={count === 0} onClick={run}>
                {count > 1 ? t('post.export.batch', { n: count }) : t('editor.export.start')}
              </button>
            </div>
          </>
        ) : null}
        {phase.kind === 'running' ? (
          <>
            <Progress value={phase.progress} label={t('editor.export.progressLabel')} />
            <p className={styles.exportNote} role="status">
              {t('editor.export.progress', { p: phase.progress })}
            </p>
            <div className={styles.exportActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.secondary} ${styles.exportBtn}`}
                onClick={() => {
                  stopAll();
                  setPhase({ kind: 'setup' });
                }}
              >
                {t('editor.export.stop')}
              </button>
            </div>
          </>
        ) : null}
        {phase.kind === 'done' ? (
          <>
            <p className={styles.exportNote} role="status">
              {phase.files.length > 1 ? t('post.export.batchDone', { done: phase.files.length, n: phase.files.length }) : t('editor.export.done', { length: formatTimecode(phase.files[0]!.seconds, edl.fps) })}
            </p>
            {real ? null : <p className={styles.exportHint}>{t('editor.export.mockNote')}</p>}
            <div className={styles.exportActions}>
              <button type="button" className={`${styles.btn} ${styles.secondary} ${styles.exportBtn}`} onClick={() => onOpenChange(false)}>
                {t('editor.export.close')}
              </button>
              {phase.files.map((f) =>
                real ? (
                  <button key={f.exportId} type="button" className={`${styles.btn} ${styles.primary} ${styles.exportBtn}`} onClick={() => save(f)}>
                    {phase.files.length > 1 ? `${t('editor.export.download')} · ${t(`post.export.preset.${f.preset === '720p' || f.preset === '1080p' ? `mp4_${f.preset}` : f.preset}`)}` : t('editor.export.download')}
                  </button>
                ) : (
                  <a key={f.exportId} className={`${styles.btn} ${styles.primary} ${styles.exportBtn}`} href={f.url} download={f.fileName}>
                    {t('editor.export.download')}
                  </a>
                ),
              )}
            </div>
          </>
        ) : null}
        {phase.kind === 'failed' ? (
          <>
            <p className={styles.exportNote} role="alert">
              {t('editor.export.failed', { reason: failure(phase) })}
            </p>
            <div className={styles.exportActions}>
              <button type="button" className={`${styles.btn} ${styles.secondary} ${styles.exportBtn}`} onClick={() => onOpenChange(false)}>
                {t('editor.export.close')}
              </button>
              <button type="button" className={`${styles.btn} ${styles.primary} ${styles.exportBtn}`} onClick={run}>
                {t('editor.export.retry')}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
    </>
  );
}
