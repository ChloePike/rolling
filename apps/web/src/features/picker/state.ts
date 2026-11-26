import type { LibraryCategoryKey } from '@rolling/core/library/types';
import type { AssetPick, AssetPickerOptions, PickerTab, PickerUpload, PickKind } from './types';

/**
 * Pure state of the asset picker: tab, filters, selection, uploads and the
 * keyboard cursor. The component only renders it; everything that decides
 * what is selected or where the cursor goes lives here (unit-tested).
 */
export interface PickerState {
  tab: PickerTab;
  /** My assets kind filter. */
  kind: PickKind | 'all';
  /** Public library category. */
  category: LibraryCategoryKey | 'all';
  query: string;
  multiple: boolean;
  /** In picking order. */
  selected: AssetPick[];
  /** Keyboard cursor in the current grid. */
  active: number;
  /** Uploads started from this picker, newest first. */
  uploads: PickerUpload[];
}

export const ALL_KINDS: PickKind[] = ['image', 'video', 'audio', 'character'];

/** The kinds a caller takes (every kind when it doesn't say). */
export function allowedKinds(opts: Pick<AssetPickerOptions, 'kinds'>): PickKind[] {
  return opts.kinds?.length ? opts.kinds : ALL_KINDS;
}

/** The public library has images only, so it is offered only to callers that take images or characters. */
export function publicAllowed(opts: Pick<AssetPickerOptions, 'kinds'>): boolean {
  const k = allowedKinds(opts);
  return k.includes('image') || k.includes('character');
}

export function initialState(opts: AssetPickerOptions, preselected: AssetPick[] = []): PickerState {
  const kinds = allowedKinds(opts);
  const pub = publicAllowed(opts);
  const tab: PickerTab = opts.tab && (opts.tab !== 'public' || pub) ? opts.tab : opts.categories?.length && pub ? 'public' : 'mine';
  return {
    tab,
    kind: kinds.length === 1 ? kinds[0]! : 'all',
    category: opts.categories?.[0] ?? 'all',
    query: '',
    multiple: !!opts.multiple,
    selected: preselected,
    active: 0,
    uploads: [],
  };
}

export type PickerAction =
  | { type: 'tab'; tab: PickerTab }
  | { type: 'kind'; kind: PickKind | 'all' }
  | { type: 'category'; category: LibraryCategoryKey | 'all' }
  | { type: 'query'; query: string }
  | { type: 'toggle'; pick: AssetPick }
  | { type: 'clear' }
  | { type: 'active'; index: number }
  | { type: 'uploadStarted'; uploads: PickerUpload[] }
  | { type: 'uploadDone'; id: string; pick: AssetPick }
  | { type: 'uploadFailed'; id: string };

const same = (a: AssetPick, b: AssetPick) => a.id === b.id || a.assetId === b.assetId;

/** Single select: the item replaces the selection (clicking it again clears it). Multi: toggles it. */
export function toggle(selected: AssetPick[], pick: AssetPick, multiple: boolean): AssetPick[] {
  const on = selected.some((s) => same(s, pick));
  if (multiple) return on ? selected.filter((s) => !same(s, pick)) : [...selected, pick];
  return on ? [] : [pick];
}

/** Adds without toggling off (a finished upload is selected, never deselected). */
export function select(selected: AssetPick[], pick: AssetPick, multiple: boolean): AssetPick[] {
  if (selected.some((s) => same(s, pick))) return selected;
  return multiple ? [...selected, pick] : [pick];
}

export function isSelected(selected: AssetPick[], pick: Pick<AssetPick, 'id' | 'assetId'>): boolean {
  return selected.some((s) => s.id === pick.id || s.assetId === pick.assetId);
}

export function pickerReducer(s: PickerState, a: PickerAction): PickerState {
  switch (a.type) {
    case 'tab':
      return s.tab === a.tab ? s : { ...s, tab: a.tab, active: 0 };
    case 'kind':
      return { ...s, kind: a.kind, active: 0 };
    case 'category':
      return { ...s, category: a.category, active: 0 };
    case 'query':
      return { ...s, query: a.query, active: 0 };
    case 'toggle':
      return { ...s, selected: toggle(s.selected, a.pick, s.multiple) };
    case 'clear':
      return { ...s, selected: [] };
    case 'active':
      return { ...s, active: Math.max(0, a.index) };
    case 'uploadStarted':
      // Uploads show in My assets, so the picker switches there.
      return { ...s, tab: 'mine', active: 0, uploads: [...a.uploads, ...s.uploads] };
    case 'uploadDone': {
      const up = s.uploads.find((u) => u.id === a.id);
      if (!up) return s;
      return {
        ...s,
        uploads: s.uploads.map((u) => (u.id === a.id ? { ...u, status: 'done', pick: a.pick } : u)),
        // A finished upload is selected (in multi-select it joins the selection).
        selected: select(s.selected, a.pick, s.multiple),
      };
    }
    case 'uploadFailed':
      return { ...s, uploads: s.uploads.map((u) => (u.id === a.id ? { ...u, status: 'failed' } : u)) };
  }
}

