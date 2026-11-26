/**
 * Mock data matching the design files (ModelPicker, ParamPopover, RunConfirm,
 * Paywall, ResultViewer). Replaced by the synced model catalog and quotes.
 */
import type { ImageParams, ModelKind, ModelOption, ResultAction, ResultVersion, RunPlanRow, VideoParams } from './types';

export const mockModels: Record<ModelKind, ModelOption[]> = {
  video: [
    { id: 'bytedance/seedance-2.5', name: 'Seedance 2.5', mark: 'SD', tone: 'var(--c-tone-indigo)', tags: ['Omni reference', 'First & last frame', 'Max 30s', 'Audio'], credits: 8, unit: 'per5s', eta: '~2 min', badge: 'popular' },
    { id: 'minimax/minimax-h3', name: 'MiniMax H3', mark: 'H3', tone: 'var(--c-tone-plum)', tags: ['2K', 'Video + audio', '9 images + 3 videos + 3 audio refs', 'Max 15s'], credits: 6, unit: 'per5s', eta: '~2 min' },
    { id: 'alibaba/wan3.0', name: 'Wan 3.0', mark: 'W3', tone: 'var(--c-tone-sand)', tags: ['Docs / web pages to video', 'Extend video', 'Max 30s', '1080p'], credits: 7, unit: 'per5s', eta: '~3 min', badge: 'new' },
    { id: 'bytedance/seedance-2.0-mini', name: 'Wan 2.2', mark: 'W2', tone: 'var(--c-tone-teal)', tags: ['Text to video', 'Image to video', '720p', 'Max 5s'], credits: 2, unit: 'per5s', eta: '~40s', badge: 'budget' },
  ],
  image: [
    { id: 'bytedance/seedream-5.0-pro', name: 'Seedream 5.0 Pro', mark: 'SR', tone: 'var(--c-tone-indigo)', tags: ['Native 2K', '4K upscale', 'Multilingual text', 'Multi-image reference'], credits: 3, unit: 'perImage', eta: '~20s', badge: 'popular' },
    { id: 'bytedance/seedream-5.0-lite', name: 'Seedream 5.0 Lite', mark: 'SL', tone: 'var(--c-tone-teal)', tags: ['Text to image', 'Reference edits', 'Web search'], credits: 1, unit: 'perImage', eta: '~8s' },
    { id: 'qwen/qwen-image-2.0', name: 'Wan 2.7 Image', mark: 'W', tone: 'var(--c-tone-sand)', tags: ['Accurate color', 'Personal styles'], credits: 2, unit: 'perImage', eta: '~15s' },
  ],
  avatar: [
    { id: 'minimax/minimax-h3', name: 'MiniMax H3', mark: 'H3', tone: 'var(--c-tone-indigo)', tags: ['Video + audio', 'Multilingual dialogue', 'Natural lip-sync', 'Max 15s'], credits: 12, unit: 'per10s', eta: '~2 min', badge: 'popular' },
    { id: 'lumina/wan2.7-i2v-spicy', name: 'Wan 2.2 S2V', mark: 'S2V', tone: 'var(--c-tone-teal)', tags: ['Photo + audio driven', 'Supports cloned voices', 'Max 60s'], credits: 10, unit: 'per10s', eta: '~3 min' },
    { id: 'live-avatar', name: 'Live avatar', mark: 'R', tone: 'var(--c-tone-plum)', tags: ['Chat', 'Livestream'], credits: 0, unit: 'perMinute', eta: 'Instant', badge: 'comingSoon', disabled: true, disabledReason: 'Coming soon' },
  ],
};


/** Mock estimator used by ParamPopover when no quote is passed (same formula as the design). */
export function estimateVideoCost(p: VideoParams): number {
  const base = { '480p': 4, '720p': 8, '1080p': 14 }[p.resolution] * (parseInt(p.duration, 10) / 5) * (p.audio ? 1.25 : 1);
  return Math.round(base * Number(p.count));
}
export function estimateImageCost(p: ImageParams): number {
  const base = { '1K': 1, '2K': 2, '4K': 4 }[p.size] * (p.quality === 'high' ? 2 : 1);
  return Math.round(base * Number(p.count));
}

/** Run-all plan from RunConfirm.dc.html (variant graph). */
export const mockGraphPlan: RunPlanRow[] = [
  { id: 'node_script', name: 'Script · v2', meta: 'Text node', kind: 'text', state: 'free', cost: 0, tone: 'var(--c-tone-neutral)' },
  { id: 'node_photo', name: 'Product photo.png', meta: 'Asset node', kind: 'image', state: 'free', cost: 0, tone: 'var(--c-tone-teal)' },
  { id: 'node_key', name: 'Product keyframe', meta: 'Seedream 5.0 Pro · 9:16 · 2K × 2 · v2 is current', kind: 'image', state: 'reuse', cost: 2, tone: 'var(--c-tone-plum)' },
  { id: 'node_a', name: 'Shot A · Hero shot', meta: 'Seedance 2.5 · First frame · 720p 5s · Input changed', kind: 'video', state: 'run', cost: 8 },
  { id: 'node_b', name: 'Shot B · Cap pop', meta: 'Seedance 2.5 · First frame · 720p 5s', kind: 'video', state: 'run', cost: 8 },
  { id: 'node_vo', name: 'Voiceover', meta: 'Text to speech · Clear female · 8s', kind: 'audio', state: 'run', cost: 2, tone: 'var(--c-tone-sand)' },
  { id: 'node_c', name: 'Shot C · Logo', meta: 'Waiting for the “Tagline” node', kind: 'video', state: 'blocked', cost: 8 },
];
export const mockGraphBlockedNote =
  '“Shot C” is missing an input, so it won’t run and won’t be charged. Add the “Tagline” node, then run it on its own.';

/** Single run from RunConfirm.dc.html (variant single, QuickCreate). */
export const mockSingleRun: RunPlanRow[] = [
  { id: 'run_this', name: 'This run', meta: 'Auto → Seedance 2.5 · 9:16 · 720p · 15s', kind: 'video', state: 'run', cost: 10 },
];

export const mockVersions: ResultVersion[] = [
  { id: 'v1', label: 'v1', tone: 'var(--c-tone-indigo)' },
  { id: 'v2', label: 'v2', tone: 'var(--c-tone-teal)' },
  { id: 'v3', label: 'v3', tone: 'var(--c-tone-plum)' },
  { id: 'v4', label: 'v4', tone: 'var(--c-tone-sand)' },
];

export const mockResultActions: ResultAction[] = [
  { id: 'edit' },
  { id: 'regenerate', cost: 10 },
  { id: 'extend', cost: 6 },
  { id: 'hd', cost: 8 },
  { id: 'sendToCanvas' },
  { id: 'download' },
];
