import { cx, Dialog, useToast } from '@rolling/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { MenuPopover } from '@/features/canvas/layers/Menu';
import { renameRecentProject } from './api';
import type { ProjectSummary } from './types';
import styles from './HomePage.module.css';
import { lazyLayer } from '@/lib/lazy';

/** Loaded on demand (bundle splitting): opens from the card's menu. */
const DeleteProjectDialog = lazyLayer(
  () => import('@/features/canvas/target/DeleteProjectDialog'),
  (m) => m.DeleteProjectDialog,
  (p) => p.project != null,
);

/**
 * A Home project card (Main.dc.html “My projects”) with a “…” menu: Rename and Delete. The button shows on
 * hover and keyboard focus only, so the card reads as in the design.
 */
export function ProjectCard({ project: p, meta }: { project: ProjectSummary; meta: string }) {
  const intl = useIntl();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const label = intl.formatMessage({ id: 'home.project.menu' }, { title: p.title });
  return (
    <div className={styles.projectCard} data-project={p.id} data-open={menu || undefined}>
      <Link to="/p/$projectId" params={{ projectId: p.id }} className={styles.project}>
        <div className={styles.projectThumb} style={p.thumbUrl ? { background: `center / cover no-repeat url("${p.thumbUrl}"), ${p.tone}` } : { background: p.tone }}>
          <span className={styles.badge}>
            <FormattedMessage id={`home.project.kind.${p.kind}`} />
          </span>
        </div>
        <span className={styles.projectName}>{p.title}</span>
        <span className={styles.projectMeta}>{meta}</span>
      </Link>
      <MenuPopover
        open={menu}
        onOpenChange={setMenu}
        label={label}
        align="end"
        entries={[
          { key: 'rename', label: intl.formatMessage({ id: 'home.project.rename' }), onSelect: () => setRenaming(true) },
          { key: 'delete', label: intl.formatMessage({ id: 'home.project.delete' }), danger: true, onSelect: () => setDeleting(true) },
        ]}
        trigger={(t) => (
          <button {...t} type="button" className={styles.projectMore} aria-label={label}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="19" cy="12" r="1.8" />
            </svg>
          </button>
        )}
      />
      <RenameProjectDialog project={renaming ? p : null} onClose={() => setRenaming(false)} />
      <DeleteProjectDialog project={deleting ? { id: p.id, title: p.title } : null} onClose={() => setDeleting(false)} />
    </div>
  );
}

function RenameProjectDialog({ project, onClose }: { project: ProjectSummary | null; onClose: () => void }) {
  const intl = useIntl();
  const toast = useToast();
  const qc = useQueryClient();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (project) {
      setValue(project.title);
      setError(null);
      requestAnimationFrame(() => input.current?.select());
    }
  }, [project]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!project || busy) return;
    if (!value.trim()) return setError(intl.formatMessage({ id: 'home.project.rename.empty' }));
    setBusy(true);
    try {
      const title = await renameRecentProject(project.id, value);
      await qc.invalidateQueries({ queryKey: ['projects'] });
      toast.show({ message: intl.formatMessage({ id: 'canvas.toast.renamed' }, { title }) });
      onClose();
    } catch {
      setError(intl.formatMessage({ id: 'home.project.rename.failed' }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={project !== null}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={<FormattedMessage id="home.project.rename.title" />}
      closeLabel={intl.formatMessage({ id: 'canvas.shareDialog.close' })}
      width={400}
    >
      <form onSubmit={(e) => void submit(e)} className={styles.renameForm}>
        <label htmlFor={id} className={styles.renameLabel}>
          <FormattedMessage id="canvas.project.renameLabel" />
        </label>
        <input id={id} ref={input} className={styles.renameInput} value={value} maxLength={120} onChange={(e) => setValue(e.target.value)} />
        {error ? (
          <p role="alert" className={styles.renameError}>
            {error}
          </p>
        ) : null}
        <div className={styles.renameActions}>
          <button type="button" className={styles.renameCancel} onClick={onClose} disabled={busy}>
            <FormattedMessage id="canvas.target.cancel" />
          </button>
          <button type="submit" className={cx(styles.renameSave)} aria-busy={busy || undefined}>
            <FormattedMessage id="home.project.rename.save" />
          </button>
        </div>
      </form>
    </Dialog>
  );
}