/** One cell of the My assets grid: an upload in progress or an item. */
export type GridCell = { type: 'upload'; upload: PickerUpload } | { type: 'item'; pick: AssetPick };

/**
 * My assets cells: uploads still running first, then finished uploads, then
 * the fetched items without the ones already shown as finished uploads.
 * Only items the caller takes (`kind` filter) are listed.
 */
export function mineCells(uploads: PickerUpload[], fetched: AssetPick[], kind: PickKind | 'all', query = ''): GridCell[] {
  const q = query.trim().toLowerCase();
  const fits = (k: PickKind, name: string) => (kind === 'all' || k === kind) && (!q || name.toLowerCase().includes(q));
  const running = uploads.filter((u) => u.status !== 'done' && fits(u.kind, u.name)).map((upload): GridCell => ({ type: 'upload', upload }));
  const finished = uploads.flatMap((u) => (u.status === 'done' && u.pick && fits(u.pick.kind, u.pick.name) ? [u.pick] : []));
  const seen = new Set(finished.map((p) => p.assetId));
  const rest = fetched.filter((p) => !seen.has(p.assetId) && (kind === 'all' || p.kind === kind));
  return [...running, ...[...finished, ...rest].map((pick): GridCell => ({ type: 'item', pick }))];
}

/** Arrow keys over a grid of `count` cells in `cols` columns; Home/End jump to the ends. Returns the new index. */
export function gridMove(index: number, key: string, cols: number, count: number): number {
  if (count <= 0) return 0;
  const c = Math.max(1, cols);
  const i = Math.min(Math.max(0, index), count - 1);
  switch (key) {
    case 'ArrowRight':
      return Math.min(count - 1, i + 1);
    case 'ArrowLeft':
      return Math.max(0, i - 1);
    case 'ArrowDown':
      return i + c < count ? i + c : i;
    case 'ArrowUp':
      return i - c >= 0 ? i - c : i;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'PageDown':
      return Math.min(count - 1, i + c * 3);
    case 'PageUp':
      return Math.max(0, i - c * 3);
    default:
      return i;
  }
}

/** Columns that fit `width` with cells at least `min` wide. */
export function columnsFor(width: number, min: number, gap: number): number {
  if (width <= 0) return 4;
  return Math.max(2, Math.floor((width + gap) / (min + gap)));
}

/** Rows to render for a scroll position (virtualized grid), with `overscan` rows either side. */
export function visibleRows(o: { scrollTop: number; height: number; rowHeight: number; rows: number; overscan?: number }): { start: number; end: number } {
  const over = o.overscan ?? 2;
  if (o.rows <= 0 || o.rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(o.scrollTop / o.rowHeight);
  const last = Math.ceil((o.scrollTop + Math.max(o.height, o.rowHeight)) / o.rowHeight);
  return { start: Math.max(0, first - over), end: Math.min(o.rows, last + over) };
}

/** Whether the grid is close enough to its end to load the next page. */
export function nearEnd(endRow: number, rows: number, threshold = 2): boolean {
  return rows === 0 || endRow >= rows - threshold;
}

const RECENT_MAX = 24;

/** Recent picks, newest first, without duplicates. */
export function pushRecent(recent: AssetPick[], picks: AssetPick[]): AssetPick[] {
  const out = [...picks.slice().reverse()];
  for (const r of recent) if (!out.some((p) => same(p, r))) out.push(r);
  return out.slice(0, RECENT_MAX);
}

/** The `accept` attribute for the kinds a caller takes. */
export function acceptFor(kinds: PickKind[]): string {
  const out = new Set<string>();
  for (const k of kinds) out.add(k === 'character' ? 'image/*' : `${k}/*`);
  return [...out].join(',');
}

/** Kind of a browser file (uploads are probed server-side later). */
export function kindOfFile(file: { type: string }): PickKind | null {
  const t = file.type.split('/')[0];
  return t === 'image' || t === 'video' || t === 'audio' ? t : null;
}

/** Files this caller can take; the rest are refused before uploading. */
export function acceptedFiles<F extends { type: string }>(files: F[], kinds: PickKind[]): { ok: F[]; refused: F[] } {
  const take = new Set<string>(kinds.map((k) => (k === 'character' ? 'image' : k)));
  const ok: F[] = [];
  const refused: F[] = [];
  for (const f of files) {
    const k = kindOfFile(f);
    (k && take.has(k) ? ok : refused).push(f);
  }
  return { ok, refused };
}
