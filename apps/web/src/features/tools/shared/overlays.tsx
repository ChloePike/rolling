/**
 * Adapters between the tool screens and the shared overlays in `features/overlays`
 * (ModelPicker, ParamPopover, RunConfirm, ResultViewer). Tools keep model
 * names in their state; the shared picker works with catalog ids. Real mode
 * shows only what the run state, the catalog and the quote say; mock mode reads
 * the designs' sample content through the mock adapter (`mockData()`).
 */
import { useState, type RefObject } from 'react';
import { useIntl } from 'react-intl';
import {
  AUTO_MODEL,
  ModelPicker,
  ParamPopover,
  Paywall,
  ResultViewer,
  resultActions,
  RunConfirm,
  type ModelOption,
  type ParamOptions,
  type ResultActionId,
  type ResultParam,
  type RunPlanRow,
  type VideoAspect,
  type VideoParams,
  type ImageParams,
} from '@/features/overlays';
import type { SpecQuote } from '@/features/overlays/runs';
import { isMockApi, mockData } from '@/lib/api/mode';
import { checkoutPlan, useSession } from '@/lib/session';
import type { PlanId } from '@rolling/core/pricing/config';
import type { MediaRun, ParamKind, PickerKind } from '../types';
import type { ToolModel } from './models';
import { useToolPlan } from './plan';
import type { ToolCaps, ToolSettings } from './settings';

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
  /** The page's settings: what the pills show and the run sends. */
  value: ToolSettings;
  /** What the selected model can do (catalog); hidden settings are absent. */
  caps: ToolCaps;
  onChange: (value: ToolSettings) => void;
  onReset: () => void;
  /** Quoted credits (`POST /api/runs/quote`); null shows a skeleton. */
  cost: number | null;
  onClose: () => void;
  anchorClassName?: string;
  anchorRef: RefObject<HTMLElement | null>;
  /** Locks resolutions above the plan's cap (D-006). */
  plan?: PlanId;
  /** A locked resolution was picked: the upgrade. */
  onLockedPick?: (plan: PlanId) => void;
}

const asVideo = (v: ToolSettings): VideoParams => ({
  aspectRatio: v.ratio as VideoAspect,
  resolution: v.resolution as VideoParams['resolution'],
  duration: `${v.seconds}s` as VideoParams['duration'],
  count: String(v.count) as VideoParams['count'],
  audio: v.audio,
});

const asImage = (v: ToolSettings, quality: ImageParams['quality']): ImageParams => ({
  aspectRatio: v.ratio as VideoAspect,
  quality,
  size: v.resolution as ImageParams['size'],
  count: String(v.count) as ImageParams['count'],
});

