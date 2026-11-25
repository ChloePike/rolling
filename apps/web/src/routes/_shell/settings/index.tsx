import { createFileRoute, redirect } from '@tanstack/react-router';

/** `/settings` opens the default section, billing (handoff section 1). */
export const Route = createFileRoute('/_shell/settings/')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/$section', params: { section: 'billing' } });
  },
});
