import { apiRequest } from '@/lib/api';
import { queryClient } from '@/lib/api/queryClient';
import { getActiveWorkspace, getSession } from '@/lib/session';
import { apiFetch, isApiError, isMockApi } from '@/features/overlays/backend';
import { createProject } from '@/features/home/api';
import { mockData } from '@/lib/api/mode';
import { readLocal, writeLocal } from '../storage';
import { createOnce, resolveCanvasTarget, type CanvasSummary, type CanvasTarget } from './resolve';

/**
 * The projects a "canvas" action can target, and the last canvas per user and
 * workspace.
 *
 * Real mode: `GET /api/projects?first=50` (recent first, current workspace),
 * `GET /api/projects/:id` for one project (`404` for missing and foreign ones),
 * `POST /api/projects` for a new blank canvas.
 *
 * Mock mode: the demo canvas `prj_demo` plus projects created in this browser.
 * Seams on `window.__rollingMocks`: `projects` (replaces the demo list, e.g.
 * `[]` for a user with no projects), `missingProjects` (ids that answer 404;
 * ids starting with `prj_missing` always do), `foreignProjects`
 * (`{ [projectId]: workspaceId }`: projects that open only in that workspace).
 */

interface TargetMocks {
  projects?: Array<{ id: string; title: string; updatedAt?: number }>;
  missingProjects?: string[];
  foreignProjects?: Record<string, string>;
}

const mocks = (): TargetMocks => (typeof window !== 'undefined' ? ((window as unknown as { __rollingMocks?: TargetMocks }).__rollingMocks ?? {}) : {});

const PAGE = 50;

/** The active workspace id (mock: the switcher's choice). */
export function activeWorkspace(): string {
  if (isMockApi()) return getActiveWorkspace(mockData().session.MOCK_WORKSPACES[0]!.id);
  return getSession().workspace?.id ?? 'default';
}

export const canvasesKey = (workspaceId: string) => ['projects', 'canvases', workspaceId] as const;

/* ---------- Last canvas (per user and workspace, this browser) ---------- */

const lastKey = (workspaceId: string) => `rolling.canvas.last.${getSession().user?.id ?? 'anon'}.${workspaceId}`;

export function lastCanvas(workspaceId = activeWorkspace()): string | null {
  const v = readLocal(lastKey(workspaceId));
  return v && /^prj_[A-Za-z0-9_]+$/.test(v) ? v : null;
}

export function rememberCanvas(projectId: string, workspaceId = activeWorkspace()) {
  if (lastCanvas(workspaceId) !== projectId) writeLocal(lastKey(workspaceId), projectId);
}

/** Forget `projectId` if it is the remembered canvas (not found, deleted, no access). */
export function forgetCanvas(projectId: string, workspaceId = activeWorkspace()) {
  if (lastCanvas(workspaceId) !== projectId) return;
  try {
    window.localStorage.removeItem(lastKey(workspaceId));
  } catch {
    /* Storage unavailable. */
  }
}

/* ---------- Mock directory ---------- */

const MOCK_CREATED_KEY = 'rolling.mock.projects';
/** Mock: ids deleted in this browser (the demo projects are fixtures, so they are hidden instead). */
export const MOCK_DELETED_KEY = 'rolling.mock.deletedProjects';

