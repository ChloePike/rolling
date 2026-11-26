import { Dialog, useToast } from '@rolling/ui';
import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { deleteProject } from './projects';
import styles from './target.module.css';

/**
 * Confirms deleting a project (the canvas project menu and the Home project cards). The API has no restore,
 * so this is a clear confirm rather than an undo toast. After the delete `onDeleted` runs (the canvas goes
 * Home); the last-canvas id is forgotten and project lists refresh.
 */
export function DeleteProjectDialog({ project, onClose, onDeleted }: { project: { id: string; title: string } | null; onClose: () => void; onDeleted?: () => void }) {
  const intl = useIntl();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const title = project?.title || intl.formatMessage({ id: 'home.project.untitled' });

  async function confirm() {
    if (!project || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await deleteProject(project.id);
      toast.show({ message: intl.formatMessage({ id: 'canvas.deleteProject.done' }, { title }) });
      onClose();
      onDeleted?.();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={project !== null}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={<FormattedMessage id="canvas.deleteProject.title" values={{ title }} />}
      description={<FormattedMessage id="canvas.deleteProject.body" />}
      closeLabel={intl.formatMessage({ id: 'canvas.shareDialog.close' })}
      width={420}
    >
      {failed ? (
        <p role="alert" className={styles.error}>
          <FormattedMessage id="canvas.deleteProject.failed" />
        </p>
      ) : null}
      <div className={styles.actions} data-testid="delete-project">
        <button type="button" className={styles.cancel} onClick={onClose} disabled={busy}>
          <FormattedMessage id="canvas.target.cancel" />
        </button>
        <button type="button" className={styles.danger} aria-busy={busy || undefined} onClick={() => void confirm()}>
          <FormattedMessage id={busy ? 'canvas.deleteProject.deleting' : 'canvas.deleteProject.confirm'} />
        </button>
      </div>
    </Dialog>
  );
}
