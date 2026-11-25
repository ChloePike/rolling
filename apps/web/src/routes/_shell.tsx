import { createFileRoute } from '@tanstack/react-router';
import { AppShell } from '@/shell/AppShell';

/** Pathless layout: every route under `_shell/` gets the shared header. */
export const Route = createFileRoute('/_shell')({
  component: AppShell,
});
