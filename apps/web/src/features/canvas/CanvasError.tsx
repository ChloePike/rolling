import { useToast } from '@rolling/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { setActiveWorkspace } from '@/lib/session';
import canvas from './canvas.module.css';
import { createCanvas, findProjectWorkspace } from './target/projects';

type Reason = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'PROJECT_DELETED';

/**
 * Canvas error state (route `errorComponent`, and fatal project states): our
 * own screen instead of the router default. A crash keeps the project safe on
 * the server; reloading reconnects. A canvas that does not open here (missing,
 * deleted, or in another workspace) offers "Go to your canvases" and "New
 * canvas", and switching workspace when it opens in another one of the user's.
 */
export function CanvasError({ error, reset, reason, projectId }: { error?: unknown; reset?: () => void; reason?: Reason; projectId?: string }) {
  useEffect(() => {
    if (error) console.error('Canvas crashed', error);
  }, [error]);
  const gone = reason === 'NOT_FOUND' || reason === 'PROJECT_DELETED';
  return (
    <div className={canvas.root} data-testid="canvas-error" data-reason={reason ?? 'crash'}>
      <div className={canvas.errorBox} role="alert">
        <h1 className={canvas.errorTitle}>
          <FormattedMessage id={reason ? `canvas.error.${reason}.title` : 'canvas.error.title'} />
        </h1>
        <p className={canvas.errorText}>
          <FormattedMessage id={reason ? `canvas.error.${reason}.body` : 'canvas.error.body'} />
        </p>
        {reason === 'NOT_FOUND' && projectId ? <OtherWorkspace projectId={projectId} /> : null}
        <div className={canvas.errorActions}>
          {reason === 'UNAUTHENTICATED' ? (
            <Link to="/login" className={canvas.errorPrimary}>
              <FormattedMessage id="canvas.error.signIn" />
            </Link>
          ) : null}
          {gone || reason === 'FORBIDDEN' ? (
            <>
              <Link to="/" hash="projects" className={`${canvas.errorPrimary} ${canvas.errorLink}`} data-testid="canvas-error-canvases">
                <FormattedMessage id="canvas.error.yourCanvases" />
              </Link>
              <NewCanvasButton />
            </>
          ) : null}
          {reason ? null : (
            <button
              type="button"
              className={canvas.errorPrimary}
              onClick={() => {
                reset?.();
                window.location.reload();
              }}
            >
              <FormattedMessage id="canvas.error.reload" />
            </button>
          )}
          {gone || reason === 'FORBIDDEN' ? null : (
            <Link to="/" className={canvas.errorSecondary}>
              <FormattedMessage id="canvas.backHome" />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function NewCanvasButton() {
  const intl = useIntl();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={canvas.errorSecondary}
      aria-disabled={busy || undefined}
      data-testid="canvas-error-new"
      onClick={() => {
        if (busy) return;
        setBusy(true);
        void createCanvas(intl.formatMessage({ id: 'home.project.untitled' })).then(
          (id) => void navigate({ to: '/p/$projectId', params: { projectId: id } }),
          () => {
            setBusy(false);
            toast.show({ message: intl.formatMessage({ id: 'canvas.target.createFailed' }) });
          },
        );
      }}
    >
      <FormattedMessage id={busy ? 'canvas.target.creating' : 'canvas.target.new'} />
    </button>
  );
}

/** The project opens in another workspace of the user: offer to switch there. */
function OtherWorkspace({ projectId }: { projectId: string }) {
  const [ws, setWs] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    let live = true;
    void findProjectWorkspace(projectId).then(
      (w) => live && setWs(w),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [projectId]);
  if (!ws) return null;
  return (
    <div className={canvas.errorSwitch} data-testid="canvas-error-workspace">
      <FormattedMessage id="canvas.error.otherWorkspace" values={{ name: ws.name }} />{' '}
      <button
        type="button"
        className={`${canvas.errorSecondary} ${canvas.errorSwitchButton}`}
        data-testid="canvas-error-switch"
        onClick={() => {
          setActiveWorkspace(ws.id);
          // Reopen with the new workspace (every query and the project channel follow it).
          window.location.reload();
        }}
      >
        <FormattedMessage id="canvas.error.switchWorkspace" values={{ name: ws.name }} />
      </button>
    </div>
  );
}
