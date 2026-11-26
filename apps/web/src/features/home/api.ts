import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, gql, isMockApi } from '@/features/overlays/backend';
import { mockData } from '@/lib/api/mode';
import { mockDeletedProjects } from '@/features/canvas/target/projects';
import type { ProjectSummary } from './types';

/**
 * Projects for Home. Real mode: GraphQL `projects(first)` (recent first) and
 * `POST /api/projects`. Mock mode: projects created here are kept in
 * localStorage and listed first.
 */

const PROJECT_TONES = ['var(--c-tone-indigo)', 'var(--c-tone-teal)', 'var(--c-tone-plum)', 'var(--c-tone-sand)'];

interface GqlProjects {
  projects: { edges: Array<{ node: { id: string; title: string; kind: string; nodeCount: number; updatedAt: number; thumbUrl: string | null } }> };
}

async function fetchRealProjects(first = 4): Promise<ProjectSummary[]> {
  const r = await gql<GqlProjects>('query RecentProjects($first: Int) { projects(first: $first) { edges { node { id title kind nodeCount updatedAt thumbUrl } } } }', { first });
  return r.projects.edges.map(({ node }, i) => ({
    id: node.id,
    title: node.title,
    kind: (['canvas', 'avatar', 'quick', 'character'].includes(node.kind) ? node.kind : 'canvas') as ProjectSummary['kind'],
    nodeCount: node.nodeCount,
    updatedAt: new Date(node.updatedAt).toISOString(),
    tone: PROJECT_TONES[i % PROJECT_TONES.length]!,
    ...(node.thumbUrl ? { thumbUrl: node.thumbUrl } : {}),
  }));
}
const CREATED_KEY = 'rolling.mock.projects';
const projectsKey = ['projects', 'recent'] as const;

function created(): ProjectSummary[] {
  try {
    const raw = window.localStorage.getItem(CREATED_KEY);
    return raw ? (JSON.parse(raw) as ProjectSummary[]) : [];
  } catch {
    return [];
  }
}

/** Mock-backed `GET /api/projects` (recent first). */
export async function fetchRecentProjects(): Promise<ProjectSummary[]> {
  if (!isMockApi()) return fetchRealProjects(4);
  return mockRecent();
}

/** Mock list: created here first, then the fixtures, minus deleted ids, with renames applied. */
function mockRecent(): ProjectSummary[] {
  const deleted = mockDeletedProjects();
  const titles = mockTitles();
  return [...created(), ...mockData().home.MOCK_PROJECTS]
    .filter((p) => !deleted.has(p.id))
    .map((p) => (titles[p.id] ? { ...p, title: titles[p.id]! } : p))
    .slice(0, 4);
}

const TITLES_KEY = 'rolling.mock.projectTitles';
function mockTitles(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(TITLES_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/** Renames a project from its Home card (`PATCH /api/projects/:id`); refreshes every project list. */
export async function renameRecentProject(projectId: string, title: string): Promise<string> {
  const t = title.trim().slice(0, 120);
  if (!t) throw new Error('EMPTY_TITLE');
  let saved = t;
  if (!isMockApi()) {
    saved = (await apiFetch<{ project: { title: string } }>(`/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: { title: t } })).project.title;
  } else {
    try {
      window.localStorage.setItem(TITLES_KEY, JSON.stringify({ ...mockTitles(), [projectId]: t }));
    } catch {
      /* Storage unavailable. */
    }
  }
  return saved;
}

export function useRecentProjects() {
  const mock = isMockApi();
  // Real mode: no placeholder rows; the page shows skeletons until the list arrives.
  return useQuery({ queryKey: projectsKey, queryFn: fetchRecentProjects, ...(mock ? { initialData: mockRecent } : { staleTime: 15_000 }) });
}

const CREATED_TONES = ['var(--c-tone-indigo)', 'var(--c-tone-teal)', 'var(--c-tone-plum)', 'var(--c-tone-sand)'];

/** Mock `POST /api/projects`: returns the new project id (`prj_…`). The caller passes a title (localized fallback included). */
export async function createProject(input: { title: string; kind?: ProjectSummary['kind']; fromTemplateId?: string }): Promise<{ id: string }> {
  if (!isMockApi()) {
    const body: Record<string, unknown> = { title: input.title.trim().slice(0, 120) || 'Untitled project' };
    if (input.fromTemplateId) body.fromTemplateId = input.fromTemplateId;
    const r = await apiFetch<{ project: { id: string } }>('/projects', { method: 'POST', body });
    return { id: r.project.id };
  }
  const list = created();
  const id = `prj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const project: ProjectSummary = {
    id,
    title: input.title.trim(),
    kind: input.kind ?? 'canvas',
    nodeCount: (input.kind ?? 'canvas') === 'canvas' ? 0 : undefined,
    updatedAt: new Date().toISOString(),
    tone: CREATED_TONES[list.length % CREATED_TONES.length]!,
  };
  try {
    window.localStorage.setItem(CREATED_KEY, JSON.stringify([project, ...list].slice(0, 20)));
  } catch {
    /* Storage unavailable: the project still opens. */
  }
  return { id };
}

/** `createProject` that also refreshes the Recent projects list. */
export function useCreateProject() {
  const qc = useQueryClient();
  return async (input: Parameters<typeof createProject>[0]) => {
    const r = await createProject(input);
    await qc.invalidateQueries({ queryKey: projectsKey });
    return r;
  };
}
