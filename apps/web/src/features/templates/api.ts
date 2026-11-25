import { useQuery } from '@tanstack/react-query';
import { apiFetch, isMockApi } from '@/features/overlays/backend';
import { MOCK_FEATURED, MOCK_TEMPLATE_TOTAL, MOCK_TEMPLATES } from './mocks';
import type { TemplateCategory, TemplateDetail, TemplateSummary } from './types';

export interface TemplatesPage {
  featured: TemplateSummary[];
  items: TemplateSummary[];
  total: number;
}

/** `GET /api/templates` row (docs/api.md → Templates). */
interface ApiTemplate {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  source: 'builtin' | 'workspace';
  durationSec: number;
  ratio: string;
  coverAspect: string;
  roles: number;
  hasLines: boolean;
  tags: string[];
  featured: boolean;
  uses: number;
  nodeCount: number;
  skill: string | null;
  coverUrl: string | null;
  slots: TemplateSummary['slots'];
  createdAt: number;
}

const CATEGORIES: readonly TemplateCategory[] = ['product', 'explainer', 'drama', 'holiday', 'venue', 'outfit', 'comic', 'talking'];

function summaryFrom(t: ApiTemplate): TemplateSummary {
  return {
    id: t.id,
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    durationSec: t.durationSec,
    uses: t.uses,
    roles: t.roles,
    hasLines: t.hasLines,
    ...(t.tags.length ? { tags: t.tags } : {}),
    coverAspect: t.coverAspect,
    category: (CATEGORIES as readonly string[]).includes(t.category ?? '') ? (t.category as TemplateCategory) : 'explainer',
    ...(t.featured ? { featured: true } : {}),
    ratio: t.ratio,
    source: t.source,
    nodeCount: t.nodeCount,
    skill: t.skill,
    coverUrl: t.coverUrl,
    slots: t.slots,
  };
}

/** Templates list. Real: `GET /api/templates` (built-ins and this workspace's); mock: the design's catalog. */
export async function fetchTemplates(): Promise<TemplatesPage> {
  if (isMockApi()) return { featured: MOCK_FEATURED, items: MOCK_TEMPLATES, total: MOCK_TEMPLATE_TOTAL };
  const r = await apiFetch<{ items: ApiTemplate[]; featured: ApiTemplate[]; total: number }>('/templates', { query: { first: 100 } });
  return { featured: r.featured.map(summaryFrom), items: r.items.map(summaryFrom), total: r.total };
}

const INITIAL: TemplatesPage = { featured: MOCK_FEATURED, items: MOCK_TEMPLATES, total: MOCK_TEMPLATE_TOTAL };
const EMPTY: TemplatesPage = { featured: [], items: [], total: 0 };

export function useTemplates() {
  const mock = isMockApi();
  const q = useQuery({ queryKey: ['templates', 'list'], queryFn: fetchTemplates, ...(mock ? { initialData: INITIAL } : { staleTime: 60_000 }) });
  return { ...q, data: q.data ?? EMPTY };
}

/** `GET /api/templates/:id`: the template with its graph. */
export async function fetchTemplate(id: string): Promise<TemplateDetail> {
  const r = await apiFetch<{ template: ApiTemplate & { graph: TemplateDetail['graph'] } }>(`/templates/${encodeURIComponent(id)}`);
  return { ...summaryFrom(r.template), graph: r.template.graph };
}

export function useTemplate(id: string | undefined) {
  return useQuery({ queryKey: ['templates', 'one', id], queryFn: () => fetchTemplate(id!), enabled: !!id && !isMockApi(), staleTime: 60_000 });
}

/** Slot fills for `POST /api/projects { fromTemplateId, slots }`. */
export type SlotFills = Record<string, { assetId: string } | { text: string }>;

/** `POST /api/projects { fromTemplateId, slots? }`: a project made from the template (nothing is spent). */
export async function createProjectFromTemplate(templateId: string, slots?: SlotFills, title?: string): Promise<{ id: string; title: string }> {
  const r = await apiFetch<{ project: { id: string; title: string } }>('/projects', {
    method: 'POST',
    body: { fromTemplateId: templateId, ...(slots && Object.keys(slots).length ? { slots } : {}), ...(title ? { title } : {}) },
  });
  return r.project;
}

/** `POST /api/templates`: "Save selection as template" (workspace-private). */
export async function saveSelectionAsTemplate(input: { projectId: string; nodeIds: string[]; title: string; category?: TemplateCategory; description?: string }): Promise<TemplateDetail> {
  const r = await apiFetch<{ template: ApiTemplate & { graph: TemplateDetail['graph'] } }>('/templates', { method: 'POST', body: input });
  return { ...summaryFrom(r.template), graph: r.template.graph };
}
