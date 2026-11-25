import type { LibraryCategoryKey, LibraryLicense } from '@rolling/core/library/types';
import type { PromptIconName } from './icons';

/** Where a reference comes from. Shown on every card and chip (handoff 3). */
export type RefSource = 'mine' | 'team' | 'builtin' | 'public';

/** Picker tab a reference belongs to. `all` is the union. */
export type RefGroup = 'mine' | 'char' | 'voice' | 'pub';
export type RefTab = 'all' | RefGroup;

/** Placeholder art for a reference card until a thumbnail loads (or when it has none). */
export type RefGlyph =
  | { type: 'icon'; icon: PromptIconName }
  | { type: 'letter'; letter: string }
  | { type: 'wave' };

/**
 * One item the `@` picker can reference: an asset, character, voice or public
 * library item. Shaped after `GET /api/assets` rows.
 */
export interface RefItem {
  /** Asset id (`ast_…`), character id, voice id or public item id (`pw_…`). */
  id: string;
  group: RefGroup;
  /** Public library category; only for `group: 'pub'`. */
  category?: LibraryCategoryKey;
  name: string;
  /** One line of detail, e.g. `Image · 2048×2048`. */
  meta: string;
  source: RefSource;
  /** Card background shown behind the glyph or while the thumbnail loads. */
  tone: string;
  glyph: RefGlyph;
  /** Optional thumbnail. Falls back to the glyph if it fails to load. */
  thumbUrl?: string;
  license?: LibraryLicense;
}

/**
 * A pill in the prompt box control row. The first pill is always the model
 * pill (handoff 4: "Model pill first").
 */
export interface PromptPill {
  id: string;
  kind: 'model' | 'param';
  label: string;
  icon: PromptIconName;
  /** Accessible name when the label alone is unclear, e.g. "Model: Seedance 2.5". */
  ariaLabel?: string;
}

/** A row in the `/` command palette or the Skills list of the `+` menu. */
export interface PromptCommand {
  id: string;
  /** Shown after the slash, e.g. `TV ad` renders as `/TV ad`. */
  name: string;
  description: string;
  icon: PromptIconName;
  /** Skills become a chip above the prompt; actions are handled by the host. */
  kind: 'skill' | 'action';
  /** Action commands that open a prompt-box pill (Model, Aspect ratio, Duration) name it here. */
  pillId?: string;
}

export interface PromptCommandGroup {
  id: string;
  title: string;
  items: PromptCommand[];
}

/** A creation mode tab in the prompt box header (Home: Agent, Image, Video, Avatar). */
export interface PromptMode {
  id: string;
  label: string;
  icon: PromptIconName;
}
