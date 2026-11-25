/**
 * Canvas feature (`/p/:projectId`). The editor overlay lives in `./editor`
 * and is passed in through `renderEditor`.
 */
export { CanvasPage, CANVAS_OVERLAYS, type CanvasOverlay, type CanvasPageProps, type CanvasEditorSlotProps } from './CanvasPage';
export { GraphStore, applyOps, diffOps, normalizeOps, type ApplyResult, type LocalOp, type RuntimePatch } from './graph/store';
export { ProjectSync, type SyncStatus, type SyncEvents } from './graph/sync';
export { MockProjectRoom } from './graph/mockRoom';
export { webSocketTransport, type Transport } from './graph/transport';
export { CanvasError } from './CanvasError';
