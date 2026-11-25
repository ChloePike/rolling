import { z } from 'zod';

/**
 * Normalized public library item (D-004). Pure data, safe on Workers.
 *
 * URLs in `angles[].thumbUrl` / `angles[].fullUrl` and `sourceThumbUrl` /
 * `sourceFullUrl` point at the source CDN. They are the dev fallback used
 * until R2 is populated; production reads `angles[].r2Key`.
 */

export const LIBRARY_LICENSES = ['first-party', 'cc0', 'mit'] as const;
export const LibraryLicenseSchema = z.enum(LIBRARY_LICENSES);
export type LibraryLicense = z.infer<typeof LibraryLicenseSchema>;

export const LIBRARY_CATEGORY_KEYS = [
  'pose',
  'pose_depth',
  'portrait',
  'expression',
  'hairstyle',
  'outfit',
  'outfit_anime',
  'outfit_historical',
  'scene',
  'lighting',
  'prop',
  'furniture',
] as const;
export const LibraryCategoryKeySchema = z.enum(LIBRARY_CATEGORY_KEYS);
export type LibraryCategoryKey = z.infer<typeof LibraryCategoryKeySchema>;

export const LIBRARY_GROUP_KEYS = ['pose', 'character', 'wardrobe', 'scene'] as const;
export const LibraryGroupKeySchema = z.enum(LIBRARY_GROUP_KEYS);
export type LibraryGroupKey = z.infer<typeof LibraryGroupKeySchema>;

export const LocalizedTextSchema = z.object({
  en: z.string().min(1),
  zh: z.string().min(1).optional(),
});
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

export const OptionalLocalizedTextSchema = z.object({
  en: z.string().min(1).optional(),
  zh: z.string().min(1).optional(),
});

/** Stable angle / variant key: lowercase snake case, e.g. `front`, `three_quarter`, `main`, `black_hair`. */
export const AngleNameSchema = z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/);

export const LibraryAngleSchema = z.object({
  name: AngleNameSchema,
  label: LocalizedTextSchema,
  /** Source CDN thumbnail (small webp/jpg). */
  thumbUrl: z.string().url(),
  /** Source CDN display image (the largest image the source serves publicly). */
  fullUrl: z.string().url(),
  /** Depth map for this angle, when the item has a depth counterpart. */
  depthUrl: z.string().url().optional(),
  /** R2 object key once copied: `public/<category>/<itemId>/<angle>.<ext>` (ext follows the source bytes). */
  r2Key: z.string().min(1),
});
export type LibraryAngle = z.infer<typeof LibraryAngleSchema>;

export const LibraryAttributionSchema = z.object({
  name: z.string().min(1),
  url: z.string().url().optional(),
  author: z.string().min(1).optional(),
});
export type LibraryAttribution = z.infer<typeof LibraryAttributionSchema>;

export const PublicLibraryItemSchema = z.object({
  /** Stable id: `pw_<category>_<sourceId>`. */
  id: z.string().regex(/^pw_[a-z_]+_[A-Za-z0-9_-]+$/),
  /** The id used by the source, unchanged. */
  sourceId: z.string().min(1),
  category: LibraryCategoryKeySchema,
  /** Sub-category key (lowercase slug), e.g. `sitting`, `summer`, `happy`. */
  sub: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  subLabel: LocalizedTextSchema.optional(),
  title: LocalizedTextSchema,
  prompt: OptionalLocalizedTextSchema,
  tags: z.array(z.string().min(1)),
  /** At least one entry. Single-image items have one angle named `main`. */
  angles: z.array(LibraryAngleSchema).min(1),
  /** Depth map of the cover angle (pose and pose_depth only). */
  depthUrl: z.string().url().optional(),
  /** Id of the paired item (pose <-> pose_depth share source ids). */
  counterpartId: z.string().optional(),
  license: LibraryLicenseSchema,
  attribution: LibraryAttributionSchema,
  /** Link back to the item on the source site. */
  sourceUrl: z.string().url(),
  /** Dev fallback: cover thumbnail on the source CDN. */
  sourceThumbUrl: z.string().url(),
  /** Dev fallback: cover display image on the source CDN. */
  sourceFullUrl: z.string().url(),
  /** D-005: mature items never appear on public surfaces. */
  mature: z.boolean().default(false),
});
export type PublicLibraryItem = z.infer<typeof PublicLibraryItemSchema>;
