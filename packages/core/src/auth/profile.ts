import { z } from 'zod';

/**
 * Public profile rules: handles and bios (`PATCH /api/me/profile`,
 * `GET /api/profiles/:handle`). Handles are 3–30 characters of a-z, 0-9,
 * `_` and `.`, stored lowercase and unique case-insensitively. Reserved words
 * (app routes, roles, brand and support names) are refused like taken ones.
 */
export const HANDLE_MIN = 3;
export const HANDLE_MAX = 30;
export const HANDLE_RE = /^[a-z0-9_.]{3,30}$/;
export const BIO_MAX = 160;
export const NAME_MAX = 80;

export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'about', 'account', 'activity', 'admin', 'administrator', 'api', 'app', 'apps', 'assets', 'auth', 'billing', 'blog',
  'canvas', 'checkout', 'claude', 'contact', 'create', 'dashboard', 'delete', 'dev', 'docs', 'download', 'edit', 'editor',
  'email', 'explore', 'faq', 'feedback', 'help', 'home', 'invite', 'invites', 'join', 'legal', 'library', 'login', 'logout',
  'mail', 'me', 'media', 'mod', 'moderator', 'new', 'null', 'official', 'owner', 'pricing', 'privacy', 'profile', 'profiles',
  'projects', 'root', 'rolling', 'security', 'settings', 'share', 'signin', 'signup', 'staff', 'status', 'support', 'system',
  'team', 'templates', 'terms', 'test', 'tools', 'u', 'undefined', 'upgrade', 'user', 'users', 'www',
]);

/** Lowercases and trims a typed handle (a leading `@` is dropped). */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, '').toLowerCase();
}

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(normalizeHandle(handle));
}

/** Zod: a normalised, well-formed handle (reservation is checked by the route, which answers HANDLE_TAKEN). */
export const Handle = z
  .string()
  .max(64)
  .transform(normalizeHandle)
  .pipe(z.string().regex(HANDLE_RE, 'Use 3–30 characters: a–z, 0–9, _ and .'));

export const ProfilePatch = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX),
    handle: Handle,
    /** Empty clears the bio. */
    bio: z
      .string()
      .trim()
      .max(BIO_MAX)
      .transform((v) => (v === '' ? null : v))
      .nullable(),
    avatarAssetId: z.string().regex(/^ast_[0-9A-HJKMNP-TV-Z]{26}$/).nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type ProfilePatch = z.infer<typeof ProfilePatch>;

/** D-005: only safe-rated media may appear on public surfaces (profiles, avatars). */
export function isPublicRating(rating: string | null | undefined, mature: boolean | number | null | undefined): boolean {
  return rating === 'safe' && !mature;
}
