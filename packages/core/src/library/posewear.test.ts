import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/posewear-sample.json';
import { LIBRARY_CATEGORIES, getLibraryCategory } from './categories';
import { poseDepthR2Key, toLibraryD1Rows } from './d1';
import {
  angleNameFromEnglish,
  buildPoseWearLibrary,
  imageExtension,
  isPoseWearMature,
  mapPoseWearItem,
  shortTitleFromPrompt,
  type PoseWearRawItem,
} from './posewear';
import { PublicLibraryItemSchema, type LibraryCategoryKey, type PublicLibraryItem } from './types';

const labels = fixture.labels as Record<string, string>;
const translate = (label: string) => labels[label];
const datasets = fixture.datasets as Partial<Record<LibraryCategoryKey, unknown>>;

function build() {
  return buildPoseWearLibrary(datasets, { translate });
}

function byId(items: PublicLibraryItem[], id: string): PublicLibraryItem {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`missing ${id}`);
  return item;
}

describe('category registry', () => {
  it('covers all twelve categories with D-004 licenses', () => {
    expect(LIBRARY_CATEGORIES).toHaveLength(12);
    const licenses = Object.fromEntries(LIBRARY_CATEGORIES.map((c) => [c.key, c.license]));
    expect(licenses).toEqual({
      pose: 'first-party',
      pose_depth: 'first-party',
      portrait: 'cc0',
      expression: 'mit',
      hairstyle: 'cc0',
      outfit: 'first-party',
      outfit_anime: 'first-party',
      outfit_historical: 'cc0',
      scene: 'cc0',
      lighting: 'cc0',
      prop: 'cc0',
      furniture: 'cc0',
    });
    expect(getLibraryCategory('outfit_anime').sourceTab).toBe('anime');
  });
});

describe('buildPoseWearLibrary', () => {
  it('maps every fixture record into a schema-valid item', () => {
    const { items, rejected } = build();
    for (const item of items) expect(PublicLibraryItemSchema.safeParse(item).success).toBe(true);
    // One anime record (school swimsuit, flagged adult) is excluded entirely.
    expect(rejected).toEqual([
      { category: 'outfit_anime', reason: 'excluded_minor_coded', sourceId: 'charadb-O013' },
    ]);
    expect(new Set(items.map((i) => i.category)).size).toBe(12);
  });

  it('maps a pose with angles, depth maps, counterpart and source URLs', () => {
    const pose = byId(build().items, 'pw_pose_full_single_P001');
    expect(pose).toMatchObject({
      sourceId: 'full_single_P001',
      category: 'pose',
      sub: 'sitting',
      subLabel: { en: 'Sitting' },
      title: { en: 'Sitting leaning back, one knee raised' },
      prompt: { en: 'sitting leaning back, one knee raised, full body, solo' },
      license: 'first-party',
      mature: false,
      counterpartId: 'pw_pose_depth_full_single_P001',
      sourceUrl: 'https://posewear.pages.dev/#pose/full_single_P001',
      sourceThumbUrl: 'https://pwimg.0vo.pro/p/t/full_single_P001_front.webp',
      sourceFullUrl: 'https://posewear.pages.dev/p/i/full_single_P001_front.webp',
      depthUrl: 'https://pwimg.0vo.pro/d/img/full_single_P001_front.png',
    });
    expect(pose.tags).toEqual(['sitting', 'full body', 'solo']);
    expect(pose.angles.map((a) => a.name)).toEqual(['front', 'high']);
    expect(pose.angles[0]!.r2Key).toBe('public/pose/pw_pose_full_single_P001/front.webp');
    // Depth angles are matched by view, not position: the trimmed depth fixture has no "high" view.
    expect(pose.angles[1]!.depthUrl).toBeUndefined();
  });

  it('keeps depth map extensions in R2 keys', () => {
    const depth = byId(build().items, 'pw_pose_depth_full_single_P001');
    expect(depth.angles[0]!.r2Key).toBe('public/pose_depth/pw_pose_depth_full_single_P001/front.png');
    expect(depth.counterpartId).toBe('pw_pose_full_single_P001');
  });

  it('marks a depth pose mature when only its pose counterpart is flagged', () => {
    const { items } = build();
    expect(byId(items, 'pw_pose_full_sexy_P001').mature).toBe(true);
    expect(byId(items, 'pw_pose_depth_full_sexy_P001').mature).toBe(true);
    expect(byId(items, 'pw_pose_pair60_P063').mature).toBe(true);
  });

  it('flags lingerie and explicit underwear outfits as mature', () => {
    const { items } = build();
    expect(byId(items, 'pw_outfit_SPR-0001').mature).toBe(false);
    expect(byId(items, 'pw_outfit_LNG-0105').mature).toBe(true);
    // Not flagged by the source, caught by the text rule ("white bra").
    expect(byId(items, 'pw_outfit_AUT-0162').mature).toBe(true);
  });

  it('labels CharaDB-hosted anime outfits as CC0 with CharaDB attribution', () => {
    const { items } = build();
    const charadb = byId(items, 'pw_outfit_anime_charadb-O001');
    expect(charadb.license).toBe('cc0');
    expect(charadb.attribution.name).toBe('CharaDB');
    expect(charadb.angles[0]!.r2Key).toBe('public/outfit_anime/pw_outfit_anime_charadb-O001/main.jpg');
    expect(byId(items, 'pw_outfit_anime_SPR-0001').license).toBe('first-party');
  });

  it('builds English titles and subs for the other categories', () => {
    const { items } = build();
    expect(byId(items, 'pw_portrait_f71f980dde3')).toMatchObject({ sub: 'front', title: { en: 'Short hair · Front' }, license: 'cc0' });
    expect(byId(items, 'pw_expression_angry-024')).toMatchObject({ sub: 'angry', title: { en: 'Glare' }, license: 'mit' });
    expect(byId(items, 'pw_hairstyle_H001').angles[0]!.name).toBe('brown_hair');
    expect(byId(items, 'pw_hairstyle_H037').angles.map((a) => a.name)).toEqual(['main']);
    expect(byId(items, 'pw_outfit_historical_C001')).toMatchObject({ sub: 'shang', tags: ['shang', 'male'] });
    expect(byId(items, 'pw_scene_E001').sub).toBe('indoor');
    expect(byId(items, 'pw_scene_E001').angles[0]!.name).toBe('high');
    expect(byId(items, 'pw_lighting_L001').sub).toBe('time-of-day');
    expect(byId(items, 'pw_prop_T001').title.en).toBe('Generic steel-string acoustic guitar with a full rounded dreadnought body');
    expect(byId(items, 'pw_furniture_F001').sub).toBe('seating');
  });

  it('omits sub when no translation exists', () => {
    const { items } = buildPoseWearLibrary({ scene: (datasets.scene as unknown[]).slice(0, 1) });
    expect(items[0]!.sub).toBeUndefined();
    expect(items[0]!.title.en.length).toBeGreaterThan(0);
  });
});

