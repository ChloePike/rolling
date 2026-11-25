import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeedItem, MediaRun, MediaTile } from '../types';

/**
 * Tool runs on mock data (`POST /api/runs` → job progress over the user
 * socket, docs/api.md). A started run goes through the same states the
 * backend produces: queued → running with real-looking progress → done, or
 * failed with the hold released. Test seams on `window.__rollingMocks`:
 * `runTickMs` (progress step interval, default 350ms) and `runFails`
 * (the next runs fail at 40%).
 */
export interface RunSpec {
  prompt: string;
  aspect: string;
  video: boolean;
  tags: string[];
  /** Tile labels (characters: "Full body", "Face"); one unlabeled tile when empty. */
  tiles: Array<string | undefined>;
  /** Step labels before the generating step, e.g. ["Find shot 2", "Seedance 2.5"]. */
  steps: string[];
  /** Label of the generating step; `{pct}` is replaced by the percentage. */
  generating: (pct: number) => string;
  durationSec?: number;
  cost: number;
  actions: MediaRun['actions'];
}

interface Mocks {
  runTickMs?: number;
  runFails?: boolean;
}
const mocks = (): Mocks => (typeof window !== 'undefined' ? ((window as unknown as { __rollingMocks?: Mocks }).__rollingMocks ?? {}) : {});

const TONES = ['var(--c-tone-indigo)', 'var(--c-tone-plum)', 'var(--c-tone-teal)', 'var(--c-tone-sand)'];
let seq = 0;

export interface RunEvents {
  onDone?: (run: MediaRun) => void;
  onFail?: (run: MediaRun) => void;
}

export function useRuns(seed: FeedItem[], events: RunEvents = {}) {
  const [items, setItems] = useState<FeedItem[]>(seed);
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set());
  const timers = useRef(new Map<string, number>());
  const specs = useRef(new Map<string, RunSpec>());
  const ev = useRef(events);
  ev.current = events;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const id of t.values()) window.clearInterval(id);
      t.clear();
    };
  }, []);

  const stop = (id: string) => {
    const t = timers.current.get(id);
    if (t !== undefined) window.clearInterval(t);
    timers.current.delete(id);
  };

  const update = (id: string, fn: (r: MediaRun) => MediaRun) =>
    setItems((all) => all.map((it) => (it.id === id && it.kind === 'media' ? fn(it) : it)));

  const start = useCallback((spec: RunSpec): string => {
    const id = `run_new_${++seq}`;
    specs.current.set(id, spec);
    const tone = TONES[seq % TONES.length]!;
    const tiles: MediaTile[] = (spec.tiles.length ? spec.tiles : [undefined]).map((label) => (label ? { label, tone: 'var(--c-tone-blank)' } : { tone: 'var(--c-tone-blank)' }));
    const steps = (pct: number) => [
      ...spec.steps.map((label) => ({ label, state: 'done' as const })),
      { label: spec.generating(pct), state: 'now' as const },
    ];
    const run: MediaRun = { kind: 'media', id, aspect: spec.aspect, tiles, prompt: spec.prompt, tags: spec.tags, progress: 0, video: spec.video, steps: steps(0), actions: spec.actions, cost: spec.cost };
    setItems((all) => [run, ...all]);
    const fails = !!mocks().runFails;
    let pct = 0;
    const timer = window.setInterval(() => {
      pct = Math.min(100, pct + 12 + (seq % 3) * 3);
      if (fails && pct >= 40) {
        stop(id);
        const cur = itemsRef.current.find((it): it is MediaRun => it.id === id && it.kind === 'media');
        if (!cur) return;
        const failed: MediaRun = { ...cur, progress: undefined, steps: undefined, failed: { refunded: spec.cost }, finishedAgoMin: 0 };
        setItems((all) => all.map((it) => (it.id === id ? failed : it)));
        ev.current.onFail?.(failed);
        return;
      }
      if (pct >= 100) {
        stop(id);
        const cur = itemsRef.current.find((it): it is MediaRun => it.id === id && it.kind === 'media');
        if (!cur) return;
        const done: MediaRun = { ...cur, progress: undefined, steps: undefined, tiles: cur.tiles.map((t) => ({ ...t, tone })), durationSec: spec.durationSec, finishedAgoMin: 0 };
        setItems((all) => all.map((it) => (it.id === id ? done : it)));
        ev.current.onDone?.(done);
        return;
      }
      update(id, (r) => ({ ...r, progress: pct, steps: steps(pct) }));
    }, mocks().runTickMs ?? 350);
    timers.current.set(id, timer);
    return id;
  }, []);

  /** Cancel a running job: the hold is released, so the card leaves the feed. */
  const cancel = useCallback((id: string) => {
    stop(id);
    setItems((all) => all.filter((it) => it.id !== id));
  }, []);

  /** The spec a run was started with (new runs only), to retry it. */
  const specOf = useCallback((id: string) => specs.current.get(id), []);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const replaceDraft = useCallback((id: string, fn: (d: Extract<FeedItem, { kind: 'draft' }>) => FeedItem) => {
    setItems((all) => all.map((it) => (it.id === id && it.kind === 'draft' ? fn(it) : it)));
  }, []);

  const remove = useCallback((id: string) => setItems((all) => all.filter((it) => it.id !== id)), []);

  return { items, favorites, start, cancel, specOf, toggleFavorite, replaceDraft, remove };
}
