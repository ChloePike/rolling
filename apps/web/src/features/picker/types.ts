import type { LibraryCategoryKey } from '@rolling/core/library/types';

/** What a picked item is. `character` is a saved Character (its cover image is the asset). */
export type PickKind = 'image' | 'video' | 'audio' | 'character';

/** Where an item comes from; shown on every card. */
export type PickSource = 'mine' | 'team' | 'builtin' | 'public' | 'generated';

export type PickerTab = 'mine' | 'public' | 'recent';

/**
 * One item chosen in the asset picker. `assetId` is always the asset the run
 * or graph references (`ast_…`): a workspace asset, the public item's asset,
 * or a Character's cover asset. `id` is the item's own id (the same asset id,
 * a Character id or a public item id) for selection and display.
 */
export interface AssetPick {
  id: string;
  assetId: string;
  kind: PickKind;
  name: string;
  source: PickSource;
  thumbUrl: string | null;
  /** One line of detail, e.g. `1080×1920` or `12s`. */
  meta?: string;
  /** Public library items: the category and the prompt text that goes into the run. */
  category?: LibraryCategoryKey;
  promptEn?: string | null;
  /** D-005: blurred in the grid. */
  mature?: boolean;
  /** Audio/video length when known. */
  durationSec?: number | null;
}

/** What a caller asks the picker for. */
export interface AssetPickerOptions {
  /** Dialog title, e.g. "Character". Defaults to "Choose from your assets". */
  title?: string;
  /** Kinds this caller takes; the first one is the default filter. Defaults to every kind. */
  kinds?: PickKind[];
  /** Public library categories for this context; the first is preselected (e.g. Character → portrait). */
  categories?: LibraryCategoryKey[];
  /** Opening tab. Defaults to the public library when `categories` is set, else My assets. */
  tab?: PickerTab;
  multiple?: boolean;
  /** Upload project (assets made from a canvas belong to it). */
  projectId?: string;
  /** Label of the confirm button. Defaults to "Use". */
  confirmLabel?: string;
}

/** A file the user is uploading from the picker (through the shared transfer queue, D-011). */
export interface PickerUpload {
  /** Transfer item id (`upl_…`). */
  id: string;
  name: string;
  kind: PickKind;
  /** Object URL for image previews while uploading. */
  previewUrl: string | null;
  status: 'uploading' | 'done' | 'failed';
  /** Set when done. */
  pick?: AssetPick;
}
