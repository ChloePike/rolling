/**
 * Product overlay for the model catalog (D-002). Product-only fields keyed by
 * gateway model id: display name, tags, default per kind, hidden, Auto
 * eligibility, D-005 flags and PRD substitutes. Technical and price fields
 * always come from the listing (`./catalog.ts`); nothing here can change them.
 *
 * Models that appear in the listing without an entry here are offered with
 * their listing name, are not used by Auto, and get the D-005 flags derived by
 * `mergeModel` (so a new swap or spicy model is safe by default).
 */
import type { CatalogModel, ListingModel, MatureRouting } from './types';

export interface OverlayEntry {
  displayName?: string;
  tags?: string[];
  /** Default model for its kind. Keep exactly one per kind. */
  default?: boolean;
  hidden?: boolean;
  /** Considered by Auto selection. Never effective for identity-driven or hidden models. */
  auto?: boolean;
  /**
   * Mature family override (D-005). Derived otherwise: the `lumina/*-spicy`
   * family and models whose listing accepts `moderation`. Identity-driven
   * models never become `mature: true`; face/head swap never takes mature runs.
   */
  mature?: boolean;
  /** Adult-oriented: listed only to callers allowed to see mature content. Derived from the spicy family otherwise. */
  matureOnly?: boolean;
  /** Can only add the flag: derived identity models (swaps, lip sync, motion transfer) stay flagged. */
  requiresIdentitySafety?: boolean;
  substituteFor?: string;
  notes?: string;
}

export type ModelOverlay = Readonly<Record<string, OverlayEntry>>;

/** `lumina/z-image-spicy`, `lumina/z-image-spicy-pro`, `lumina/wan2.7-i2v-spicy`, ... */
export const SPICY_FAMILY = /^lumina\/.+-spicy(?:-[^/]+)?$/;

const IDENTITY_NOTE = 'Identity-driven: needs the checks in core/safety; mature runs only with platform assets (D-005).';
const SWAP_NOTE = 'Face/head swap: never used for mature runs (D-005).';

