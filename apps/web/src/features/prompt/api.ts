import { useQuery } from '@tanstack/react-query';
import { MOCK_REFERENCES, MOCK_SKILLS } from './mocks';
import type { PromptCommand, RefItem } from './types';

/**
 * Data access for the prompt box. Mock-backed for now; the real client
 * replaces these with `GET /api/assets?scope=all` (GraphQL picker search,
 * D-003) and the skills list.
 */
export async function fetchReferences(): Promise<RefItem[]> {
  return MOCK_REFERENCES;
}

export async function fetchSkills(): Promise<PromptCommand[]> {
  return MOCK_SKILLS;
}

export const promptKeys = {
  references: ['prompt', 'references'] as const,
  skills: ['prompt', 'skills'] as const,
};

/** Everything the `@` picker can reference: assets, characters, voices and the public library. */
export function useReferences() {
  return useQuery({ queryKey: promptKeys.references, queryFn: fetchReferences, initialData: MOCK_REFERENCES });
}

/** Built-in and custom skills for the `/` palette and the `+` menu. */
export function useSkills() {
  return useQuery({ queryKey: promptKeys.skills, queryFn: fetchSkills, initialData: MOCK_SKILLS });
}
