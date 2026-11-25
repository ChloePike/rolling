/**
 * Shared overlays (handoff 3). Import from `features/overlays`:
 *
 * - ModelPicker: anchored panel; the host positions it (designs: centered above the prompt box).
 * - ParamPopover: anchored panel for video or image settings with a live cost line.
 * - RunConfirm: modal, single run or run-all plan. `RunConfirmPanel` is the panel alone.
 * - Paywall: modal, `join` (no plan) or `credits` (top up). `PaywallPanel` is the panel alone.
 * - ResultViewer: full-screen modal with versions, prompt, params and actions.
 *
 * Every overlay animates with the @rolling/ui motion tokens and fades only under reduced motion.
 * Mock data in `./mocks` matches the design files.
 */
export { ModelPicker, type ModelPickerProps } from './ModelPicker';
export { ParamPopover, type ParamPopoverProps, type VideoParamPopoverProps, type ImageParamPopoverProps } from './ParamPopover';
export { RunConfirm, RunConfirmPanel, type RunConfirmProps, type RunConfirmPanelProps } from './RunConfirm';
export { Paywall, PaywallPanel, defaultPaywallOptions, type PaywallProps, type PaywallPanelProps } from './Paywall';
export { PlanLock, planLockInfo, type PlanLockInfo } from './PlanLock';
export { ResultViewer, ResultViewerContent, formatAgo, type ResultViewerProps, type ResultViewerContentProps } from './ResultViewer';
export * from './types';
export { catalogToOptions, unitCredits } from './catalog';
export {
  mockModels,
  defaultVideoParams,
  defaultImageParams,
  estimateVideoCost,
  estimateImageCost,
  mockGraphPlan,
  mockGraphBlockedNote,
  mockSingleRun,
  mockVersions,
  mockResultActions,
} from './mocks';