export const MODEL_OVERLAY: ModelOverlay = {
  // ---------------------------------------------------------------- video
  'bytedance/seedance-2.5': { displayName: 'Seedance 2.5', tags: ['launch', 'audio'], default: true, auto: true },
  'minimax/minimax-h3': { displayName: 'MiniMax H3', tags: ['launch'], auto: true },
  'alibaba/wan3.0': { displayName: 'Wan 3.0', tags: ['launch', 'audio', 'long'], auto: true },
  'bytedance/seedance-2.0-mini': {
    displayName: 'Seedance 2.0 Mini',
    tags: ['fast', 'cheap'],
    auto: true,
    substituteFor: 'wan-2.2',
    notes: 'Cheapest launch-grade video; stands in for Wan 2.2 (cheap and fast). Confirm with product.',
  },
  'bytedance/seedance-2.0-fast': { displayName: 'Seedance 2.0 Fast', tags: ['fast'], auto: true, substituteFor: 'wan-2.2' },
  'bytedance/seedance-2.5-flash': { displayName: 'Seedance 2.5 Flash', tags: ['fast'] },
  'alibaba/wan3.0-turbo': { displayName: 'Wan 3.0 Turbo', tags: ['fast'] },
  'lumina/wan2.7-i2v-spicy': {
    displayName: 'Wan 2.7 I2V (lip sync)',
    tags: ['avatar', 'lip-sync'],
    requiresIdentitySafety: true,
    substituteFor: 'wan-2.2-s2v',
    notes: `Photo + audio_url lip sync; needs a voice track from elsewhere (no TTS). ${IDENTITY_NOTE}`,
  },
  'lumina/wan2.2-i2v-spicy': {
    displayName: 'Wan 2.2 I2V Spicy',
    requiresIdentitySafety: true,
    notes: `Photo-driven image-to-video. ${IDENTITY_NOTE}`,
  },
  'lumina/wan-animate': {
    displayName: 'Wan Animate',
    tags: ['motion-transfer'],
    requiresIdentitySafety: true,
    notes: `Motion transfer: a picture's character follows a driving clip. ${IDENTITY_NOTE}`,
  },
  'lumina/video-face-swap': { displayName: 'Video Face Swap', requiresIdentitySafety: true, notes: SWAP_NOTE },
  'lumina/video-head-swap': { displayName: 'Video Head Swap', requiresIdentitySafety: true, notes: SWAP_NOTE },
  // ---------------------------------------------------------------- image
  'bytedance/seedream-5.0-lite': {
    displayName: 'Seedream 5.0 Lite',
    tags: ['launch'],
    default: true,
    auto: true,
    notes: 'Default image model until Seedream 5.0 Pro is listed (D-002).',
  },
  'bytedance/seedream-5.5': {
    displayName: 'Seedream 5.5',
    auto: true,
    substituteFor: 'seedream-5.0-pro',
    notes: 'Seedream 5.0 Pro is not listed; 5.5 is the likely Pro stand-in. Confirm with product.',
  },
  'bytedance/seedream-5.0-flash': { displayName: 'Seedream 5.0 Flash', tags: ['fast', 'cheap'], auto: true, substituteFor: 'seedream-5.0-lite' },
  'qwen/qwen-image-2.0': { displayName: 'Qwen Image 2.0', auto: true, substituteFor: 'wan-2.7-image' },
  'lumina/z-image-spicy': { displayName: 'Z-Image Spicy' },
  'lumina/z-image-spicy-pro': { displayName: 'Z-Image Spicy Pro' },
  'lumina/qwen-image-edit-spicy': { displayName: 'Qwen Image Edit Spicy' },
  'lumina/face-swap': { displayName: 'Face Swap', requiresIdentitySafety: true, notes: SWAP_NOTE },
  'lumina/head-swap': { displayName: 'Head Swap', requiresIdentitySafety: true, notes: SWAP_NOTE },
  // ---------------------------------------------------------------- chat
  'deepseek/deepseek-v4.1-flash': { displayName: 'DeepSeek V4.1 Flash', default: true, notes: 'Agent LLM (D-002).' },
};

export function isSwapModel(m: Pick<ListingModel, 'operations'>): boolean {
  return m.operations.includes('face_swap') || m.operations.includes('head_swap');
}

/** Identity-driven by shape: swaps, lip sync, motion transfer, or a spicy model that needs a photo. */
function derivedIdentity(m: ListingModel): boolean {
  return (
    isSwapModel(m) ||
    m.operations.includes('lip_sync') ||
    m.operations.includes('motion_transfer') ||
    (m.kind === 'video' && m.inputImageRequired && SPICY_FAMILY.test(m.id))
  );
}

/** Merges product fields over a listing model. Listing fields are never overwritten. */
export function mergeModel(listing: ListingModel, overlay: OverlayEntry = {}): CatalogModel {
  const spicy = SPICY_FAMILY.test(listing.id);
  const swap = isSwapModel(listing);
  const requiresIdentitySafety = derivedIdentity(listing) || overlay.requiresIdentitySafety === true;
  const matureFamily = overlay.mature ?? (spicy || listing.supportsModeration);
  const matureRouting: MatureRouting =
    swap || !matureFamily ? 'never' : requiresIdentitySafety ? 'platform_assets_only' : 'allowed';
  const hidden = overlay.hidden ?? false;
  return {
    ...listing,
    provider: 'hyperouter',
    providerModelId: listing.id,
    displayName: overlay.displayName ?? listing.name,
    tags: overlay.tags ?? [],
    default: overlay.default ?? false,
    hidden,
    auto: (overlay.auto ?? false) && !requiresIdentitySafety && !hidden && listing.kind !== 'chat',
    mature: matureRouting === 'allowed',
    matureOnly: overlay.matureOnly ?? spicy,
    matureRouting,
    requiresIdentitySafety,
    ...(overlay.substituteFor !== undefined && { substituteFor: overlay.substituteFor }),
    ...(overlay.notes !== undefined && { notes: overlay.notes }),
  };
}
