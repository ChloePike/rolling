import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/**
 * Sliding selection indicator (nav pill, tabs, segmented controls).
 *
 * Measures the selected child of `container` (by `selector`, default
 * `[aria-checked="true"],[aria-selected="true"],[aria-current="page"]`) and
 * returns a style that places an absolutely positioned indicator over it.
 * The first placement does not animate; later moves slide with the standard
 * curve over `--dur-base` (transform + width). Under reduced motion only
 * opacity transitions, so the indicator jumps.
 *
 * Render the indicator as the container's first child with `position:absolute`
 * and the container with `position:relative`.
 */
export function useIndicator(
  container: RefObject<HTMLElement | null>,
  key: unknown,
  selector = '[aria-checked="true"],[aria-selected="true"],[aria-current="page"]',
): CSSProperties {
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const placed = useRef(false);
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const measure = () => {
      const el = root.querySelector<HTMLElement>(selector);
      if (!el) {
        setBox(null);
        return;
      }
      setBox({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
    };
    measure();
    if (!placed.current) {
      placed.current = true;
      // Enable transitions only after the first paint so the initial placement is instant.
      requestAnimationFrame(() => requestAnimationFrame(() => setAnimate(true)));
    }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(root);
    return () => ro?.disconnect();
  }, [container, key, selector]);

  if (!box) return { opacity: 0 };
  return {
    position: 'absolute',
    left: 0,
    top: box.y,
    width: box.w,
    height: box.h,
    transform: `translateX(${box.x}px)`,
    transition: animate
      ? 'transform var(--dur-base) var(--ease-standard), width var(--dur-base) var(--ease-standard), opacity var(--dur-fast) var(--ease-standard)'
      : 'none',
    pointerEvents: 'none',
  };
}
