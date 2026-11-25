import { createFileRoute } from '@tanstack/react-router';
import { OverlayPreview, type OverlayPreviewSearch } from '@/features/overlays/Preview';

/** Fidelity preview for the shared overlays (not linked from the app; used by e2e/overlays.spec.ts). */
export const Route = createFileRoute('/preview/overlays')({
  validateSearch: (s: Record<string, unknown>): OverlayPreviewSearch => ({
    c: typeof s.c === 'string' ? (s.c as OverlayPreviewSearch['c']) : undefined,
    kind: typeof s.kind === 'string' ? s.kind : undefined,
    variant: typeof s.variant === 'string' ? s.variant : undefined,
    as: s.as === 'dialog' ? 'dialog' : 'panel',
    plan: s.plan === 'starter' || s.plan === 'plus' || s.plan === 'pro' ? s.plan : undefined,
  }),
  component: function Preview() {
    return <OverlayPreview {...Route.useSearch()} />;
  },
});
