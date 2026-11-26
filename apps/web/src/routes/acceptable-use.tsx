import { createFileRoute } from '@tanstack/react-router';
import { LegalPage } from '@/features/legal/LegalPage';

/** Public legal page (no session; `legal/*.md`). */
export const Route = createFileRoute('/acceptable-use')({
  component: () => <LegalPage doc="acceptable-use" />,
});
