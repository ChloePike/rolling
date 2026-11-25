import { createFileRoute } from '@tanstack/react-router';
import { AvatarPage } from '@/features/tools';

export const Route = createFileRoute('/_shell/create/avatar')({
  // Tool screens fill the area under the header (no page padding).
  staticData: { fullBleed: true },
  component: () => <AvatarPage />,
});
