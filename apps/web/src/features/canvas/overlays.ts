/**
 * The canvas layers a URL can open (`/p/:id?overlay=…`, like the design's `initOverlay`).
 * Kept apart from `CanvasPage` so the route's search validation, which stays in the
 * main chunk, does not pull the canvas (and @xyflow) into it.
 */
export type CanvasOverlay = 'plan' | 'addMenu' | 'script' | 'share' | 'edit' | 'editAgent' | 'at';
export const CANVAS_OVERLAYS: readonly CanvasOverlay[] = ['plan', 'addMenu', 'script', 'share', 'edit', 'editAgent', 'at'];
