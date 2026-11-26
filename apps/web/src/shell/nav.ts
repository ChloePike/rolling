import type { IconName } from './icons';

export interface NavItem {
  id: string;
  messageId: string;
  icon: IconName;
  to: string;
  params?: Record<string, string>;
  /** Path prefix that marks this item active. */
  match: string;
  exact?: boolean;
}

/** Nav order (handoff section 1): Home, Canvas, Quick Create, Remix, Avatar, Characters, Assets, Activity. */
export const navItems: readonly NavItem[] = [
  { id: 'home', messageId: 'nav.home', icon: 'home', to: '/', match: '/', exact: true },
  // `/canvas` resolves to a real project (last opened, else most recent, else a new one) and redirects to `/p/:id`.
  { id: 'canvas', messageId: 'nav.canvas', icon: 'canvas', to: '/canvas', match: '/p/' },
  { id: 'quickCreate', messageId: 'nav.quickCreate', icon: 'bolt', to: '/create/quick', match: '/create/quick' },
  { id: 'remix', messageId: 'nav.remix', icon: 'clapper', to: '/create/remix', match: '/create/remix' },
  { id: 'avatar', messageId: 'nav.avatar', icon: 'person', to: '/create/avatar', match: '/create/avatar' },
  { id: 'characters', messageId: 'nav.characters', icon: 'people', to: '/create/character', match: '/create/character' },
  { id: 'assets', messageId: 'nav.assets', icon: 'image', to: '/assets', match: '/assets' },
  { id: 'activity', messageId: 'nav.activity', icon: 'history', to: '/activity', match: '/activity' },
];

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.exact) return pathname === item.match;
  return pathname === item.match || pathname.startsWith(item.match.endsWith('/') ? item.match : `${item.match}/`);
}
