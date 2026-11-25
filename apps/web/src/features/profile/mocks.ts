export interface ProfileWork {
  id: string;
  title: string;
  durationSec: number;
  kind: 'published' | 'template';
  /** D-005: mature outputs never appear on public surfaces. */
  mature: boolean;
  /** Content rating of the output; suggestive and explicit are never public. */
  rating?: 'safe' | 'suggestive' | 'explicit';
  /** Real API: the signed cover image and, for published works, the share link (`/share/:id`). */
  coverUrl?: string | null;
  shareId?: string;
}

export interface PublicProfile {
  name: string;
  handle: string;
  /** Null until the user writes one; the design shows the placeholder. */
  bio: string | null;
  works: ProfileWork[];
  avatarUrl?: string | null;
  /** The signed-in user's own profile. */
  isYou?: boolean;
  /** Own profile without a chosen handle yet (real API): the page offers to pick one. */
  unclaimed?: boolean;
}

/** Profile.dc.html, plus a mature and a suggestive work that must never be listed publicly. */
export const profileMock: PublicProfile = {
  name: 'Alex Chen',
  handle: 'alexmakes',
  bio: null,
  works: [
    { id: 'w1', title: 'Ridgeline Sparkling, 15s', durationSec: 15, kind: 'published', mature: false },
    { id: 'w2', title: 'Desk organizer pitch', durationSec: 10, kind: 'published', mature: false },
    { id: 'w3', title: 'Morning routine', durationSec: 20, kind: 'published', mature: false },
    { id: 'w4', title: 'Sneaker try-on', durationSec: 8, kind: 'published', mature: false },
    { id: 'w5', title: 'Holiday gift', durationSec: 15, kind: 'published', mature: false },
    { id: 'w6', title: 'Coffee maker features', durationSec: 12, kind: 'published', mature: false },
    { id: 'w7', title: 'Rainy street mood', durationSec: 9, kind: 'published', mature: false },
    { id: 'w8', title: 'Café window portrait', durationSec: 6, kind: 'published', mature: false },
    { id: 'w9', title: 'Late night set', durationSec: 12, kind: 'published', mature: true },
    { id: 'w10', title: 'Beach shoot', durationSec: 8, kind: 'published', mature: false, rating: 'suggestive' },
    { id: 't1', title: 'Two-person product demo', durationSec: 15, kind: 'template', mature: false },
    { id: 't2', title: 'Talking head, desk', durationSec: 10, kind: 'template', mature: false },
  ],
};
