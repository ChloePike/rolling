import { describe, expect, it } from 'vitest';
import { checkMotion, scanText } from '../../scripts/check-motion.mjs';

/**
 * Motion tokens only (handoff 7, docs/motion-audit.md): no hard-coded transition
 * or animation durations, delays or easings outside packages/ui/tokens.css and
 * the JS mirror in @rolling/ui (`duration`, `easing`, `tween`).
 */
describe('motion tokens guard', () => {
  it('finds no hard-coded durations or easings in apps/web and packages/ui', () => {
    const { files, problems } = checkMotion();
    expect(files).toBeGreaterThan(100);
    expect(problems.map((p) => `${p.file}:${p.line}: ${p.found}`)).toEqual([]);
  });

  it('flags literals in CSS modules, inline styles, motion.dev transitions and presence timers', () => {
    const css = scanText(
      'a.module.css',
      '.a{transition:opacity 200ms ease,transform var(--dur-fast) var(--ease-standard)}\n.b{animation:spin .8s linear infinite}\n.c{animation-delay:calc(var(--rl-i) * 150ms)}\n.d{transition:width var(--dur-slow) linear;animation:x var(--m-base) cubic-bezier(.2,0,0,1)}',
    ).map((p) => p.found);
    expect(css).toEqual(['transition: 200ms', 'transition: ease', 'animation: .8s', 'animation-delay: 150ms', 'animation: cubic-bezier(.2,0,0,1)']);
    const ts = scanText(
      'a.tsx',
      "const s = { transition: 'opacity .2s ease-out' };\nconst SLIDE = { type: 'tween', duration: 0.2, ease: [0.2, 0, 0, 1] };\n<m.div transition={{ duration: 0.3 }} />\nconst p = usePresence(open, 140);\nconst ok = { transition: 'opacity var(--dur-fast) var(--ease-exit)' };\nconst d = { animationDelay: `${i * 150}ms` };\nflow.fitView({ duration: 320, padding: 0.1 });\nflow.zoomIn({ duration: motionMs('base') });",
    ).map((p) => p.found);
    expect(ts).toEqual([
      'transition: .2s',
      'transition: ease-out',
      'animationDelay: computed time ${i * 150}ms',
      'fitView duration: 320',
      'usePresence exit: 140',
      'motion duration: 0.2',
      'motion ease: [0.2, 0, 0, 1]',
      'motion duration: 0.3',
    ]);
  });

  it('flags a shared rl-* keyframe used from a CSS module without global()', () => {
    const css = '.a{animation:rl-row-in var(--dur-base) var(--ease-standard) both}\n.b{animation:global(rl-fade-in) var(--dur-fast) var(--ease-standard)}\n.c{animation:rl-own var(--dur-base) linear}\n@keyframes rl-own{to{opacity:1}}';
    expect(scanText('a.module.css', css).map((p) => p.found)).toEqual(['animation: rl-row-in needs global(rl-row-in) in a CSS module']);
    expect(scanText('base.css', css)).toEqual([]);
  });

  it('ignores comments, zero times, `none`, `linear` and token names', () => {
    expect(scanText('a.css', '/* 200ms ease */.a{transition:none;animation:x 0s linear var(--m-skeleton-delay) forwards}')).toEqual([]);
    expect(scanText('a.tsx', "// transition: '1s ease'\nconst t = { transition: 'opacity var(--dur-base) var(--ease-standard)' };")).toEqual([]);
  });
});