/** The shared settings popover, controlled by the page's settings and the model's caps. */
export function ToolParamPopover({ open, kind, value, caps, onChange, onReset, cost, onClose, anchorClassName, anchorRef, plan: planProp, onLockedPick }: ParamProps) {
  const intl = useIntl();
  const plan = useToolPlan(planProp);
  /** Image quality: shown only for the design's sample model (no run parameter behind it). */
  const [quality, setQuality] = useState<ImageParams['quality']>('standard');
  // The design's sample model keeps the design's option rows (ParamPopover.dc.html).
  const options: ParamOptions = caps.design ? {} : {
    ratios: caps.ratios,
    resolutions: caps.resolutions,
    durations: caps.durations.map((n) => `${n}s`),
    counts: caps.counts.length > 1 ? caps.counts.map(String) : null,
    // No run parameter behind image quality: the size is the setting.
    quality: false,
  };
  const max = caps.durations.length ? Math.max(...caps.durations) : 0;
  return (
    <div className={anchorClassName} data-overlay="params">
      {kind === 'video' ? (
        <ParamPopover
          kind="video"
          open={open}
          value={asVideo(value)}
          onValueChange={(v) => onChange({ ...value, ratio: v.aspectRatio, resolution: v.resolution, seconds: parseInt(v.duration, 10) || 0, count: Number(v.count) || 1, audio: v.audio })}
          options={options}
          audioSupported={caps.audio}
          durationNote={isMockApi() ? undefined : max ? intl.formatMessage({ id: 'tools.params.maxSeconds' }, { n: max }) : null}
          cost={cost}
          plan={plan}
          onLockedPick={onLockedPick}
          onReset={onReset}
          onClose={onClose}
          anchorRef={anchorRef}
        />
      ) : (
        <ParamPopover
          kind="image"
          open={open}
          value={asImage(value, quality)}
          onValueChange={(v) => {
            setQuality(v.quality);
            onChange({ ...value, ratio: v.aspectRatio, resolution: v.size, count: Number(v.count) || 1 });
          }}
          options={options}
          cost={cost}
          plan={plan}
          onLockedPick={onLockedPick}
          onReset={onReset}
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
  /** Real mode: the quote being confirmed (rows, balance). */
  quote?: SpecQuote | null;
  /** The run's settings line, e.g. "Seedance 2.5 · 9:16 · 720p · 5s". */
  meta: string;
  onClose: () => void;
  /** Starts the run (the host closes the dialog). */
  onConfirm: () => void;
}

export function ToolRunConfirm({ open, cost, label, views, quote, meta, onClose, onConfirm }: ConfirmProps) {
  const intl = useIntl();
  const mock = isMockApi();
  const kind = views ? 'image' : 'video';
  const demo = mock ? mockData().quick.toolOverlayDemo.confirm : null;
  const rows: RunPlanRow[] = quote
    ? quote.items
        .filter((i) => i.action !== 'none')
        .map((i) => ({
          id: i.ref,
          name: i.title,
          meta: [i.modelName, meta].filter(Boolean).join(' · '),
          kind: i.kind === 'image' ? 'image' : 'video',
          state: i.action === 'run' ? 'run' : i.action === 'reuse' ? 'reuse' : i.action === 'blocked' ? 'blocked' : 'free',
          cost: i.credits,
        }))
    : [{ id: 'run_this', name: intl.formatMessage({ id: views ? 'tools.confirm.rowViews' : 'tools.confirm.row' }), meta: demo?.meta ?? meta, kind, state: 'run', cost }];
  const routed = quote?.items.find((i) => i.action === 'run')?.modelName;
  return (
    <RunConfirm
      open={open}
      onOpenChange={(o) => !o && onClose()}
      variant="single"
      rows={rows}
      total={quote ? quote.total : undefined}
      // Mock mode shows the design's balance and routing; real mode the quote's.
      balance={quote ? quote.balance : (demo?.balance ?? 0)}
      eta={demo?.eta ?? ''}
      subtitle={demo ? demo.subtitle : routed ? intl.formatMessage({ id: 'tools.confirm.routed' }, { model: routed }) : undefined}
      actionLabel={label}
      onConfirm={onConfirm}
    />
  );
}

interface ViewerProps {
  open: boolean;
  aspect: string;
  /** The opened result (a feed card). */
  run: MediaRun | null;
  /** The tool's title, used when a run has no prompt. */
  fallbackTitle: string;
  onClose: () => void;
  onAction: (id: ResultActionId) => void;
}

export function ToolResultViewer({ open, aspect, run, fallbackTitle, onClose, onAction }: ViewerProps) {
  const intl = useIntl();
  const session = useSession();
  const [version, setVersion] = useState('v3');
  const t = (id: string) => intl.formatMessage({ id });
  if (isMockApi()) {
    const m = mockData().overlays;
    const demo = mockData().quick.toolOverlayDemo.viewer;
    return (
      <ResultViewer
        open={open}
        onOpenChange={(o) => !o && onClose()}
        title={demo.title}
        author={demo.author}
        createdAt={new Date(Date.now() - 10 * 60_000)}
        aspectRatio={aspect}
        versions={m.mockVersions}
        versionId={version}
        onVersionChange={setVersion}
        currentVersionId="v3"
        durationSec={15}
        positionSec={4}
        // Runs started here show their own prompt; seeded history uses the design's details.
        prompt={run?.cost !== undefined ? run.prompt : demo.prompt}
        params={demo.params.map(([label, value]) => ({
          label: t(label),
          value: label === 'tools.viewer.mode' ? t('tools.viewer.fromTemplate') : label === 'tools.viewer.cost' ? intl.formatMessage({ id: 'tools.viewer.credits' }, { n: demo.cost }) : value,
        }))}
        assets={demo.assets}
        actions={m.mockResultActions}
        onAction={(id) => onAction(id)}
      />
    );
  }
  // Real mode: what the feed card knows about the run, nothing more.
  const params: ResultParam[] = run?.tags.length ? [{ label: t('tools.viewer.settings'), value: run.tags.join(' · ') }] : [];
  if (run?.cost !== undefined) params.push({ label: t('tools.viewer.cost'), value: intl.formatMessage({ id: 'tools.viewer.credits' }, { n: run.cost }) });
  const tile = run?.tiles.find((x) => x.src);
  return (
    <ResultViewer
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={run?.prompt.slice(0, 80) || fallbackTitle}
      author={session.user?.name ?? ''}
      createdAt={new Date(Date.now() - (run?.finishedAgoMin ?? 0) * 60_000)}
      aspectRatio={aspect}
      mediaKind={run?.video === false ? 'image' : 'video'}
      versions={[{ id: 'current', label: t('tools.viewer.current'), tone: run?.tiles[0]?.tone ?? 'var(--c-tone-blank)' }]}
      versionId="current"
      onVersionChange={() => undefined}
      currentVersionId="current"
      src={tile?.src}
      durationSec={run?.durationSec}
      prompt={run?.prompt ?? ''}
      params={params}
      assets={[]}
      actions={resultActions()}
      onAction={(id) => onAction(id)}
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
  return (
    <Paywall
      open={open}
      onOpenChange={(o) => !o && onClose()}
      variant="join"
      onContinue={(option) => void checkoutPlan(option.id).then(onClose)}
    />
  );
}
