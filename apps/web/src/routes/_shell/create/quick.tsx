import { createFileRoute } from '@tanstack/react-router';
import { QuickCreatePage } from '@/features/tools';

interface QuickSearch {
  template?: string;
  ratio?: string;
}

export const Route = createFileRoute('/_shell/create/quick')({
  // Tool screens fill the area under the header (no page padding).
  staticData: { fullBleed: true },
  validateSearch: (s: Record<string, unknown>): QuickSearch => ({
    ...(typeof s.template === 'string' && s.template ? { template: s.template } : {}),
    ...(typeof s.ratio === 'string' && s.ratio ? { ratio: s.ratio } : {}),
  }),
  component: QuickRoute,
});

function QuickRoute() {
  const { template, ratio } = Route.useSearch();
  return <QuickCreatePage key={`${template ?? ''}:${ratio ?? ''}`} templateId={template} ratio={ratio} />;
}
