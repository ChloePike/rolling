import { createFileRoute } from '@tanstack/react-router';
import { RemixPage } from '@/features/tools';

export const Route = createFileRoute('/_shell/create/remix')({
  component: () => <RemixPage />,
});
