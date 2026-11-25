import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { duration } from '../motion';
import styles from './Toast.module.css';

export interface ToastOptions {
  message: ReactNode;
  /** Optional action, e.g. Retry or Undo. Clicking it also dismisses the toast. */
  action?: { label: string; onAction: () => void };
  /** Auto-dismiss delay in ms; 0 keeps it until dismissed. Default 4000 (Motion.dc.html). */
  duration?: number;
}

interface ActiveToast extends ToastOptions {
  key: number;
}

export interface ToastApi {
  /** Shows a toast, replacing the current one (one at a time). */
  show: (options: ToastOptions) => void;
  dismiss: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export interface ToastProviderProps {
  /** Accessible name of the dismiss button. */
  dismissLabel: string;
  children: ReactNode;
}

/**
 * Hosts the single global toast, rendered bottom center. Motion (Motion.dc.html
 * "Toast"): 200ms in from 12px below with the standard curve, 4s hold by
 * default, 140ms fade out with the exit curve.
 */
export function ToastProvider({ dismissLabel, children }: ToastProviderProps) {
  const [toast, setToast] = useState<ActiveToast | null>(null);
  const [leaving, setLeaving] = useState<ActiveToast | null>(null);
  const [paused, setPaused] = useState(false);
  const counter = useRef(0);
  const current = useRef<ActiveToast | null>(null);
  current.current = toast;

  const retire = useCallback((t: ActiveToast | null) => {
    if (!t) return;
    setLeaving(t);
  }, []);
  const dismiss = useCallback(() => {
    retire(current.current);
    setToast(null);
  }, [retire]);
  const show = useCallback(
    (options: ToastOptions) => {
      counter.current += 1;
      setPaused(false);
      retire(current.current);
      setToast({ ...options, key: counter.current });
    },
    [retire],
  );

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving((l) => (l?.key === leaving.key ? null : l)), duration.fast);
    return () => clearTimeout(timer);
  }, [leaving]);

  useEffect(() => {
    if (!toast || paused) return;
    const hold = toast.duration ?? 4000;
    if (hold <= 0) return;
    const timer = setTimeout(() => {
      if (current.current?.key === toast.key) dismiss();
    }, hold);
    return () => clearTimeout(timer);
  }, [toast, paused, dismiss]);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {leaving ? (
        <div className={styles.region} aria-hidden="true">
          <div key={leaving.key} className={`rl-toast ${styles.toast}`} data-state="closed" data-motion="" inert>
            <span className={styles.message}>{leaving.message}</span>
            {leaving.action ? <span className={styles.action}>{leaving.action.label}</span> : null}
            <span className={styles.dismiss} />
          </div>
        </div>
      ) : null}
      <div className={styles.region} role="status" aria-live="polite" aria-atomic="true">
        {toast ? (
          <div
            key={toast.key}
            className={`rl-toast ${styles.toast}`}
            data-state="open"
            data-motion=""
            onPointerEnter={() => setPaused(true)}
            onPointerLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
          >
            <span className={styles.message}>{toast.message}</span>
            {toast.action ? (
              <button
                type="button"
                className={styles.action}
                onClick={() => {
                  toast.action?.onAction();
                  dismiss();
                }}
              >
                {toast.action.label}
              </button>
            ) : null}
            <button type="button" className={styles.dismiss} aria-label={dismissLabel} onClick={dismiss}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18 M6 6l12 12" />
              </svg>
            </button>
          </div>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
