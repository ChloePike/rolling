/**
 * Canvas feature (`/p/:projectId`). The editor overlay lives in `./editor`
 * and is passed in through `renderEditor`.
 */
export { CanvasPage, CANVAS_OVERLAYS, type CanvasOverlay, type CanvasPageProps, type CanvasEditorSlotProps } from './CanvasPage';
export { GraphStore, applyOps, diffOps, normalizeOps, type ApplyResult, type LocalOp, type RuntimePatch } from './graph/store';
export { ProjectSync, type SyncStatus, type SyncEvents } from './graph/sync';
export { MockProjectRoom } from './graph/mockRoom';
export { webSocketTransport, type Transport } from './graph/transport';
export { validateConnection, resolveInputPort, inputPorts, outputType } from './graph/ports';
export type * from './graph/types';
export type { WsEnvelope, ServerMessage, ClientMessage, ProjectSnapshot } from './graph/protocol';
