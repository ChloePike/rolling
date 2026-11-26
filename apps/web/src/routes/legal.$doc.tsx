import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { isLegalDocId } from '@/features/legal/docs';

/** Old `/legal/<doc>` paths: permanent redirect to the canonical `/<doc>` (e.g. `/legal/privacy` → `/privacy`). */
export const Route = createFileRoute('/legal/$doc')({
  beforeLoad: ({ params, location }) => {
    if (!isLegalDocId(params.doc)) throw notFound();
    throw redirect({ href: `/${params.doc}${location.hash ? `#${location.hash}` : ''}`, replace: true });
  },
});
