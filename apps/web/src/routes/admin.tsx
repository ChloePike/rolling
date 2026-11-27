import { createFileRoute } from '@tanstack/react-router';
import { AdminLayout } from '@/features/admin/AdminLayout';

/** Admin console (D-025): staff only, checked by the server on every call. */
export const Route = createFileRoute('/admin')({ component: AdminLayout });
