import { createFileRoute } from '@tanstack/react-router';
import { RemixPage } from '@/features/tools';

export const Route = createFileRoute('/_shell/create/remix')({
  // Tool screens fill the area under the header (no page padding).
  staticData: { fullBleed: true },
  component: () => <RemixPage />,
});