export function mockDeletedProjects(): Set<string> {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(MOCK_DELETED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function mockCreated(): CanvasSummary[] {
  try {
    const raw = window.localStorage.getItem(MOCK_CREATED_KEY);
    const list = raw ? (JSON.parse(raw) as Array<{ id: string; title: string; kind?: string; updatedAt: string }>) : [];
    return list.filter((p) => (p.kind ?? 'canvas') === 'canvas').map((p) => ({ id: p.id, title: p.title, updatedAt: Date.parse(p.updatedAt) || Date.now() }));
  } catch {
    return [];
  }
}

function mockList(): CanvasSummary[] {
  const seam = mocks().projects;
  const base = seam ? seam.map((p, i) => ({ id: p.id, title: p.title, updatedAt: p.updatedAt ?? Date.now() - (i + 1) * 3_600_000 })) : [{ id: mockData().canvas.MOCK_PROJECT.id, title: mockData().canvas.MOCK_PROJECT.title, updatedAt: Date.now() - 2 * 3_600_000 }];
  const deleted = mockDeletedProjects();
  return [...mockCreated(), ...base].filter((p) => !deleted.has(p.id));
}

/** Mock: does `projectId` open in `workspaceId`? */
export function mockProjectOpens(projectId: string, workspaceId = activeWorkspace()): boolean {
  const m = mocks();
  if (projectId.startsWith('prj_missing') || m.missingProjects?.includes(projectId) || mockDeletedProjects().has(projectId)) return false;
  const owner = m.foreignProjects?.[projectId];
  return !owner || owner === workspaceId;
}

/* ---------- Reads ---------- */

interface ProjectRow {
  id: string;
  title: string;
  updatedAt: number | string;
}

async function fetchCanvases(): Promise<CanvasSummary[]> {
  if (isMockApi()) return mockList();
  const r = await apiFetch<{ items: ProjectRow[] }>('/projects', { query: { first: PAGE } });
  return r.items.map((p) => ({ id: p.id, title: p.title, updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.parse(p.updatedAt) || 0 }));
}

/** Recent projects of the active workspace, cached (30 s) and shared by the nav item and the picker. */
export function listCanvases(workspaceId = activeWorkspace()): Promise<CanvasSummary[]> {
  return queryClient.fetchQuery({ queryKey: canvasesKey(workspaceId), queryFn: fetchCanvases, staleTime: 30_000 });
}

export const canvasesQuery = (workspaceId: string) => ({ queryKey: canvasesKey(workspaceId), queryFn: fetchCanvases, staleTime: 30_000 });

/** Whether a project opens for this user in `workspaceId` (default: the active one). */
export async function projectOpens(projectId: string, workspaceId?: string): Promise<boolean> {
  if (isMockApi()) return mockProjectOpens(projectId, workspaceId);
  try {
    await apiRequest(`/projects/${encodeURIComponent(projectId)}`, workspaceId ? { workspaceId } : {});
    return true;
  } catch (e) {
    if (isApiError(e) && (e.status === 404 || e.status === 403)) return false;
    throw e;
  }
}

/** Another workspace of the user where `projectId` opens, if any (the not-found page offers to switch). */
export async function findProjectWorkspace(projectId: string): Promise<{ id: string; name: string } | null> {
  const session = getSession();
  const active = activeWorkspace();
  for (const ws of session.workspaces) {
    if (ws.id === active) continue;
    if (await projectOpens(projectId, ws.id).catch(() => false)) return { id: ws.id, name: ws.name };
  }
  return null;
}

/* ---------- Create ---------- */

/** A new blank canvas (the "New canvas" path: `POST /api/projects` with the default title). */
export async function createCanvas(title: string): Promise<string> {
  const { id } = await createProject({ title, kind: 'canvas' });
  await queryClient.invalidateQueries({ queryKey: ['projects'] });
  return id;
}

/* ---------- The sidebar Canvas item ---------- */

export interface ResolveOptions {
  /** Default title of a new canvas. */
  untitled: string;
  /** Router preload (hover): read only, never create. */
  preload?: boolean;
}

/** The project the sidebar Canvas item opens (see `resolve.ts` for the order). */
export function resolveNavCanvas(opts: ResolveOptions): Promise<CanvasTarget> {
  const ws = activeWorkspace();
  const canCreate = !opts.preload && getSession().role !== 'viewer';
  return resolveCanvasTarget({
    lastId: lastCanvas(ws),
    list: () => listCanvases(ws),
    exists: (id) => projectOpens(id),
    forget: (id) => forgetCanvas(id, ws),
    create: canCreate
      ? () =>
          createOnce(
            ws,
            // Inside the lock: another tab may have created one meanwhile.
            async () => {
              await queryClient.invalidateQueries({ queryKey: canvasesKey(ws) });
              const fresh = await listCanvases(ws);
              return fresh[0]?.id ?? null;
            },
            () => createCanvas(opts.untitled),
          )
      : null,
  });
}

/* ---------- Delete ---------- */

/**
 * Deletes a project for everyone (`DELETE /api/projects/:id`: graph, timeline and history; share links stop
 * working). There is no restore, so callers confirm first. Forgets it as the last canvas and refreshes every
 * project list (Home, the canvas picker).
 */
export async function deleteProject(projectId: string, workspaceId = activeWorkspace()): Promise<void> {
  if (isMockApi()) {
    try {
      const raw = window.localStorage.getItem(MOCK_CREATED_KEY);
      const list = raw ? (JSON.parse(raw) as Array<{ id: string }>) : [];
      window.localStorage.setItem(MOCK_CREATED_KEY, JSON.stringify(list.filter((p) => p.id !== projectId)));
      window.localStorage.setItem(MOCK_DELETED_KEY, JSON.stringify([...mockDeletedProjects(), projectId]));
    } catch {
      /* Storage unavailable. */
    }
  } else {
    await apiFetch(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  }
  forgetCanvas(projectId, workspaceId);
  await queryClient.invalidateQueries({ queryKey: ['projects'] });
}
