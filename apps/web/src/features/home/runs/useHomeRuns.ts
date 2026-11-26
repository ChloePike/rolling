import { useCallback, useEffect, useRef, useState } from 'react';
import { isMockApi, userEvents } from '@/features/overlays/backend';
import { cancelRun, getRun } from '@/features/overlays/runs';
import { useSession } from '@/lib/session';
import { applyProgress, applyRunView, isActive, parseStored, upsertCard, type HomeRunCard } from './model';

/** How often active real runs are read again when no socket event arrived (the socket is the fast path). */
const POLL_MS = 4000;
/** Mock mode: how often the simulated progress moves. */
const MOCK_TICK_MS = 250;

const storageKey = (userId: string, workspaceId: string) => `rolling.home.runs.${userId}.${workspaceId}`;

function load(key: string | null): HomeRunCard[] {
  if (!key) return [];
  try {
    const cards = parseStored(localStorage.getItem(key));
    // Mock runs live in this page only: one still running when the page went away is shown as finished.
    return isMockApi() ? cards.map((c) => (isActive(c) ? { ...c, status: 'done' as const, progress: 1, finishedAt: c.finishedAt ?? Date.now() } : c)) : cards;
  } catch {
    return [];
  }
}

function save(key: string | null, cards: HomeRunCard[]) {
  if (!key) return;
  try {
    // A card that never got a run id is not worth keeping.
    localStorage.setItem(key, JSON.stringify(cards.filter((c) => c.status !== 'starting')));
  } catch {
    /* Storage unavailable: cards last for this page. */
  }
}

export interface HomeRuns {
  cards: HomeRunCard[];
  /** A send: the card shows at once (`starting`) above the older ones. */
  add: (card: HomeRunCard) => void;
  /** Credits are held: the card follows its run. Re-adds a card that was dropped meanwhile. */
  started: (key: string, runId: string, fallback?: HomeRunCard) => void;
  patch: (key: string, fn: (c: HomeRunCard) => HomeRunCard) => void;
  remove: (key: string) => void;
  /** Cancels a running card (`POST /api/runs/:id/cancel`; held credits are released). */
  cancel: (key: string) => Promise<void>;
}

/**
 * The Home run cards (newest first), kept per user and workspace in this
 * browser, and the live state of each: real runs follow `activity.updated`
 * on the user socket (D-014; `progress` arrives there for runs without a
 * canvas) and read `GET /api/runs/:id` on each event, with a slow poll as
 * the fallback. On load, unfinished cards are read again from the runs API.
 */
export function useHomeRuns(): HomeRuns {
  const mock = isMockApi();
  const session = useSession();
  const key = mock ? storageKey('mock', 'mock') : session.user && session.workspace ? storageKey(session.user.id, session.workspace.id) : null;
  const [cards, setCards] = useState<HomeRunCard[]>(() => load(key));
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const keyRef = useRef(key);

  // The signed-in user or workspace changed (or the session finished loading): their own cards.
  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    setCards(load(key));
  }, [key]);

  const update = useCallback((fn: (list: HomeRunCard[]) => HomeRunCard[]) => {
    setCards((list) => {
      const next = fn(list);
      if (next !== list) save(keyRef.current, next);
      return next;
    });
  }, []);

  const patch = useCallback((k: string, fn: (c: HomeRunCard) => HomeRunCard) => update((list) => (list.some((c) => c.key === k) ? list.map((c) => (c.key === k ? fn(c) : c)) : list)), [update]);

  // Real mode: refresh one card from the runs API.
  const inFlight = useRef(new Set<string>());
  const refresh = useCallback(
    (runId: string) => {
      if (mock || inFlight.current.has(runId)) return;
      inFlight.current.add(runId);
      void getRun(runId).then(
        (view) => {
          inFlight.current.delete(runId);
          update((list) => list.map((c) => (c.runId === runId ? applyRunView(c, view) : c)));
        },
        () => inFlight.current.delete(runId),
      );
    },
    [mock, update],
  );

  const activeIds = cards.filter((c) => isActive(c) && c.runId).map((c) => c.runId!);
  const activeKey = activeIds.join(',');

  // Real mode: socket events for active runs, and the poll fallback.
  useEffect(() => {
    if (mock || !activeKey) return;
    const ids = new Set(activeKey.split(','));
    const off = userEvents((msg) => {
      if (msg.type !== 'activity.updated') return;
      const p = msg.payload as { runId?: string; progress?: unknown };
      if (!p?.runId || !ids.has(p.runId)) return;
      if (typeof p.progress === 'number') {
        const progress = p.progress;
        update((list) => list.map((c) => (c.runId === p.runId ? applyProgress(c, progress) : c)));
      } else refresh(p.runId);
    });
    const timer = window.setInterval(() => ids.forEach((id) => refresh(id)), POLL_MS);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [mock, activeKey, refresh, update]);

  // Real mode, once per key: cards left unfinished (or loaded from another tab's run) are read again.
  useEffect(() => {
    if (mock || !key) return;
    for (const c of cardsRef.current) if (c.runId && (isActive(c) || (c.status === 'done' && !c.assetIds.length))) refresh(c.runId);
  }, [mock, key, refresh]);

  // Mock mode: progress moves while the mock run is in flight (the mock backend reports none).
  const mockActive = mock && cards.some((c) => c.status === 'running' || c.status === 'queued');
  useEffect(() => {
    if (!mockActive) return;
    const timer = window.setInterval(() => {
      setCards((list) => list.map((c) => (c.status === 'running' || c.status === 'queued' ? { ...c, status: 'running', progress: Math.min(0.95, (c.progress ?? 0) + (0.95 - (c.progress ?? 0)) * 0.2) } : c)));
    }, MOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, [mockActive]);

  const add = useCallback((card: HomeRunCard) => update((list) => upsertCard(list, card)), [update]);
  const remove = useCallback((k: string) => update((list) => list.filter((c) => c.key !== k)), [update]);
  const started = useCallback(
    (k: string, runId: string, fallback?: HomeRunCard) =>
      update((list) => {
        const found = list.find((c) => c.key === k);
        const base = found ?? fallback;
        if (!base) return list;
        return upsertCard(list, { ...base, runId, status: base.status === 'starting' ? 'queued' : base.status });
      }),
    [update],
  );
  useEffect(() => {
    // A newly started real run: read it at once (status, held credits).
    if (!mock) for (const id of activeIds) if (!cardsRef.current.find((c) => c.runId === id)?.finishedAt) refresh(id);
    // Only when the set of active runs changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  const cancel = useCallback(
    async (k: string) => {
      const card = cardsRef.current.find((c) => c.key === k);
      if (!card || !isActive(card)) return;
      if (mock || !card.runId) {
        patch(k, (c) => ({ ...c, status: 'canceled', progress: null, refunded: c.credits, finishedAt: Date.now() }));
        return;
      }
      const r = await cancelRun(card.runId);
      patch(k, (c) => ({ ...c, status: 'canceled', progress: null, refunded: r.refunded || c.credits, finishedAt: Date.now() }));
      refresh(card.runId);
    },
    [mock, patch, refresh],
  );

  return { cards, add, started, patch, remove, cancel };
}
