import type { CreditPoint } from '../../../lib/models';
import type { PickerKind } from '../types';

/**
 * Model options for the tool pickers, keyed by real Hyperouter ids
 * (packages/core/src/models/capabilities.ts, D-002). Display names follow the
 * approved screens; the synced catalog replaces this list.
 */
export interface ToolModel {
  id: string;
  name: string;
  mark: string;
  tone: string;
  tags: string[];
  /** Credits per `unit`. */
  credits: number;
  unit: 'per5s' | 'per10s' | 'perImage' | 'perMinute';
  eta: string;
  badge?: 'popular' | 'new' | 'budget' | 'comingSoon';
  disabled?: boolean;
  /** Catalog price points (absent in the mock list). */
  points?: CreditPoint[];
  /** Catalog default model, used for Auto quotes. */
  isDefault?: boolean;
}

export const toolModels: Record<PickerKind, ToolModel[]> = {
  video: [
    { id: 'bytedance/seedance-2.5', name: 'Seedance 2.5', mark: 'SD', tone: '#202330', tags: ['Omni reference', 'First & last frame', 'Max 30s', 'Audio'], credits: 8, unit: 'per5s', eta: '~2 min', badge: 'popular' },
    { id: 'minimax/minimax-h3', name: 'MiniMax H3', mark: 'H3', tone: '#26232A', tags: ['2K', 'Video + audio', '9 images + 3 videos + 3 audio refs', 'Max 15s'], credits: 6, unit: 'per5s', eta: '~2 min' },
    { id: 'alibaba/wan3.0', name: 'Wan 3.0', mark: 'W3', tone: '#28251F', tags: ['Docs / web pages to video', 'Extend video', 'Max 30s', '1080p'], credits: 7, unit: 'per5s', eta: '~3 min', badge: 'new' },
    // "Wan 2.2" (cheap/fast) is served by the Seedance 2.0 Mini substitute (D-002).
    { id: 'bytedance/seedance-2.0-mini', name: 'Wan 2.2', mark: 'W2', tone: '#1F2628', tags: ['Text to video', 'Image to video', '720p', 'Max 5s'], credits: 2, unit: 'per5s', eta: '~40s', badge: 'budget' },
  ],
  image: [
    // "Seedream 5.0 Pro" is not listed yet; Seedream 5.5 / 5.0 Lite serve it (D-002).
    { id: 'bytedance/seedream-5.5', name: 'Seedream 5.0 Pro', mark: 'SR', tone: '#202330', tags: ['Native 2K', '4K upscale', 'Multilingual text', 'Multi-image reference'], credits: 3, unit: 'perImage', eta: '~20s', badge: 'popular' },
    { id: 'bytedance/seedream-5.0-lite', name: 'Seedream 5.0 Lite', mark: 'SL', tone: '#1F2628', tags: ['Text to image', 'Reference edits', 'Web search'], credits: 1, unit: 'perImage', eta: '~8s' },
    { id: 'qwen/qwen-image-2.0', name: 'Wan 2.7 Image', mark: 'W', tone: '#28251F', tags: ['Accurate color', 'Personal styles'], credits: 2, unit: 'perImage', eta: '~15s' },
  ],
  avatar: [
    { id: 'minimax/minimax-h3', name: 'MiniMax H3', mark: 'H3', tone: '#202330', tags: ['Video + audio', 'Multilingual dialogue', 'Natural lip-sync', 'Max 15s'], credits: 12, unit: 'per10s', eta: '~2 min', badge: 'popular' },
    // Lip-sync candidate: photo + audio_url (D-002).
    { id: 'lumina/wan2.7-i2v-spicy', name: 'Wan 2.2 S2V', mark: 'S2V', tone: '#1F2628', tags: ['Photo + audio driven', 'Supports cloned voices', 'Max 60s'], credits: 10, unit: 'per10s', eta: '~3 min' },
    { id: 'live-avatar', name: 'Live avatar', mark: 'R', tone: '#26232A', tags: ['Chat', 'Livestream'], credits: 0, unit: 'perMinute', eta: 'Instant', badge: 'comingSoon', disabled: true },
  ],
};
