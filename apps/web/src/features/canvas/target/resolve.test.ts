import { describe, expect, it, vi } from 'vitest';
import { createOnce, freePosition, INSERT_GAP, mostRecent, resolveCanvasTarget, type CanvasSummary, type ResolveDeps } from './resolve';

const p = (id: string, updatedAt: number): CanvasSummary => ({ id, title: id, updatedAt });

function deps(over: Partial<ResolveDeps> = {}): ResolveDeps & { forgotten: string[]; created: number } {
  const state = { forgotten: [] as string[], created: 0 };
  return Object.assign(state, {
    lastId: null,
    list: async () => [p('prj_a', 10), p('prj_b', 30), p('prj_c', 20)],
    exists: async () => false,
    forget: (id: string) => state.forgotten.push(id),
    create: async () => {
      state.created++;
      return 'prj_new';
    },
    ...over,
  });
}

describe('resolveCanvasTarget', () => {
  it('opens the last canvas when it is in the list', async () => {
    const d = deps({ lastId: 'prj_c' });
    expect(await resolveCanvasTarget(d)).toEqual({ kind: 'open', projectId: 'prj_c', via: 'last' });
    expect(d.created).toBe(0);
  });

  it('checks a last canvas that is not on the first page', async () => {
    const exists = vi.fn(async (id: string) => id === 'prj_old');
    expect(await resolveCanvasTarget(deps({ lastId: 'prj_old', exists }))).toEqual({ kind: 'open', projectId: 'prj_old', via: 'last' });
    expect(exists).toHaveBeenCalledWith('prj_old');
  });

  it('forgets a stale last canvas and falls back to the most recent project', async () => {
    const d = deps({ lastId: 'prj_gone' });
    expect(await resolveCanvasTarget(d)).toEqual({ kind: 'open', projectId: 'prj_b', via: 'recent' });
    expect(d.forgotten).toEqual(['prj_gone']);
  });

  it('treats a failed existence check as gone', async () => {
    const d = deps({ lastId: 'prj_x', exists: async () => Promise.reject(new Error('offline')) });
    expect(await resolveCanvasTarget(d)).toMatchObject({ projectId: 'prj_b', via: 'recent' });
  });

  it('creates a blank canvas when there are no projects', async () => {
    const d = deps({ list: async () => [] });
    expect(await resolveCanvasTarget(d)).toEqual({ kind: 'open', projectId: 'prj_new', via: 'created' });
    expect(d.created).toBe(1);
  });

  it('returns none when nothing exists and creating is not allowed (preload, viewers)', async () => {
    expect(await resolveCanvasTarget(deps({ list: async () => [], create: null }))).toEqual({ kind: 'none' });
  });

  it('never creates when a project exists', async () => {
    const d = deps();
    await resolveCanvasTarget(d);
    expect(d.created).toBe(0);
  });
});

describe('mostRecent', () => {
  it('picks the newest updatedAt', () => {
    expect(mostRecent([p('a', 1), p('b', 3), p('c', 2)])?.id).toBe('b');
    expect(mostRecent([])).toBeNull();
  });
});

describe('createOnce', () => {
  it('shares one create between concurrent callers (double click, StrictMode)', async () => {
    let calls = 0;
    const create = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return `prj_${calls}`;
    };
    const [a, b] = await Promise.all([createOnce('ws1', async () => null, create, null), createOnce('ws1', async () => null, create, null)]);
    expect(a).toBe('prj_1');
    expect(b).toBe('prj_1');
    expect(calls).toBe(1);
  });

  it('uses the project another tab made while waiting for the lock', async () => {
    const create = vi.fn(async () => 'prj_mine');
    const order: string[] = [];
    // A lock manager that runs callbacks one after another, like Web Locks.
    let chain = Promise.resolve<unknown>(undefined);
    const locks = {
      request: (_name: string, cb: () => Promise<string>) => {
        const run = chain.then(cb);
        chain = run.catch(() => undefined);
        return run;
      },
    };
    let made: string | null = null;
    const tabA = createOnce('ws2', async () => made, async () => {
      order.push('A');
      made = 'prj_a';
      return made;
    }, locks);
    // Tab B has its own in-flight map in reality; a different key stands in for it here.
    const tabB = createOnce('ws2-tab-b', async () => made, create, locks);
    expect(await tabA).toBe('prj_a');
    expect(await tabB).toBe('prj_a');
    expect(create).not.toHaveBeenCalled();
    expect(order).toEqual(['A']);
  });

  it('allows a new create after the previous one settled', async () => {
    let n = 0;
    const create = async () => `prj_${++n}`;
    expect(await createOnce('ws3', async () => null, create, null)).toBe('prj_1');
    expect(await createOnce('ws3', async () => null, create, null)).toBe('prj_2');
  });
});

describe('freePosition', () => {
  it('places right of the whole graph, level with its top', () => {
    const nodes = [
      { position: { x: 0, y: 100 } },
      { position: { x: 400, y: 40 }, width: 300 },
      { position: { x: 200, y: 300 } },
    ];
    expect(freePosition(nodes, 240, { x: 0, y: 0 })).toEqual({ x: 700 + INSERT_GAP, y: 40 });
  });

  it('uses the given spot on an empty canvas', () => {
    expect(freePosition([], 240, { x: 120.4, y: 80.6 })).toEqual({ x: 120, y: 81 });
  });
});
