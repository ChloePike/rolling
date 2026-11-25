import { createFileRoute } from '@tanstack/react-router';
import { PublicLibraryPage } from '../../../features/library/PublicLibraryPage';

interface PublicSearch {
  cat?: string;
}

export const Route = createFileRoute('/_shell/assets/public')({
  validateSearch: (search: Record<string, unknown>): PublicSearch =>
    typeof search.cat === 'string' && search.cat ? { cat: search.cat } : {},
  component: PublicRoute,
});

function PublicRoute() {
  const { cat } = Route.useSearch();
  return <PublicLibraryPage category={cat} />;
}
