import { Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { FormattedMessage } from 'react-intl';
import canvas from './canvas.module.css';

/**
 * Canvas error state (route `errorComponent`): our own screen instead of the
 * router default. The project data is safe on the server; reloading reconnects.
 */
export function CanvasError({ error, reset }: { error: unknown; reset?: () => void }) {
  useEffect(() => {
    console.error('Canvas crashed', error);
  }, [error]);
  return (
    <div className={canvas.root} data-testid="canvas-error">
      <div className={canvas.errorBox} role="alert">
        <h1 className={canvas.errorTitle}>
          <FormattedMessage id="canvas.error.title" />
        </h1>
        <p className={canvas.errorText}>
          <FormattedMessage id="canvas.error.body" />
        </p>
        <div className={canvas.errorActions}>
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
          <Link to="/" className={canvas.errorSecondary}>
            <FormattedMessage id="canvas.backHome" />
          </Link>
        </div>
      </div>
    </div>
  );
}
