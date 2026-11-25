import { useEffect, type RefObject } from 'react';

/**
 * Closes an anchored overlay on Escape and on pointer down outside `panel`
 * (and outside `anchor`, usually the trigger, so a trigger click can toggle).
 */
export function useDismiss(
  open: boolean,
  onClose: (() => void) | undefined,
  panel: RefObject<HTMLElement | null>,
  anchor?: RefObject<HTMLElement | null>,
  outside = true,
) {
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor?.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    if (outside) document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, onClose, panel, anchor, outside]);
}
