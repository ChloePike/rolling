import { createFileRoute } from '@tanstack/react-router';
import { AvatarPage } from '@/features/tools';

export const Route = createFileRoute('/_shell/create/avatar')({
  component: () => <AvatarPage />,
});
