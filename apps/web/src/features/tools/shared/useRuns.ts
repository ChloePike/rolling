import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import type { FeedItem, MediaRun, MediaTile } from '../types';
import { assetMediaUrl, userEvents } from '@/features/overlays/backend';
import { chainOf, findRun, resultItems, isFailedRun, runFinished, type RunView } from '@/features/overlays/runs';

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
  /** Label of the generating step while the provider reports no progress (default “Generating”, never a number). */
  generatingIdle?: string;
  durationSec?: number;
  cost: number;
  actions: MediaRun['actions'];
  /** Step labels of a mature text-to-video chain (D-005): the first frame, then the animation (`{pct}` while it runs). */
  chainLabels?: { keyframe: string; animate: (pct: number) => string };
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
  const intl = useIntl();
  const intlRef = useRef(intl);
  intlRef.current = intl;
  /** The generating step's label: a percentage only for real progress (above 0). */
  const genLabel = (spec: RunSpec, pct: number) => (pct > 0 ? spec.generating(pct) : (spec.generatingIdle ?? intlRef.current.formatMessage({ id: 'tools.run.step.generatingNoProgress' })));

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
      { label: genLabel(spec, pct), state: 'now' as const },
    ];
    const run: MediaRun = { kind: 'media', id, aspect: spec.aspect, tiles, prompt: spec.prompt, tags: spec.tags, progress: 0, startedAt: Date.now(), video: spec.video, steps: steps(0), actions: spec.actions, cost: spec.cost };
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

  /**
   * Real mode: a run started with `POST /api/runs`. The card follows the run
   * (`activity.updated` on the user channel, polling as a fallback) until it
   * is done (result media) or failed (refund shown).
   */
  const startReal = useCallback((spec: RunSpec, runId: string): string => {
    const id = runId;
    specs.current.set(id, spec);
    const steps = (pct: number) => [...spec.steps.map((label) => ({ label, state: 'done' as const })), { label: genLabel(spec, pct), state: 'now' as const }];
    const tiles: MediaTile[] = (spec.tiles.length ? spec.tiles : [undefined]).map((label) => (label ? { label, tone: 'var(--c-tone-blank)' } : { tone: 'var(--c-tone-blank)' }));
    const run: MediaRun = { kind: 'media', id, runId, aspect: spec.aspect, tiles, prompt: spec.prompt, tags: spec.tags, progress: 0, startedAt: Date.now(), video: spec.video, steps: steps(0), actions: spec.actions, cost: spec.cost };
    setItems((all) => [run, ...all]);
    let finished = false;
    const apply = (r: RunView) => {
      if (finished) return;
      if (!runFinished(r)) {
        const pct = Math.round((r.progress ?? 0) * 100);
        const chain = chainOf(r);
        // A chain is one generation in two steps; the progress covers both.
        const shown =
          chain && spec.chainLabels
            ? [
                { label: spec.chainLabels.keyframe, state: chain.current === 'keyframe' ? ('now' as const) : ('done' as const) },
                { label: pct > 0 ? spec.chainLabels.animate(pct) : intlRef.current.formatMessage({ id: 'tools.feed.step.animateNoProgress' }), state: chain.current === 'animate' ? ('now' as const) : ('todo' as const) },
              ]
            : steps(pct);
        update(id, (cur) => ({ ...cur, progress: pct, startedAt: r.createdAt || cur.startedAt, steps: shown }));
        return;
      }
      finished = true;
      stop(id);
      off();
      const cur = itemsRef.current.find((it): it is MediaRun => it.id === id && it.kind === 'media');
      if (!cur) return;
      if (isFailedRun(r)) {
        // A chain whose animation failed keeps its first frame on the card.
        const kf = chainOf(r)?.keyframeAssetId ?? null;
        const failed: MediaRun = {
          ...cur,
          progress: undefined,
          steps: undefined,
          failed: { refunded: r.refunded },
          finishedAgoMin: 0,
          ...(kf && { assetId: kf, video: false, tiles: [{ ...(cur.tiles[0] ?? { tone: 'var(--c-tone-blank)' }), src: assetMediaUrl(kf) }] }),
        };
        setItems((all) => all.map((it) => (it.id === id ? failed : it)));
        ev.current.onFail?.(failed);
        return;
      }
      const assets = resultItems(r).map((i) => i.assetId).filter((x): x is string => !!x);
      const expandedPrompt = resultItems(r).find((i) => i.expandedPrompt)?.expandedPrompt;
      const done: MediaRun = {
        ...cur,
        ...(expandedPrompt && { expandedPrompt }),
        progress: undefined,
        steps: undefined,
        assetId: assets[0] ?? null,
        tiles: (assets.length ? assets : [null]).map((a, i) => ({ ...(cur.tiles[i] ?? { tone: 'var(--c-tone-blank)' }), ...(a ? { src: assetMediaUrl(a) } : {}) })),
        durationSec: spec.durationSec,
        finishedAgoMin: 0,
      };
      setItems((all) => all.map((it) => (it.id === id ? done : it)));
      ev.current.onDone?.(done);
    };
    const check = () => void findRun(runId).then((r) => r && apply(r), () => {});
    const off = userEvents((msg) => {
      if (msg.type === 'activity.updated' && (msg.payload as { runId?: string })?.runId === runId) check();
    });
    timers.current.set(id, window.setInterval(check, 4000));
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

  return { items, favorites, start, startReal, cancel, specOf, toggleFavorite, replaceDraft, remove, setItems };
}
