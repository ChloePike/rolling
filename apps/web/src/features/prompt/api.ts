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

let uploadSeq = 0;

/** What an uploaded file becomes in the picker. */
export function uploadKind(file: File): 'image' | 'video' | 'audio' | 'file' {
  const t = file.type.split('/')[0];
  return t === 'image' || t === 'video' || t === 'audio' ? t : 'file';
}

/**
 * Upload (`POST /api/uploads` → R2, then `GET /api/assets/:id`). The mock keeps
 * the files in memory: images preview through an object URL. `meta` formats the
 * card's detail line (localized by the caller).
 */
export async function uploadReferences(files: File[], meta: (file: File) => string): Promise<RefItem[]> {
  return files.map((file) => {
    uploadSeq += 1;
    const kind = uploadKind(file);
    const thumbUrl = kind === 'image' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined;
    return {
      id: `ast_upload${String(uploadSeq).padStart(3, '0')}`,
      group: 'mine' as const,
      name: file.name.replace(/\.[^.]+$/, '') || file.name,
      meta: meta(file),
      source: 'mine' as const,
      tone: 'var(--c-surface-5)',
      glyph: kind === 'audio' ? ({ type: 'wave' } as const) : ({ type: 'icon', icon: kind === 'video' ? 'video' : 'img' } as const),
      thumbUrl,
    };
  });
}