describe('mapPoseWearItem', () => {
  it('rejects records without images and invalid records', () => {
    expect(mapPoseWearItem('prop', { id: 'X1', en: 'a box' })).toMatchObject({ ok: false, reason: 'no_images' });
    expect(mapPoseWearItem('prop', { en: 'no id' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(mapPoseWearItem('prop', null)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('sanitizes ids and never emits unsafe characters into keys', () => {
    const r = mapPoseWearItem('prop', { id: 'a/b c', en: 'x', t: 't/x.webp', i: 'i/x.webp' });
    expect(r.ok && r.item.id).toBe('pw_prop_a_b_c');
    expect(r.ok && r.item.sourceUrl).toBe('https://posewear.pages.dev/#prop/a%2Fb%20c');
  });
});

describe('helpers', () => {
  it('names angles', () => {
    expect(angleNameFromEnglish('three-quarter view', 'x')).toBe('three_quarter');
    expect(angleNameFromEnglish('eye-level view', 'x')).toBe('eye_level');
    expect(angleNameFromEnglish('silver hair', 'x')).toBe('silver_hair');
    expect(angleNameFromEnglish(undefined, 'view_1')).toBe('view_1');
  });

  it('shortens prompts into titles', () => {
    expect(shortTitleFromPrompt('spring outfit, ivory frill knit denim mini skirt, coat')).toBe('Ivory frill knit denim mini skirt');
    expect(shortTitleFromPrompt('a Tang-dynasty robe: red silk')).toBe('Tang-dynasty robe');
  });

  it('detects extensions', () => {
    expect(imageExtension('https://x/y.png')).toBe('png');
    expect(imageExtension('https://x/y.jpeg?v=1')).toBe('jpg');
    expect(imageExtension('https://x/y')).toBe('webp');
  });

  it('does not treat sports bras as mature', () => {
    const raw = { id: 'x', en: 'yoga pants, sports bra' } as PoseWearRawItem;
    expect(isPoseWearMature(raw)).toBe(false);
  });
});

describe('toLibraryD1Rows', () => {
  it('builds deterministic rows with depth keys for poses', () => {
    const pose = byId(build().items, 'pw_pose_full_single_P001');
    const rows = toLibraryD1Rows(pose, { importedAt: 1, depthR2KeyFor: poseDepthR2Key });
    expect(rows.assets.map((a) => a.id)).toEqual([
      'ast_pw_pose_full_single_P001_front',
      'ast_pw_pose_full_single_P001_high',
    ]);
    expect(rows.assets[0]).toMatchObject({ kind: 'image', source: 'public', license: 'first-party', workspace_id: null });
    expect(rows.publicItem.asset_id).toBe('ast_pw_pose_full_single_P001_front');
    const angles = JSON.parse(rows.publicItem.angles) as Array<{ depthR2Key?: string }>;
    expect(angles[0]!.depthR2Key).toBe('public/pose_depth/pw_pose_depth_full_single_P001/front.png');
    expect(rows.search.tags).toContain('sitting');
  });
});
