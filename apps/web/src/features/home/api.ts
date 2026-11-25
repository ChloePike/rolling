import { useQuery } from '@tanstack/react-query';
import { MOCK_PROJECTS } from './mocks';
import type { ProjectSummary } from './types';

/** Mock-backed `GET /api/projects` (recent first). */
export async function fetchRecentProjects(): Promise<ProjectSummary[]> {
  return MOCK_PROJECTS;
}

export function useRecentProjects() {
  return useQuery({ queryKey: ['projects', 'recent'], queryFn: fetchRecentProjects, initialData: MOCK_PROJECTS });
}

/** Mock `POST /api/projects`; the real call returns the new project id. */
export async function createProject(_input: { title: string; fromTemplateId?: string }): Promise<{ id: string }> {
  return { id: 'prj_new' };
}
