import { useQuery } from '@tanstack/react-query';
import { MOCK_FEATURED, MOCK_TEMPLATE_TOTAL, MOCK_TEMPLATES } from './mocks';
import type { TemplateSummary } from './types';

export interface TemplatesPage {
  featured: TemplateSummary[];
  items: TemplateSummary[];
  total: number;
}

/** Mock-backed `GET /api/templates` (GraphQL read per D-003 later). */
export async function fetchTemplates(): Promise<TemplatesPage> {
  return { featured: MOCK_FEATURED, items: MOCK_TEMPLATES, total: MOCK_TEMPLATE_TOTAL };
}

const INITIAL: TemplatesPage = { featured: MOCK_FEATURED, items: MOCK_TEMPLATES, total: MOCK_TEMPLATE_TOTAL };

export function useTemplates() {
  return useQuery({ queryKey: ['templates', 'list'], queryFn: fetchTemplates, initialData: INITIAL });
}
