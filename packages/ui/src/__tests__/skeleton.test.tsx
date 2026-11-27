import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Skeleton } from '../index';

afterEach(cleanup);

// Vitest runs from the package root.
const css = readFileSync(join(process.cwd(), 'src/components/Skeleton.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('Skeleton', () => {
  it('is a decorative block sized like its content', () => {
    const { container } = render(<Skeleton width={120} height={14} radius={4} />);
    const el = container.querySelector('[data-skeleton]') as HTMLElement;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.style.width).toBe('120px');
    expect(el.style.height).toBe('14px');
    expect(el.style.borderRadius).toBe('4px');
    // Marked as token-based, so the reduced-motion safety net keeps its 150ms delay (no flash).
    expect(el.hasAttribute('data-motion')).toBe(true);
  });

  it('uses theme tokens only, no gradient or shimmer, appears after a delay and is static under reduced motion', () => {
    expect(css).not.toMatch(/gradient/i);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).toMatch(/var\(--c-surface-5\)/);
    expect(css).toMatch(/--rl-skeleton-delay,var\(--m-skeleton-delay\)/);
    const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
    expect(reduced).not.toMatch(/pulse/);
  });
});
