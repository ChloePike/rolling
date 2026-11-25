import { useEffect, useState } from 'react';
import type { Session } from '@/lib/session';
import { accountInitial } from './account';

/**
 * The account's avatar: the profile photo (`user.image`, e.g. the safe-rated
 * `/api/media/avatar/…` redirect) filling its round container, else the
 * initial. A photo that fails to load falls back to the initial.
 */
export function AvatarFace({ session, className }: { session: Pick<Session, 'user'>; className?: string }) {
  const src = session.user?.image ?? null;
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (src && !broken) {
    return <img src={src} alt="" className={className} data-testid="avatar-img" draggable={false} onError={() => setBroken(true)} />;
  }
  return <span aria-hidden="true">{accountInitial(session)}</span>;
}
