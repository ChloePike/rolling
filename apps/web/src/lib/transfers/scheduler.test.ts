import { describe, expect, it } from 'vitest';
import { etaSeconds, SpeedMeter } from './progress';
import { activeFiles, Aimd, backoffDelay, parseRetryAfter, pickParts, retryDelay, type SchedFile } from './scheduler';

const opts = { baseDelayMs: 100, maxDelayMs: 10_000 };

describe('backoff', () => {
  it('grows exponentially with equal jitter and a cap', () => {
    expect(backoffDelay(1, opts, () => 0)).toBe(50);
    expect(backoffDelay(1, opts, () => 1)).toBe(100);
    expect(backoffDelay(4, opts, () => 0)).toBe(400);
    expect(backoffDelay(4, opts, () => 1)).toBe(800);
    expect(backoffDelay(30, opts, () => 1)).toBe(10_000);
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(3, opts);
      expect(d).toBeGreaterThanOrEqual(200);
      expect(d).toBeLessThanOrEqual(400);
    }
  });

  it('parses Retry-After as seconds or an HTTP date', () => {
    const now = Date.parse('2026-11-25T10:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter('0.5', now)).toBe(500);
    expect(parseRetryAfter('Wed, 25 Nov 2026 10:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it('respects Retry-After over backoff', () => {
    expect(retryDelay(1, '5', opts, 0, () => 0)).toBe(5000);
    expect(retryDelay(1, null, opts, 0, () => 0)).toBe(50);
  });
});

describe('AIMD', () => {
  it('adds one after a stable window and halves on congestion within bounds', () => {
    let t = 0;
    const a = new Aimd(8, 2, 16, () => t, 1000);
    for (let i = 0; i < 8; i++) {
      t += 100;
      a.onSuccess(1000);
    }
    expect(a.cap).toBe(9);
    t += 5000;
    expect(a.onCongestion()).toBe(true);
    expect(a.cap).toBe(4);
    // A burst of failures inside the cooldown counts once.
    expect(a.onCongestion()).toBe(false);
    expect(a.cap).toBe(4);
    t += 2000;
    a.onCongestion();
    t += 2000;
    a.onCongestion();
    t += 2000;
    a.onCongestion();
    expect(a.cap).toBe(2);
  });

  it('does not grow when throughput drops and never exceeds the ceiling', () => {
    let t = 0;
    const a = new Aimd(15, 2, 16, () => t);
    for (let i = 0; i < 15; i++) {
      t += 10;
      a.onSuccess(1000);
    }
    expect(a.cap).toBe(16);
    // Much slower window: no increase.
    for (let i = 0; i < 16; i++) {
      t += 1000;
      a.onSuccess(1000);
    }
    expect(a.cap).toBe(16);
    for (let i = 0; i < 100; i++) {
      t += 1;
      a.onSuccess(1_000_000);
    }
    expect(a.cap).toBe(16);
  });
});

const f = (id: string, size: number, extra: Partial<SchedFile> = {}): SchedFile => ({
  id,
  size,
  priority: 'normal',
  createdAt: 0,
  started: false,
  inFlight: 0,
  pending: 10,
  ...extra,
});

describe('fair scheduling', () => {
  it('keeps started files, fills free slots smallest first, lets one high-priority file jump the limit', () => {
    const files = [f('big', 900, { started: true }), f('a', 300), f('b', 100), f('c', 200), f('d', 50, { priority: 'high' })];
    expect(activeFiles(files, 3).map((x) => x.id)).toEqual(['big', 'd', 'b']);
    const full = [f('x', 1, { started: true }), f('y', 1, { started: true }), f('h', 5, { priority: 'high' }), f('h2', 6, { priority: 'high' })];
    expect(activeFiles(full, 2).map((x) => x.id)).toEqual(['x', 'y', 'h']);
  });

  it('round-robins one part per file per turn under per-file and global caps', () => {
    const files = [f('a', 300), f('b', 100), f('c', 200)];
    expect(pickParts(files, { maxFiles: 4, perFile: 4, globalCap: 5, inFlight: 0 })).toEqual(['b', 'c', 'a', 'b', 'c']);
    expect(pickParts(files, { maxFiles: 4, perFile: 1, globalCap: 8, inFlight: 0 })).toEqual(['b', 'c', 'a']);
    expect(pickParts(files, { maxFiles: 4, perFile: 4, globalCap: 8, inFlight: 7 })).toEqual(['b']);
    expect(pickParts([f('a', 1, { pending: 2 })], { maxFiles: 4, perFile: 4, globalCap: 8, inFlight: 0 })).toEqual(['a', 'a']);
  });

  it('serves high priority first in each turn', () => {
    const files = [f('a', 100), f('h', 900, { priority: 'high' })];
    expect(pickParts(files, { maxFiles: 4, perFile: 4, globalCap: 3, inFlight: 0 })).toEqual(['h', 'a', 'h']);
  });
});

describe('speed', () => {
  it('smooths bytes per second and gives an ETA', () => {
    let t = 0;
    const m = new SpeedMeter(0.5, () => t, 0);
    m.sample(0);
    t = 1000;
    expect(m.sample(1000)).toBe(1000);
    t = 2000;
    expect(m.sample(4000)).toBe(2000);
    expect(etaSeconds(4000, 2000)).toBe(2);
    expect(etaSeconds(10, 0)).toBeNull();
    expect(etaSeconds(0, 0)).toBe(0);
  });
});
