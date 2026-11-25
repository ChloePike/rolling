import { Dialog, Progress, SegmentedControl } from '@rolling/ui';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { formatTimecode, edlDuration, type Edl } from '@rolling/core/timeline';
import { startExport, type ExportEvent, type ExportOptions } from './api';
import styles from './Editor.module.css';
import { isMockApi } from '@/features/overlays/backend';

type Phase = { kind: 'soon' } | { kind: 'setup' } | { kind: 'running'; progress: number } | { kind: 'done'; url: string; fileName: string; seconds: number } | { kind: 'failed'; reason: string };

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  edl: Edl;
  marks: { in: number; out: number };
  /** Called once the export finished (e.g. to toast). */
  onDone?: (fileName: string) => void;
}

/**
 * Export (MP4): range and resolution, then real progress from the export job,
 * then a download link. Cancel stops the job; a failure says so and offers Retry.
 */
export function ExportDialog({ open, onOpenChange, projectId, edl, marks, onDone }: ExportDialogProps) {
  const intl = useIntl();
  const t = (id: string, v?: Record<string, string | number>) => intl.formatMessage({ id }, v);
  const [range, setRange] = useState<ExportOptions['range']>('all');
  const [resolution, setResolution] = useState<ExportOptions['resolution']>('1080p');
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  const cancel = useRef<(() => void) | null>(null);
  const hasMarks = marks.out > marks.in;

  useEffect(() => {
    if (!open) {
      cancel.current?.();
      cancel.current = null;
      setPhase({ kind: 'setup' });
    }
  }, [open]);
  useEffect(() => () => cancel.current?.(), []);

  const run = () => {
    // Real mode: the API has no export route yet (ExportWorkflow is a stub). Say so instead of faking an MP4.
    if (!isMockApi()) {
      setPhase({ kind: 'soon' });
      return;
    }
    setPhase({ kind: 'running', progress: 0 });
    cancel.current = startExport(projectId, edl, { range, marks, resolution }, (e: ExportEvent) => {
      if (e.type === 'progress') setPhase({ kind: 'running', progress: e.progress });
      else if (e.type === 'failed') setPhase({ kind: 'failed', reason: e.reason });
      else {
        cancel.current = null;
        setPhase({ kind: 'done', url: e.url, fileName: e.fileName, seconds: e.seconds });
        onDone?.(e.fileName);
      }
    });
  };

  const length = range === 'marks' && hasMarks ? marks.out - marks.in : edlDuration(edl);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('editor.export.title')} closeLabel={t('editor.export.close')} width={440}>
      <div className={styles.exportBody} data-testid="export-dialog" data-phase={phase.kind}>
        {phase.kind === 'setup' ? (
          <>
            <div className={styles.exportRow}>
              <span className={styles.inspLabel}>{t('editor.export.range')}</span>
              <SegmentedControl
                label={t('editor.export.range')}
                value={range}
                onValueChange={(v) => setRange(v as ExportOptions['range'])}
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
            <p className={styles.exportNote}>
              {t('editor.export.summary', {
                length: formatTimecode(length, edl.fps),
                width: intl.formatNumber(edl.width, { useGrouping: false }),
                height: intl.formatNumber(edl.height, { useGrouping: false }),
                fps: edl.fps,
              })}
            </p>
            <div className={styles.exportActions}>
              <button type="button" className={`${styles.btn} ${styles.secondary} ${styles.exportBtn}`} onClick={() => onOpenChange(false)}>
                {t('editor.export.cancel')}
              </button>
              <button type="button" className={`${styles.btn} ${styles.primary} ${styles.exportBtn}`} onClick={run}>
                {t('editor.export.start')}
              </button>
            </div>
          </>
        ) : null}
        {phase.kind === 'soon' ? (
          <>
            <p className={styles.exportNote} role="status" data-testid="export-soon">
              {t('editor.export.soon')}
            </p>
            <div className={styles.exportActions}>
              <button type="button" className={`${styles.btn} ${styles.primary} ${styles.exportBtn}`} onClick={() => onOpenChange(false)}>
                {t('editor.export.close')}
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
                  cancel.current?.();
                  cancel.current = null;
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
              {t('editor.export.done', { length: formatTimecode(phase.seconds, edl.fps) })}
            </p>
            <p className={styles.exportHint}>{t('editor.export.mockNote')}</p>
            <div className={styles.exportActions}>
              <button type="button" className={`${styles.btn} ${styles.secondary} ${styles.exportBtn}`} onClick={() => onOpenChange(false)}>
                {t('editor.export.close')}
              </button>
              <a className={`${styles.btn} ${styles.primary} ${styles.exportBtn}`} href={phase.url} download={phase.fileName}>
                {t('editor.export.download')}
              </a>
            </div>
          </>
        ) : null}
        {phase.kind === 'failed' ? (
          <>
            <p className={styles.exportNote} role="alert">
              {t('editor.export.failed', { reason: phase.reason })}
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
  );
}
