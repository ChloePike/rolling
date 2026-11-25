import { useState } from 'react';
import { ModelPicker } from './ModelPicker';
import { mockModels, mockGraphBlockedNote, mockGraphPlan, mockResultActions, mockSingleRun, mockVersions, defaultImageParams, defaultVideoParams } from './mocks';
import { ParamPopover } from './ParamPopover';
import { PaywallPanel } from './Paywall';
import { ResultViewer } from './ResultViewer';
import { RunConfirm, RunConfirmPanel } from './RunConfirm';
import { AUTO_MODEL, type ImageParams, type ModelKind, type VideoParams } from './types';

export interface OverlayPreviewSearch {
  c?: 'modelPicker' | 'params' | 'runConfirm' | 'paywall' | 'viewer';
  kind?: string;
  variant?: string;
  /** `dialog` renders the real modal (scrim + motion) instead of the bare panel. */
  as?: 'panel' | 'dialog';
}

const TEN_MIN_AGO = () => new Date(Date.now() - 10 * 60_000);

/**
 * Renders one overlay with the design's mock data at the design artboard's
 * position (top-left), for the fidelity specs in e2e/overlays.spec.ts.
 */
export function OverlayPreview({ c = 'modelPicker', kind, variant, as = 'panel' }: OverlayPreviewSearch) {
  const [model, setModel] = useState(AUTO_MODEL);
  const [video, setVideo] = useState<VideoParams>(defaultVideoParams);
  const [image, setImage] = useState<ImageParams>(defaultImageParams);
  const [version, setVersion] = useState('v3');
  const [open, setOpen] = useState(true);
  const [skip, setSkip] = useState(false);

  let body: React.ReactNode = null;
  if (c === 'modelPicker') {
    body = <ModelPicker kind={(kind as ModelKind) ?? 'video'} models={mockModels[(kind as ModelKind) ?? 'video']} value={model} onValueChange={setModel} open={open} onClose={() => setOpen(false)} dismissOnOutside={false} />;
  } else if (c === 'params') {
    body =
      kind === 'image' ? (
        <ParamPopover kind="image" value={image} onValueChange={setImage} open={open} onClose={() => setOpen(false)} dismissOnOutside={false} />
      ) : (
        <ParamPopover kind="video" value={video} onValueChange={setVideo} open={open} onClose={() => setOpen(false)} dismissOnOutside={false} />
      );
  } else if (c === 'runConfirm') {
    const graph = variant === 'graph';
    const props = {
      variant: graph ? ('graph' as const) : ('single' as const),
      rows: graph ? mockGraphPlan : mockSingleRun,
      balance: 2480,
      eta: graph ? '~4 min' : '~2 min',
      subtitle: graph ? undefined : 'Auto → Seedance 2.5',
      actionLabel: 'Generate video',
      blockedNote: graph ? mockGraphBlockedNote : undefined,
      skipUnderThreshold: skip,
      onSkipUnderThresholdChange: setSkip,
      onConfirm: () => setOpen(false),
    };
    body = as === 'dialog' ? <RunConfirm {...props} open={open} onOpenChange={setOpen} /> : <RunConfirmPanel {...props} onCancel={() => undefined} />;
  } else if (c === 'paywall') {
    body = <PaywallPanel variant={variant === 'credits' ? 'credits' : 'join'} onContinue={() => undefined} onClose={() => undefined} />;
  } else if (c === 'viewer') {
    body = (
      <ResultViewer
        open={open}
        onOpenChange={setOpen}
        title="Two-person product demo · New lighting"
        author="Alex"
        createdAt={TEN_MIN_AGO()}
        aspectRatio={kind ?? '9/16'}
        versions={mockVersions}
        versionId={version}
        currentVersionId={version}
        onVersionChange={setVersion}
        prompt="In shot 2, change the white daylight outside the window to warm golden-hour light. Keep the action and camera position."
        params={[
          { label: 'Model', value: 'Seedance 2.5' },
          { label: 'Mode', value: 'From template' },
          { label: 'Aspect ratio', value: '9:16' },
          { label: 'Duration', value: '15s' },
          { label: 'Resolution', value: '720p' },
          { label: 'Seed', value: '48213' },
          { label: 'Took', value: '1m 52s' },
          { label: 'Cost', value: '10 credits' },
        ]}
        assets={[
          { id: 'ast_1', name: 'Product photo', tone: '#26232A' },
          { id: 'ast_2', name: 'Character', tone: '#1F2628' },
        ]}
        actions={mockResultActions}
        onAction={() => undefined}
      />
    );
  }
  return (
    <div data-testid="overlay-preview" style={{ minHeight: '100vh', background: 'var(--c-bg)' }}>
      <div style={{ display: 'inline-block' }} data-testid="overlay-slot">
        {body}
      </div>
      <button type="button" data-testid="preview-toggle" style={{ position: 'fixed', right: 8, bottom: 8, opacity: 0 }} onClick={() => setOpen((o) => !o)}>
        toggle
      </button>
    </div>
  );
}
