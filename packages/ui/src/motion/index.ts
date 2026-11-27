import { useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * Motion tokens (handoff 7, Motion.dc.html) as numbers for JS timing.
 * CSS uses the matching variables: --dur-instant/fast/base/slow/brand and
 * --ease-standard/exit/spring (see tokens.css).
 */
export const duration = {
  /** 80ms: press, toggles. */
  instant: 80,
  /** 140ms: hover, closing. */
  fast: 140,
  /** 200ms: popovers, menus, toasts. */
  base: 200,
  /** 320ms: panels, modals, node build, timeline edits. */
  slow: 320,
  /** 400ms: splash only. */
  brand: 400,
  /** 600ms: cross-fade between two media items (login showcase); --m-crossfade. */
  crossfade: 600,
  /** 150ms: agent-built nodes appear this far apart; --m-build-stagger. */
  buildStagger: 150,
  /** 150ms: skeletons stay hidden this long; --m-skeleton-delay. */
  skeletonDelay: 150,
  /** 200ms: the longest fade under reduced motion; --dur-reduced. */
  reduced: 200,
} as const;

export const easing = {
  /** Anything entering or moving. */
  standard: 'cubic-bezier(.2,0,0,1)',
  /** Anything leaving. */
  exit: 'cubic-bezier(.4,0,1,1)',
  /** Logo and splash only. */
  spring: 'cubic-bezier(.3,1.4,.4,1)',
} as const;

/**
 * Length in ms for motion driven from JS (canvas pan/zoom/fit, smooth scrolls):
 * the token, or 0 when the user asked for reduced motion (CSS overrides cannot
 * reach these). Read at call time, so it follows the setting live.
 */
export function motionMs(length: keyof typeof duration): number {
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 0;
  return duration[length];
}

/** The curves as cubic-bezier control points, for `motion` (motion.dev) transitions. */
export const bezier = {
  standard: [0.2, 0, 0, 1],
  exit: [0.4, 0, 1, 1],
  spring: [0.3, 1.4, 0.4, 1],
} as const;

/**
 * A `motion` (motion.dev) tween on the tokens: `transition={tween('base')}`.
 * Use it for layout animation only (CLAUDE.md); everything else is CSS. Pass
 * `reduced` (usePrefersReducedMotion) to make the move instant.
 */
export function tween(
  length: keyof typeof duration = 'base',
  curve: keyof typeof bezier = 'standard',
  reduced = false,
): { type: 'tween'; duration: number; ease: [number, number, number, number] } {
  const [a, b, c, d] = bezier[curve];
  return { type: 'tween', duration: reduced ? 0 : duration[length] / 1000, ease: [a, b, c, d] };
}

/** List stagger: 30ms apart, at most 6 steps (rows after the sixth enter together). */
export const STAGGER_MS = 30;
export const STAGGER_MAX = 6;

export type PresenceState = 'open' | 'closed';

export interface Presence {
  /** Render the element while true (stays true during the exit animation). */
  mounted: boolean;
  /** `open` while shown, `closed` while playing the exit. Put it on `data-state`. */
  state: PresenceState;
}

/**
 * Mount → animate → unmount. Keeps an element mounted for `exitMs` after
 * `open` turns false so its exit keyframes (exit curve, shorter than the enter)
 * can play. Pair with a presence class from base.css (`rl-pop`, `rl-modal`,
 * `rl-fade`, `rl-panel`, `rl-toast`) and spread `presenceProps(state)`.
 */
export function usePresence(open: boolean, exitMs: number = duration.fast): Presence {
  const [mounted, setMounted] = useState(open);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    timer.current = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(timer.current);
    // `mounted` is read only to skip a no-op timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, exitMs]);
  return { mounted: open || mounted, state: open ? 'open' : 'closed' };
}

/**
 * Attributes for a presence element: `data-state` drives the enter/exit
 * keyframes, `data-motion` marks it as token-based (kept as a fade under
 * reduced motion), and a closing element is hidden from assistive tech and inert.
 */
export function presenceProps(state: PresenceState): {
  'data-state': PresenceState;
  'data-motion': '';
  'aria-hidden'?: true;
  inert?: boolean;
} {
  return state === 'closed'
    ? { 'data-state': state, 'data-motion': '', 'aria-hidden': true, inert: true }
    : { 'data-state': state, 'data-motion': '' };
}

/**
 * Style for the i-th row of a staggered list; add the `rl-stagger` class
 * (200ms rise, 30ms apart, capped at the sixth row). Use `rl-build` with the
 * same helper for agent-built nodes (150ms apart).
 */
export function staggerStyle(index: number, style?: CSSProperties): CSSProperties {
  return { ...style, ['--rl-i' as string]: Math.min(Math.max(0, index), STAGGER_MAX - 1) };
}

/** Props that mark an element's own animations as built on the motion tokens. */
export const motionSafe = { 'data-motion': '' } as const;

/** True when the user asked for reduced motion. Updates live. */
export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia?.(query);
    if (!mql) return;
    const on = () => setReduced(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, []);
  return reduced;
}
