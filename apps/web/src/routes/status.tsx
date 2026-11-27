import { createFileRoute } from '@tanstack/react-router';
import { StatusPage } from '@/features/trust/StatusPage';

/** Public status page (D-029). */
export const Route = createFileRoute('/status')({ component: StatusPage });
