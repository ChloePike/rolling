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
import styles from './Toast.module.css';

export interface ToastOptions {
  message: ReactNode;
  /** Optional action, e.g. Retry or Undo. Clicking it also dismisses the toast. */
  action?: { label: string; onAction: () => void };
  /** Auto-dismiss delay in ms; 0 keeps it until dismissed. Default 5000. */
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

/** Hosts the single global toast, rendered bottom center. */
export function ToastProvider({ dismissLabel, children }: ToastProviderProps) {
  const [toast, setToast] = useState<ActiveToast | null>(null);
  const [paused, setPaused] = useState(false);
  const counter = useRef(0);

  const dismiss = useCallback(() => setToast(null), []);
  const show = useCallback((options: ToastOptions) => {
    counter.current += 1;
    setPaused(false);
    setToast({ ...options, key: counter.current });
  }, []);

  useEffect(() => {
    if (!toast || paused) return;
    const duration = toast.duration ?? 5000;
    if (duration <= 0) return;
    const timer = setTimeout(() => setToast((t) => (t?.key === toast.key ? null : t)), duration);
    return () => clearTimeout(timer);
  }, [toast, paused]);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.region} role="status" aria-live="polite" aria-atomic="true">
        {toast ? (
          <div
            key={toast.key}
            className={styles.toast}
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
