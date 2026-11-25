import { createFileRoute } from '@tanstack/react-router';
import { QuickCreatePage } from '../../../features/tools';

export const Route = createFileRoute('/_shell/create/quick')({
  component: () => <QuickCreatePage />,
});
