import type { Page } from '@playwright/test';

/**
 * Motion probes for e2e (docs/motion-audit.md). `recordMotion` installs a
 * listener before the app loads that logs every CSS animation and transition
 * as it starts: element, name/property, timing, and whether it moves (the
 * transform at its first and last frame differ, sampled by seeking the
 * animation). `motionLog` reads the log; `layoutShift` sums layout-shift
 * entries (CLS-like, without the input exclusion window filtering).
 */
export interface MotionEntry {
  kind: 'animation' | 'transition';
  el: string;
  name: string;
  duration: number;
  delay: number;
  iterations: number;
  easing: string;
  moves: boolean;
}

export async function recordMotion(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __motion: unknown[]; __shift: number; __shifts: Array<{ v: number; src: string }> };
    w.__motion = [];
    w.__shift = 0;
    w.__shifts = [];
    const desc = (el: Element) => {
      const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
      const tid = el.getAttribute('data-testid');
      return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${tid ? `[${tid}]` : ''}`;
    };
    const identity = (t: string) => t === 'none' || /^matrix\(1, 0, 0, 1, 0, 0\)$/.test(t);
    const shape = (cs: CSSStyleDeclaration) => [cs.transform, cs.translate, cs.scale, cs.rotate].join('|');
    const probe = (anim: Animation | undefined, el: Element, pseudo: string | null) => {
      if (!anim) return { moves: false, duration: 0, delay: 0, iterations: 1 };
      const timing = anim.effect!.getComputedTiming();
      const duration = Number(timing.duration) || 0;
      const read = () => shape(getComputedStyle(el, pseudo));
      const wasPaused = anim.playState === 'paused';
      const saved = anim.currentTime;
      let moves = false;
      try {
        anim.pause();
        const start = Number(timing.delay) || 0;
        anim.currentTime = start;
        const first = read();
        anim.currentTime = start + duration / 2;
        const mid = read();
        anim.currentTime = start + Math.max(0, duration - 1);
        const last = read();
        moves = first !== last || mid !== last;
        // A still element whose transform is identity throughout does not move.
        if (moves && [first, mid, last].every((s) => identity(s.split('|')[0]!) && s.split('|').slice(1).every((p) => p === 'none'))) moves = false;
      } finally {
        anim.currentTime = saved;
        if (!wasPaused) anim.play();
      }
      return { moves, duration, delay: Number(timing.delay) || 0, iterations: Number(timing.iterations) };
    };
    /** Splits a computed list (`a, cubic-bezier(1, 2), b`) at top-level commas. */
    const list = (v: string) => v.split(/,(?![^(]*\))/).map((x) => x.trim());
    const ms = (v: string) => (v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000);
    document.addEventListener(
      'animationstart',
      (e) => {
        const el = e.target as Element;
        const anim = el.getAnimations().find((a) => (a as CSSAnimation).animationName === e.animationName);
        const cs = getComputedStyle(el, e.pseudoElement || null);
        const i = Math.max(0, list(cs.animationName).indexOf(e.animationName));
        const easing = list(cs.animationTimingFunction);
        w.__motion.push({ kind: 'animation', el: desc(el), name: e.animationName, easing: easing[i % easing.length], ...probe(anim, el, e.pseudoElement || null) });
      },
      true,
    );
    document.addEventListener(
      'transitionrun',
      (e) => {
        const el = e.target as Element;
        const anim = el.getAnimations().find((a) => (a as CSSTransition).transitionProperty === e.propertyName);
        // The declared timing: an interrupted transition that reverses runs shorter on purpose.
        const cs = getComputedStyle(el, e.pseudoElement || null);
        const props = list(cs.transitionProperty);
        let i = props.indexOf(e.propertyName);
        if (i < 0) i = Math.max(0, props.indexOf('all'));
        const durs = list(cs.transitionDuration);
        const eases = list(cs.transitionTimingFunction);
        const probed = probe(anim, el, e.pseudoElement || null);
        w.__motion.push({ kind: 'transition', el: desc(el), name: e.propertyName, ...probed, duration: ms(durs[i % durs.length]!), easing: eases[i % eases.length]! });
      },
      true,
    );
    try {
      new PerformanceObserver((list) => {
        for (const en of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node }> }>) {
          if (en.hadRecentInput) continue;
          w.__shift += en.value;
          w.__shifts.push({ v: en.value, src: (en.sources ?? []).map((s) => (s.node instanceof Element ? desc(s.node) : '')).join(' | ') });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      /* layout-shift is Chromium only */
    }
  });
}

export async function motionLog(page: Page, clear = false): Promise<MotionEntry[]> {
  return page.evaluate((c) => {
    const w = window as unknown as { __motion: MotionEntry[] };
    const out = w.__motion.slice();
    if (c) w.__motion = [];
    return out;
  }, clear);
}

export async function clearMotion(page: Page) {
  await page.evaluate(() => ((window as unknown as { __motion: unknown[] }).__motion = []));
}

export async function layoutShift(page: Page): Promise<{ total: number; shifts: Array<{ v: number; src: string }> }> {
  return page.evaluate(() => {
    const w = window as unknown as { __shift: number; __shifts: Array<{ v: number; src: string }> };
    return { total: w.__shift, shifts: w.__shifts };
  });
}

/** Under reduced motion: nothing moves, no loop runs, no fade is longer than --dur-reduced (200ms). */
export function reducedMotionViolations(log: MotionEntry[]): string[] {
  const out: string[] = [];
  for (const m of log) {
    const what = `${m.kind} ${m.name} on ${m.el}`;
    if (m.moves) out.push(`${what} moves`);
    if (!Number.isFinite(m.iterations)) out.push(`${what} loops`);
    if (m.duration > 200) out.push(`${what} lasts ${Math.round(m.duration)}ms`);
  }
  return [...new Set(out)];
}

/** Token durations (handoff 7) plus the crossfade and status loops in tokens.css. */
export const TOKEN_MS = [0, 1, 80, 140, 200, 320, 400, 600, 800, 1000, 1200, 1600];
