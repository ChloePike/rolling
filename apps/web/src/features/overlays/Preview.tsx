import type { PlanId } from '@rolling/core/pricing/config';
import { isMockApi, mockData } from '@/lib/api/mode';
import { NotFound } from '@/pages/NotFound';

export interface OverlayPreviewSearch {
  c?: 'modelPicker' | 'params' | 'runConfirm' | 'paywall' | 'viewer';
  kind?: string;
  variant?: string;
  /** `dialog` renders the real modal (scrim + motion) instead of the bare panel. */
  as?: 'panel' | 'dialog';
  /** Params: the plan whose resolution caps apply (D-006). */
  plan?: PlanId;
}

/**
 * Renders one overlay with the design's mock data at the design artboard's
 * position (top-left), for the fidelity specs in e2e/overlays.spec.ts.
 */
export function OverlayPreview(props: OverlayPreviewSearch) {
  // Mock builds only: the design's data is never shipped to or shown in real mode.
  if (!isMockApi()) return <NotFound />;
  const { MockOverlayPreview } = mockData().overlayPreview;
  return <MockOverlayPreview {...props} />;
}
