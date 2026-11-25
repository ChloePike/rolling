import { useSyncExternalStore } from 'react';

export type CreationMode = 'simple' | 'advanced';

/**
 * The header settings popover stores `prefs.creationMode` here until M1 wires
 * prefs (see `shell/SettingsPopover.tsx`). Tools read it; they never toggle it.
 */
export const CREATION_MODE_KEY = 'rolling.creationMode';
/** Fired by writers in this tab (the storage event only fires across tabs). */
export const CREATION_MODE_EVENT = 'rolling:creation-mode';

function read(): CreationMode {
  try {
    return window.localStorage.getItem(CREATION_MODE_KEY) === 'advanced' ? 'advanced' : 'simple';
  } catch {
    return 'simple';
  }
}

function subscribe(onChange: () => void): () => void {
  // The settings popover writes synchronously in its click/keydown handlers and
  // does not announce it, so re-read right after any click or key in the page.
  const later = () => window.setTimeout(onChange, 0);
  window.addEventListener('storage', onChange);
  window.addEventListener(CREATION_MODE_EVENT, onChange);
  document.addEventListener('click', later, true);
  document.addEventListener('keydown', later, true);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(CREATION_MODE_EVENT, onChange);
    document.removeEventListener('click', later, true);
    document.removeEventListener('keydown', later, true);
  };
}

export function useCreationMode(): CreationMode {
  return useSyncExternalStore(subscribe, read, () => 'simple');
}
