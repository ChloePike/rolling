import { Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { FormattedMessage } from 'react-intl';
import canvas from './canvas.module.css';

/**
 * Canvas error state (route `errorComponent`): our own screen instead of the
 * router default. The project data is safe on the server; reloading reconnects.
 */
export function CanvasError({ error, reset, reason }: { error?: unknown; reset?: () => void; reason?: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'PROJECT_DELETED' }) {
  useEffect(() => {
    if (error) console.error('Canvas crashed', error);
  }, [error]);
  return (
    <div className={canvas.root} data-testid="canvas-error" data-reason={reason ?? 'crash'}>
      <div className={canvas.errorBox} role="alert">
        <h1 className={canvas.errorTitle}>
          <FormattedMessage id={reason ? `canvas.error.${reason}.title` : 'canvas.error.title'} />
        </h1>
        <p className={canvas.errorText}>
          <FormattedMessage id={reason ? `canvas.error.${reason}.body` : 'canvas.error.body'} />
        </p>
        <div className={canvas.errorActions}>
          {reason === 'UNAUTHENTICATED' ? (
            <Link to="/login" className={canvas.errorPrimary}>
              <FormattedMessage id="canvas.error.signIn" />
            </Link>
          ) : null}
          {reason && reason !== 'FORBIDDEN' ? null : (
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
          <Link to="/" className={canvas.errorSecondary}>
            <FormattedMessage id="canvas.backHome" />
          </Link>
        </div>
      </div>
    </div>
  );
}
