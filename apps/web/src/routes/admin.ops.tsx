import { createFileRoute } from '@tanstack/react-router';
import { OpsPage } from '@/features/admin/OpsPage';

export const Route = createFileRoute('/admin/ops')({ component: OpsPage });
