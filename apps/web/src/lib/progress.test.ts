import { describe, expect, it } from 'vitest';
import { elapsedClock, knownProgress } from './progress';

describe('progress (real progress only)', () => {
  it('treats 0, missing and invalid values as no progress reported', () => {
    expect(knownProgress(0)).toBeNull();
    expect(knownProgress(null)).toBeNull();
    expect(knownProgress(undefined)).toBeNull();
    expect(knownProgress(Number.NaN)).toBeNull();
    expect(knownProgress(-0.2)).toBeNull();
    expect(knownProgress(0.42)).toBe(0.42);
    expect(knownProgress(1.4)).toBe(1);
  });

  it('formats elapsed time as m:ss', () => {
    expect(elapsedClock(0)).toBe('0:00');
    expect(elapsedClock(125.7)).toBe('2:05');
    expect(elapsedClock(-3)).toBe('0:00');
  });
});
