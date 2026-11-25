import { useQuery } from '@tanstack/react-query';
import { uploadFiles } from '@/lib/transfers';
import { apiFetch, isMockApi } from '@/features/overlays/backend';
import { fetchAssets, type GqlAsset } from '@/features/library/assetsApi';
import { MOCK_REFERENCES, MOCK_SKILLS } from './mocks';
import type { PromptCommand, RefItem } from './types';

/**
 * Data access for the prompt box. Real mode: the `@` picker lists the
 * workspace's and built-in assets (GraphQL `assets(scope: ALL)` without the
 * public library, which the picker pages through `publicItems` itself),
 * characters (`/api/characters`) and voices (`/api/voices`). Skills are the
 * built-in list.
 */
const REF_TONES = ['var(--c-tone-indigo)', 'var(--c-tone-teal)', 'var(--c-tone-plum)', 'var(--c-tone-sand)'];

function refFromAsset(a: GqlAsset, i: number): RefItem {
  const kind = a.kind.toLowerCase();
  const detail = a.meta.width && a.meta.height ? `${a.meta.width}×${a.meta.height}` : a.meta.durationSec ? `${Math.round(a.meta.durationSec)}s` : '';
  return {
    id: a.id,
    group: 'mine',
    name: a.name,
    meta: [kind.charAt(0).toUpperCase() + kind.slice(1), detail].filter(Boolean).join(' · '),
    source: a.source === 'builtin' ? 'builtin' : a.source === 'team' ? 'team' : 'mine',
    tone: REF_TONES[i % REF_TONES.length]!,
    glyph: kind === 'audio' ? { type: 'wave' } : { type: 'icon', icon: kind === 'video' ? 'video' : 'img' },
    // Mature-rated thumbnails are not shown in the picker (D-005); the glyph stands in.
    ...(a.thumbUrl && !a.mature ? { thumbUrl: a.thumbUrl } : {}),
  };
}

async function fetchRealReferences(): Promise<RefItem[]> {
  const [assets, chars, voices] = await Promise.all([
    fetchAssets({ scope: 'ALL', first: 100 }).catch(() => [] as GqlAsset[]),
    apiFetch<{ items: Array<{ id: string; name: string; coverUrl: string | null }> }>('/characters').catch(() => ({ items: [] })),
    apiFetch<{ items: Array<{ id: string; name: string; language: string | null; kind: string }> }>('/voices').catch(() => ({ items: [] })),
  ]);
  return [
    ...assets.filter((a) => a.source !== 'public' && a.status !== 'failed').map(refFromAsset),
    ...chars.items.map((c, i): RefItem => ({ id: c.id, group: 'char', name: c.name, meta: 'Character', source: 'mine', tone: REF_TONES[i % REF_TONES.length]!, glyph: { type: 'letter', letter: c.name.charAt(0).toUpperCase() }, ...(c.coverUrl ? { thumbUrl: c.coverUrl } : {}) })),
    ...voices.items.map((v, i): RefItem => ({ id: v.id, group: 'voice', name: v.name, meta: [v.kind === 'cloned' ? 'Cloned voice' : 'Voice', v.language].filter(Boolean).join(' · '), source: v.kind === 'cloned' ? 'mine' : 'builtin', tone: REF_TONES[i % REF_TONES.length]!, glyph: { type: 'wave' } })),
  ];
}

export async function fetchReferences(): Promise<RefItem[]> {
  return isMockApi() ? MOCK_REFERENCES : fetchRealReferences();
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
  const mock = isMockApi();
  const q = useQuery({ queryKey: promptKeys.references, queryFn: fetchReferences, ...(mock ? { initialData: MOCK_REFERENCES } : { staleTime: 15_000 }) });
  return { ...q, data: q.data ?? [] };
}

/** Built-in and custom skills for the `/` palette and the `+` menu. */
export function useSkills() {
  return useQuery({ queryKey: promptKeys.skills, queryFn: fetchSkills, initialData: MOCK_SKILLS });
}

/** What an uploaded file becomes in the picker. */
export function uploadKind(file: File): 'image' | 'video' | 'audio' | 'file' {
  const t = file.type.split('/')[0];
  return t === 'image' || t === 'video' || t === 'audio' ? t : 'file';
}

/**
 * Upload through the shared transfer queue (D-011, `lib/transfers`): direct to
 * R2, resumable, high priority because the user is about to reference them.
 * Cards appear at once with the upload id as a provisional id; resolve it with
 * `resolveAssetId` from `@/lib/transfers` before sending. Files over the limits
 * are left out (the transfers dock explains why). Images preview through an
 * object URL. `meta` formats the card's detail line (localized by the caller).
 */
export async function uploadReferences(files: File[], meta: (file: File) => string): Promise<RefItem[]> {
  const { items } = uploadFiles(files, { purpose: 'reference', priority: 'high', quiet: true });
  return items.map(({ id, file }) => {
    const kind = uploadKind(file);
    const thumbUrl = kind === 'image' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined;
    return {
      id,
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
