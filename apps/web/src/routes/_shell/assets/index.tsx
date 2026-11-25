import { createFileRoute } from '@tanstack/react-router';
import { AssetsPage } from '../../../features/library/AssetsPage';

interface AssetsSearch {
  folder?: string;
}

export const Route = createFileRoute('/_shell/assets/')({
  validateSearch: (search: Record<string, unknown>): AssetsSearch =>
    typeof search.folder === 'string' && search.folder ? { folder: search.folder } : {},
  component: AssetsRoute,
});

function AssetsRoute() {
  const { folder } = Route.useSearch();
  return <AssetsPage key={folder ?? 'all'} folder={folder ?? 'all'} />;
}
