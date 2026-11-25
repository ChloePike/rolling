import { useSyncExternalStore } from 'react';

/**
 * Playhead time and transport state, kept outside React state so the timeline
 * canvas and the monitor can follow playback every frame without re-rendering
 * the whole editor.
 */
export class PlayheadStore {
  private listeners = new Set<() => void>();
  private raf = 0;
  private last = 0;
  time: number;
  playing = false;
  duration: number;

  constructor(time = 0, duration = 0) {
    this.time = time;
    this.duration = duration;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit() {
    for (const fn of this.listeners) fn();
  }

  seek(time: number) {
    const t = Math.min(Math.max(0, time), this.duration);
    if (t === this.time) return;
    this.time = t;
    this.emit();
  }

  setDuration(duration: number) {
    this.duration = duration;
    if (this.time > duration) this.seek(duration);
  }

  play() {
    if (this.playing) return;
    if (this.time >= this.duration - 1e-3) this.time = 0;
    this.playing = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.playing) return;
      const t = this.time + (now - this.last) / 1000;
      this.last = now;
      if (t >= this.duration) {
        this.time = this.duration;
        this.playing = false;
        this.emit();
        return;
      }
      this.time = t;
      this.emit();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.emit();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  dispose() {
    this.pause();
    this.listeners.clear();
  }
}

export function usePlayhead<T>(store: PlayheadStore, select: (s: PlayheadStore) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store));
}
