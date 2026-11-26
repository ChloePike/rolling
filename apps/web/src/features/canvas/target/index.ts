/** Real canvases for "canvas" actions: the sidebar item, send-to-canvas, the not-found page. */
export { resolveCanvasTarget, createOnce, freePosition, mostRecent, type CanvasSummary, type CanvasTarget, type ResolveDeps } from './resolve';
export { activeWorkspace, canvasesQuery, createCanvas, findProjectWorkspace, forgetCanvas, lastCanvas, listCanvases, mockProjectOpens, rememberCanvas, resolveNavCanvas } from './projects';
export { incomingParams, saveIncoming, takeIncoming, type IncomingItem, type IncomingMedia } from './incoming';
export { ChooseCanvasDialog, useSendToCanvas, type SendOptions, type SendToCanvas } from './SendToCanvas';
