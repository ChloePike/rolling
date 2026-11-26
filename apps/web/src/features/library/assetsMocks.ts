/** Data from Assets.dc.html, shaped like `GET /api/assets`, `/api/characters`, `/api/voices`. */
export type AssetType = 'image' | 'video' | 'audio' | 'text';

export interface AssetItem {
  id: string;
  name: string;
  type: AssetType;
  /** Size, duration or dimensions summary from the media probe. */
  meta: string;
  /** Thumbnail aspect ratio as CSS, e.g. `16/10`. */
  ar: string;
  /** Number of places that reference this asset. */
  refs: number;
  source: 'upload' | 'canvas';
  version: number;
  uploadedAt: string;
  usedIn: Array<{ label: string; to: string }>;
  favorite?: boolean;
  /** Project folder id, when the asset belongs to one. */
  folder?: string;
  /** Real mode: the project the asset was made in ("Add to canvas" goes back there). */
  projectId?: string | null;
  /** Real mode: signed thumbnail, and whether it is mature-rated (blurred until clicked, D-005). */
  thumbUrl?: string | null;
  mature?: boolean;
  /** D-005 content rating from the API (`Asset.rating`); blurred when suggestive or explicit. */
  rating?: 'safe' | 'suggestive' | 'explicit' | null;
}

export interface CharacterItem {
  id: string;
  name: string;
  meta: string;
  projects: number;
}

export type VoiceState = 'ready' | 'cloning' | 'tooShort';
export interface VoiceItem {
  id: string;
  name: string;
  meta: string;
  state: VoiceState;
  progress?: number;
}

export interface FolderItem {
  id: string;
  /** Built-in folders have a message id; project folders use the project title. */
  kind: 'all' | 'characters' | 'voices' | 'favorites' | 'project';
  title?: string;
  count: number;
}

const USED_IN = [
  { label: 'Ridgeline Sparkling · Product keyframe', to: '/p/prj_demo' },
  { label: 'Ridgeline Sparkling · Shot A', to: '/p/prj_demo' },
  { label: 'Two-person product demo · Lead', to: '/create/quick' },
];

const F: Array<[string, AssetType, string, string, number]> = [
  ['Product photo.png', 'image', '2048×2048 · 3.1 MB', '1/1', 3],
  ['Shot A · v2.mp4', 'video', '00:05 · 720p', '16/10', 2],
  ['Voiceover.wav', 'audio', '00:08 · 48kHz', '16/10', 1],
  ['riverside_rock.jpg', 'image', '3024×4032 · 4.8 MB', '3/4', 2],
  ['Cap pop · v1.mp4', 'video', '00:05 · 720p', '16/10', 0],
  ['Tagline.txt', 'text', '24 chars', '16/10', 1],
  ['Lead.png', 'image', '1024×1536', '3/4', 5],
  ['Music · Morning.mp3', 'audio', '00:30 · 320kbps', '16/10', 0],
  ['product_shoot_01.mov', 'video', '00:12 · 1080p', '16/10', 1],
  ['Keyframe v1.png', 'image', '1440×2560', '3/4', 0],
  ['Pack front.png', 'image', '2048×2048', '1/1', 2],
  ['Script v3.txt', 'text', '86 chars', '16/10', 1],
];

export const assetsMock: AssetItem[] = F.map(([name, type, meta, ar, refs], i) => ({
  id: `ast_${String(i + 1).padStart(3, '0')}`,
  name,
  type,
  meta,
  ar,
  refs,
  source: i === 1 ? 'canvas' : 'upload',
  version: (i % 3) + 1,
  uploadedAt: '2026-11-23T14:20:00',
  usedIn: USED_IN,
  favorite: i % 4 === 0,
  folder: i < 7 ? 'prj_ridgeline' : 'prj_desk',
}));

export const foldersMock: FolderItem[] = [
  { id: 'all', kind: 'all', count: 238 },
  { id: 'characters', kind: 'characters', count: 12 },
  { id: 'voices', kind: 'voices', count: 6 },
  { id: 'favorites', kind: 'favorites', count: 31 },
  { id: 'prj_ridgeline', kind: 'project', title: 'Ridgeline Sparkling', count: 46 },
  { id: 'prj_desk', kind: 'project', title: 'Desk organizer pitch', count: 18 },
];

export const charactersMock: CharacterItem[] = [
  { id: 'C-0417', name: 'Mia', meta: '28 y/o · Side-part bob · Photoreal', projects: 6 },
  { id: 'C-0388', name: 'Leo', meta: '31 y/o · Short crop · Photoreal', projects: 3 },
  { id: 'C-0352', name: 'Yuki', meta: '19 y/o · High ponytail · Anime', projects: 9 },
  { id: 'T-0021', name: 'Product advisor', meta: 'Built-in · Avatar', projects: 12 },
  { id: 'C-0290', name: 'Butler', meta: '45 y/o · Hanfu · Ink wash', projects: 2 },
];

export const voicesMock: VoiceItem[] = [
  { id: 'v1', name: 'Clear female', meta: 'Built-in · English · Narration', state: 'ready' },
  { id: 'v2', name: 'Steady male', meta: 'Built-in · English · Narration', state: 'ready' },
  { id: 'v3', name: 'My voice 01', meta: 'Cloned · English · 00:42 sample', state: 'cloning', progress: 0.64 },
  { id: 'v4', name: 'My voice · English', meta: 'Cloned · Spanish · 01:05 sample', state: 'ready' },
  { id: 'v5', name: 'Support agent Amy', meta: 'Cloned · Cantonese · 00:20 sample', state: 'tooShort' },
];

export const uploadMock = { name: 'product_shoot_03.mov', sizeMb: 186, progress: 0.72 };

export const storageMock = { usedGb: 7.6, totalGb: 20 };
