import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MOCK_PROJECTS } from './mocks';
import type { ProjectSummary } from './types';

/**
 * Projects for Home. Mock-backed until `GET /api/projects` and
 * `POST /api/projects` land: projects created here are kept in localStorage
 * and listed first.
 */
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
  return [...created(), ...MOCK_PROJECTS].slice(0, 4);
}

export function useRecentProjects() {
  return useQuery({ queryKey: projectsKey, queryFn: fetchRecentProjects, initialData: () => [...created(), ...MOCK_PROJECTS].slice(0, 4) });
}

const CREATED_TONES = ['var(--c-tone-indigo)', 'var(--c-tone-teal)', 'var(--c-tone-plum)', 'var(--c-tone-sand)'];

/** Mock `POST /api/projects`: returns the new project id (`prj_…`). The caller passes a title (localized fallback included). */
export async function createProject(input: { title: string; kind?: ProjectSummary['kind']; fromTemplateId?: string }): Promise<{ id: string }> {
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
