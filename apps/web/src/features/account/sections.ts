/**
 * Settings sections (`/settings/:section`). Kept apart from `SettingsPage` so the
 * route's `beforeLoad`, which stays in the main chunk, does not pull the page into it.
 */
export const SETTINGS_SECTIONS = ['account', 'preferences', 'billing', 'team', 'notifications'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(s: string): s is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(s);
}
