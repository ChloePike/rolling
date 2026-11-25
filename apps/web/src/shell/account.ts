import type { Session } from '@/lib/session';

/** One letter for the avatar: the name's first letter, else the email's, else a neutral mark. */
export function accountInitial(s: Pick<Session, 'user'>): string {
  const src = s.user?.name?.trim() || s.user?.email?.trim() || '';
  const ch = src ? Array.from(src)[0]! : '•';
  return ch.toLocaleUpperCase();
}

/** Display name: the profile name, else the email's local part. */
export function accountName(s: Pick<Session, 'user'>): string {
  return s.user?.name?.trim() || s.user?.email?.split('@')[0] || '';
}

/** Public handle for `/u/:handle` until handles exist on the server: the email's local part, lowercased and safe. */
export function accountHandle(s: Pick<Session, 'user'>): string {
  const base = (s.user?.email?.split('@')[0] ?? s.user?.name ?? 'me').toLowerCase().replace(/[^a-z0-9_]/g, '');
  return base.length >= 3 ? base.slice(0, 24) : `${base}_me`.slice(0, 24);
}
