import { useEffect, useRef } from 'react';

const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),textarea:not([disabled]),select,[tabindex]:not([tabindex="-1"])';

/**
 * Keyboard and focus for a canvas layer: Escape closes, focus moves to the
 * layer on open (modal layers trap Tab) and returns to the opener on close.
 */
export function useLayer<T extends HTMLElement>(open: boolean, onClose: () => void, options: { modal?: boolean; focus?: boolean } = {}) {
  const ref = useRef<T>(null);
  const { modal = false, focus = true } = options;
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    // Focus the layer itself (tabIndex -1) so the next Tab reaches its first control.
    if (focus && el) el.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
        return;
      }
      if (!modal || e.key !== 'Tab' || !el) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [open, modal, focus]);

  return ref;
}
