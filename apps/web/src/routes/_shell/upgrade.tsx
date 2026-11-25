import { createFileRoute } from '@tanstack/react-router';
import { UpgradePage } from '../../features/account/UpgradePage';

export const Route = createFileRoute('/_shell/upgrade')({
  component: () => <UpgradePage />,
});
