import { createFileRoute } from '@tanstack/react-router';
import { QueuePage } from '@/features/admin/QueuePage';

export const Route = createFileRoute('/admin/queue')({ component: QueuePage });
