import { createFileRoute } from '@tanstack/react-router';
import { QuickCreatePage } from '@/features/tools';

export const Route = createFileRoute('/_shell/create/quick')({
  // Tool screens fill the area under the header (no page padding).
  staticData: { fullBleed: true },
  component: () => <QuickCreatePage />,
});
