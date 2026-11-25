/**
 * Adapters between the tool screens and the shared overlays in `features/overlays`
 * (ModelPicker, ParamPopover, RunConfirm, ResultViewer). Tools keep model
 * names in their state; the shared picker works with catalog ids.
 */
import { useState, type RefObject } from 'react';
import { useIntl } from 'react-intl';
import {
  AUTO_MODEL,
  defaultImageParams,
  defaultVideoParams,
  estimateImageCost,
  estimateVideoCost,
  mockResultActions,
  mockVersions,
  ModelPicker,
  ParamPopover,
  Paywall,
  ResultViewer,
  RunConfirm,
  type ImageParams,
  type ModelOption,
  type VideoParams,
} from '@/features/overlays';
import type { ParamKind, PickerKind } from '../types';
import type { ToolModel } from './models';
import { lockedResolutions, mockPlan } from './plan';
import type { PlanId } from '@rolling/core/pricing/config';

/** Balance shown in quotes until the credits API lands (same placeholder as the header). */
const BALANCE = 2480;

function toOption(m: ToolModel): ModelOption {
  return {
    id: m.id,
    name: m.name,
    mark: m.mark,
    tone: m.tone,
    tags: m.tags,
    credits: m.credits,
    unit: m.unit,
    eta: m.eta,
    badge: m.badge,
    disabled: m.disabled,
  };
}

interface PickerProps {
  open: boolean;
  kind: PickerKind;
  models: ToolModel[];
  /** Selected model name, or "Auto". */
  selected: string;
  onPick: (name: string) => void;
  onClose: () => void;
  anchorClassName?: string;
  /** Pills that toggle the layer; pointer down there does not dismiss it. */
  anchorRef: RefObject<HTMLElement | null>;
}

export function ToolModelPicker({ open, kind, models, selected, onPick, onClose, anchorClassName, anchorRef }: PickerProps) {
  const value = selected === 'Auto' ? AUTO_MODEL : (models.find((m) => m.name === selected)?.id ?? AUTO_MODEL);
  return (
    <div className={anchorClassName} data-overlay="model">
      <ModelPicker
        open={open}
        kind={kind}
        models={models.map(toOption)}
        value={value}
        onValueChange={(id) => onPick(id === AUTO_MODEL ? 'Auto' : (models.find((m) => m.id === id)?.name ?? 'Auto'))}
        onClose={onClose}
        anchorRef={anchorRef}
      />
    </div>
  );
}

interface ParamProps {
  open: boolean;
  kind: ParamKind;
  onClose: () => void;
  anchorClassName?: string;
  anchorRef: RefObject<HTMLElement | null>;
  /** Locks resolutions above the plan's cap (D-006). */
  plan?: PlanId;
}

export function ToolParamPopover({ open, kind, onClose, anchorClassName, anchorRef, plan = mockPlan }: ParamProps) {
  const [video, setVideo] = useState<VideoParams>(defaultVideoParams);
  const [image, setImage] = useState<ImageParams>(defaultImageParams);
  return (
    <div className={anchorClassName} data-overlay="params">
      {kind === 'video' ? (
        <ParamPopover
          kind="video"
          open={open}
          value={video}
          onValueChange={setVideo}
          cost={estimateVideoCost(video)}
          unsupported={{ resolution: lockedResolutions(plan, 'video', ['480p', '720p', '1080p']) as VideoParams['resolution'][] }}
          onReset={() => setVideo(defaultVideoParams)}
          onClose={onClose}
          anchorRef={anchorRef}
        />
      ) : (
        <ParamPopover
          kind="image"
          open={open}
          value={image}
          onValueChange={setImage}
          cost={estimateImageCost(image)}
          onReset={() => setImage(defaultImageParams)}
          onClose={onClose}
          anchorRef={anchorRef}
        />
      )}
    </div>
  );
}

interface ConfirmProps {
  open: boolean;
  cost: number;
  label: string;
  /** Image runs (Characters) quote the pair of views. */
  views?: boolean;
  onClose: () => void;
}

export function ToolRunConfirm({ open, cost, label, views, onClose }: ConfirmProps) {
  const intl = useIntl();
  return (
    <RunConfirm
      open={open}
      onOpenChange={(o) => !o && onClose()}
      variant="single"
      rows={[
        {
          id: 'run_this',
          name: intl.formatMessage({ id: views ? 'tools.confirm.rowViews' : 'tools.confirm.row' }),
          meta: 'Auto → Seedance 2.5 · 9:16 · 720p · 15s',
          kind: views ? 'image' : 'video',
          state: 'run',
          cost,
        },
      ]}
      balance={BALANCE}
      eta="~2 min"
      subtitle="Auto → Seedance 2.5"
      actionLabel={label}
      onConfirm={onClose}
    />
  );
}

interface ViewerProps {
  open: boolean;
  aspect: string;
  onClose: () => void;
}

export function ToolResultViewer({ open, aspect, onClose }: ViewerProps) {
  const intl = useIntl();
  const [version, setVersion] = useState('v3');
  const t = (id: string) => intl.formatMessage({ id });
  return (
    <ResultViewer
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Two-person product demo · New lighting"
      author="Alex"
      createdAt={new Date(Date.now() - 10 * 60_000)}
      aspectRatio={aspect}
      versions={mockVersions}
      versionId={version}
      onVersionChange={setVersion}
      currentVersionId="v3"
      durationSec={15}
      positionSec={4}
      prompt="In shot 2, change the white daylight outside the window to warm golden-hour light. Keep the action and camera position."
      params={[
        { label: t('tools.viewer.model'), value: 'Seedance 2.5' },
        { label: t('tools.viewer.mode'), value: t('tools.viewer.fromTemplate') },
        { label: t('tools.viewer.aspect'), value: '9:16' },
        { label: t('tools.viewer.duration'), value: '15s' },
        { label: t('tools.viewer.resolution'), value: '720p' },
        { label: t('tools.viewer.seed'), value: '48213' },
        { label: t('tools.viewer.took'), value: '1m 52s' },
        { label: t('tools.viewer.cost'), value: intl.formatMessage({ id: 'tools.viewer.credits' }, { n: 10 }) },
      ]}
      assets={[
        { id: 'ast_lead', name: '@Lead', tone: '#26232A' },
        { id: 'ast_room', name: 'Kitchen set', tone: '#1F2628' },
      ]}
      actions={mockResultActions}
      onAction={() => onClose()}
    />
  );
}

interface PaywallAdapterProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Join paywall for non-members (D-007): opens from Generate and from the agent
 * path; the composer keeps what was typed so the run resumes after checkout.
 */
export function ToolPaywall({ open, onClose }: PaywallAdapterProps) {
  return <Paywall open={open} onOpenChange={(o) => !o && onClose()} variant="join" onContinue={() => onClose()} />;
}
