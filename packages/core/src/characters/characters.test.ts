import { describe, expect, it } from 'vitest';
import { fixtureCatalog, fixtureModel } from '../models/__fixtures__/catalog';
import { validateRequest } from '../models/capabilities';
import { buildGenerateRequest, type ResolvedInput } from '../generation/request';
import { PromptSpecSchema } from '../generation/spec';
import { planPromptSpec, type SpecAsset } from '../generation/specPlan';
import type { PlanContext, PlanItem } from '../generation/types';
import { referenceSentences } from '../prompting/compose';
import { bindCharacterReferences, effectiveViews, referenceImageModels, type CastSheet } from './binding';
import { bestMatch, driftVerdict, headCropsOf, summarizeDrift, DRIFT_THRESHOLDS } from './consistency';
import { descriptorLook, descriptorToShotCharacter, matchOutfit, sameDescriptor, CharacterDescriptorSchema } from './descriptor';
import { sheetItems, sheetReferenceLabel, sheetViews, SHEET_VIEWS, type SheetAssets } from './sheet';
import { trainingAvailability } from './training';
import { companionView, expressionCue, pickSheetView, rankSheetViews } from './views';

const ALL = [...SHEET_VIEWS];
const maya = CharacterDescriptorSchema.parse({ face: 'woman in her late twenties, oval face, dark brown eyes, small mole under the left eye', hair: 'black side-part bob', build: 'slim, 168 cm', outfit: 'mustard trench coat over a white tee', style: 'photoreal' });

const sheetOf = (prefix: string, views: readonly string[] = ALL): SheetAssets => Object.fromEntries(views.map((v) => [v, `ast_${prefix}_${v}`]));
const cast = (id: string, name: string, views?: readonly string[], extra: Partial<CastSheet> = {}): CastSheet => ({ characterId: id, name, kind: 'person', views: sheetOf(id, views), ...extra });

describe('descriptor', () => {
  it('becomes the same shot character every time; an outfit variant replaces only the outfit', () => {
    const a = descriptorToShotCharacter('Maya', maya);
    expect(a).toEqual(descriptorToShotCharacter('Maya', maya));
    expect(a.look).toBe(descriptorLook(maya));
    expect(a.wardrobe).toBe('mustard trench coat over a white tee');
    const office = descriptorToShotCharacter('Maya', maya, { outfit: 'navy suit, white shirt' });
    expect(office.look).toBe(a.look);
    expect(office.wardrobe).toBe('navy suit, white shirt');
    expect(sameDescriptor(maya, { ...maya, face: `${maya.face}.` })).toBe(true);
    expect(sameDescriptor(maya, { ...maya, hair: 'long red curls' })).toBe(false);
  });

  it('matches outfit variants by name', () => {
    const variants = [{ id: 'o1', name: 'Office' }, { id: 'o2', name: 'Gym' }];
    expect(matchOutfit(variants, 'office')?.id).toBe('o1');
    expect(matchOutfit(variants, 'her gym outfit')?.id).toBe('o2');
    expect(matchOutfit(variants, 'a red dress')).toBeNull();
  });
});

describe('sheet', () => {
  it('a person gets four angles and two to three expressions, all drawn from the full body', () => {
    expect(sheetViews('person')).toEqual(['full_body', 'front', 'three_quarter', 'profile', 'expression_smile', 'expression_serious']);
    expect(sheetViews('person', ['smile', 'sad', 'angry', 'surprised'])).toHaveLength(7);
    expect(sheetViews('object', ['smile'])).toEqual(['full_body', 'front', 'three_quarter', 'profile']);
    const items = sheetItems({ name: 'Maya', descriptor: maya });
    expect(items[0]).toMatchObject({ view: 'full_body', from: null, ratio: '3:4' });
    expect(items[0]!.prompt).toContain('black side-part bob');
    expect(items.slice(1).every((i) => i.from === 'full_body' && i.prompt.startsWith('Image 1 is the character Maya'))).toBe(true);
    expect(items.find((i) => i.view === 'profile')!.prompt).toContain('profile');
    expect(items.find((i) => i.view === 'expression_smile')!.prompt).toContain('smile');
  });

  it('an outfit variant redraws only the body views from the saved full body', () => {
    const items = sheetItems({ name: 'Maya', descriptor: maya, mode: 'outfit', outfit: { name: 'Office', outfit: 'navy suit' }, base: true });
    expect(items.map((i) => i.view)).toEqual(['full_body', 'three_quarter']);
    expect(items[0]!.prompt).toMatch(/keep the face, hair and build identical/);
    expect(items[0]!.prompt).toContain('navy suit');
    expect(items[0]!.title).toBe('Maya · Office · Full body');
  });

  it('labels bind each sheet picture by character and view in composed prompts', () => {
    const label = sheetReferenceLabel('person', 'Maya', 'three_quarter');
    expect(label).toBe('Character: Maya · 3/4 view');
    expect(referenceSentences([label, sheetReferenceLabel('object', 'Tea bottle', 'front')])).toBe(
      'Image 1 is the character Maya (3/4 view): keep the face, hair and outfit identical. Image 2 is Tea bottle (front): keep its shape, materials, colors and markings identical.',
    );
    // Older labels without a view read as before.
    expect(referenceSentences(['Character: Leo'])).toBe('Image 1 is the character Leo: keep the face, hair and outfit identical.');
  });
});

describe('view selection', () => {
  it('picks the view closest to the shot framing and angle', () => {
    expect(pickSheetView({ camera: { size: 'close_up' } }, ALL)).toBe('front');
    expect(pickSheetView({ camera: { size: 'extreme_close_up', angle: 'over_the_shoulder' } }, ALL)).toBe('profile');
    expect(pickSheetView({ camera: { size: 'medium' } }, ALL)).toBe('three_quarter');
    expect(pickSheetView({ camera: { size: 'wide' } }, ALL)).toBe('full_body');
    expect(pickSheetView({ camera: { angle: 'aerial' } }, ALL)).toBe('full_body');
    expect(pickSheetView({ camera: { move: 'orbit' } }, ALL)).toBe('three_quarter');
    expect(pickSheetView({}, ALL)).toBe('full_body');
  });

  it('a close-up takes the expression its action or line asks for', () => {
    expect(expressionCue({ action: 'She laughs at the message' })).toBe('expression_smile');
    expect(expressionCue({ action: 'He turns', dialogue: [{ tone: 'furious', line: 'Get out' }] })).toBe('expression_angry');
    expect(pickSheetView({ camera: { size: 'close_up' }, action: 'Tears run down her face as she cries' }, [...ALL, 'expression_sad'])).toBe('expression_sad');
    // No such expression on the sheet: the front view.
    expect(pickSheetView({ camera: { size: 'close_up' }, action: 'She cries' }, ['full_body', 'front'])).toBe('front');
  });

  it('falls back to what the sheet has and ranks every available view once', () => {
    expect(pickSheetView({ camera: { size: 'close_up' } }, ['full_body'])).toBe('full_body');
    expect(pickSheetView({ camera: { size: 'close_up' } }, [])).toBeNull();
    const ranked = rankSheetViews({ camera: { size: 'wide' } }, ALL);
    expect(new Set(ranked).size).toBe(ALL.length);
    expect(companionView('full_body', ranked)).toBe('front');
    expect(companionView('front', rankSheetViews({ camera: { size: 'close_up' } }, ALL))).toBe('three_quarter');
  });
});

describe('reference binding', () => {
  const seedance = fixtureModel('bytedance/seedance-2.0-mini');
  const lite = fixtureModel('x-ai/grok-imagine-video-1.5-lite');
  const spicy = fixtureModel('lumina/wan2.2-i2v-spicy');
  const seedream = fixtureModel('bytedance/seedream-5.0-lite');
  const zImage = fixtureModel('lumina/z-image-spicy');

  it('passes the best view straight to a video model that takes reference images, within its count', () => {
    expect(seedance.operations).toContain('refs');
    const plan = bindCharacterReferences({ model: seedance, shot: { camera: { size: 'close_up' } }, cast: [cast('chr_a', 'Maya'), cast('chr_b', 'Leo')] });
    expect(plan.strategy).toBe('refs');
    expect(plan.videoMode).toBe('refs');
    // One view per character first, then companions while the model has room (9 slots).
    expect(plan.refs.slice(0, 2).map((r) => [r.name, r.view])).toEqual([
      ['Maya', 'front'],
      ['Leo', 'front'],
    ]);
    expect(plan.refs.slice(2).map((r) => r.view)).toEqual(['three_quarter', 'three_quarter']);
    expect(plan.refs[0]!.label).toBe('Character: Maya · front');
    // A cap below the model's (a graph port, `@` pictures already wired): primaries only, in cast order.
    const tight = bindCharacterReferences({ model: seedance, shot: {}, cast: [cast('chr_a', 'Maya'), cast('chr_b', 'Leo')], maxSlots: 3, otherRefs: 1 });
    expect(tight.refs.map((r) => r.view)).toEqual(['full_body', 'full_body']);
    expect(tight.unbound).toEqual([]);
  });

  it('chains a keyframe through an image model that takes references when the video model takes none', () => {
    // Photo-driven image-to-video (the spicy family): no reference images, a first frame.
    expect(spicy.maxReferenceImages).toBe(0);
    expect(spicy.operations).toContain('i2v');
    const keyframes = referenceImageModels([zImage, seedream], () => 1);
    expect(keyframes.map((m) => m.id)).toEqual([seedream.id]);
    const plan = bindCharacterReferences({ model: spicy, shot: { camera: { size: 'medium' } }, cast: [cast('chr_a', 'Maya')], keyframeModels: keyframes });
    expect(plan).toMatchObject({ strategy: 'chain', keyframeModel: seedream.id, videoMode: 'i2v' });
    expect(plan.refs[0]).toMatchObject({ view: 'three_quarter', assetId: 'ast_chr_a_three_quarter' });
    // No image model takes references: the descriptor only.
    expect(bindCharacterReferences({ model: spicy, shot: {}, cast: [cast('chr_a', 'Maya')], keyframeModels: [zImage] })).toMatchObject({ strategy: 'text', refs: [], unbound: ['Maya'] });
    // Text-only video (no references, no first frame): the descriptor only.
    expect(lite.operations).toEqual(['t2v']);
    expect(bindCharacterReferences({ model: lite, shot: {}, cast: [cast('chr_a', 'Maya')], keyframeModels: keyframes })).toMatchObject({ strategy: 'text', videoMode: 't2v' });
  });

  it('chains when the reference slots cannot hold the cast but a keyframe can', () => {
    const many = ['A', 'B', 'C'].map((n) => cast(`chr_${n}`, n));
    const plan = bindCharacterReferences({ model: seedance, shot: {}, cast: many, maxSlots: 2, keyframeModels: [seedream] });
    expect(plan.strategy).toBe('chain');
    expect(new Set(plan.refs.map((r) => r.characterId)).size).toBe(3);
  });

  it('feeds an image edit model its input limit and leaves characters without a sheet to the descriptor', () => {
    const plan = bindCharacterReferences({ model: seedream, shot: { camera: { size: 'wide' } }, cast: [cast('chr_a', 'Maya'), { characterId: 'chr_x', name: 'Ola', kind: 'person', views: {} }] });
    expect(plan.strategy).toBe('edit');
    expect(plan.refs[0]).toMatchObject({ name: 'Maya', view: 'full_body' });
    expect(plan.unbound).toEqual(['Ola']);
    expect(plan.refs.length).toBeLessThanOrEqual(seedream.maxInputImages);
  });

  it('an outfit variant replaces the body views only', () => {
    const c = cast('chr_a', 'Maya', ALL, { outfitViews: { full_body: 'ast_office_full', three_quarter: 'ast_office_tq', front: 'ignored' }, outfitName: 'Office' });
    expect(effectiveViews(c)).toMatchObject({ full_body: 'ast_office_full', three_quarter: 'ast_office_tq', front: 'ast_chr_a_front' });
    const plan = bindCharacterReferences({ model: seedance, shot: { camera: { size: 'full' } }, cast: [c], maxSlots: 1 });
    expect(plan.refs).toEqual([{ characterId: 'chr_a', name: 'Maya', view: 'full_body', assetId: 'ast_office_full', label: 'Character: Maya (Office) · full body' }]);
  });

  it('the bound pictures reach the provider request as reference images with their labels', async () => {
    const plan = bindCharacterReferences({ model: seedance, shot: { camera: { size: 'close_up' } }, cast: [cast('chr_a', 'Maya')], maxSlots: 2 });
    const origins = new Map<string, SpecAsset>(plan.refs.map((r) => [r.assetId, { origin: 'character', media: 'image' }]));
    const run = await planPromptSpec({
      spec: PromptSpecSchema.parse({ kind: 'video', model: seedance.id, prompt: 'Maya looks up from her phone', seconds: 5, resolution: '480p', refsMode: true, inputs: { referenceAssetIds: plan.refs.map((r) => r.assetId) } }),
      catalog: fixtureCatalog,
      ctx: { plan: 'plus', matureAllowed: false },
      assetOrigins: origins,
    });
    const item = run.items[0]!;
    expect(item.action).toBe('run');
    expect(item.spec!.mode).toBe('refs');
    const resolved: ResolvedInput[] = item.spec!.inputs.map((input, i) => ({ input, url: `https://media.test/${i}.png`, origin: 'character' }));
    const req = buildGenerateRequest(item.spec!, seedance, resolved);
    expect(req.referenceImageUrls).toEqual(['https://media.test/0.png', 'https://media.test/1.png']);
    expect(validateRequest(seedance, req)).toEqual([]);
  });
});

describe('sheet runs', () => {
  const CTX: PlanContext = { plan: 'plus', matureAllowed: false };
  const assets = new Map<string, SpecAsset>([
    ['ast_photo', { origin: 'upload', media: 'image' }],
    ['ast_body', { origin: 'character', media: 'image' }],
  ]);
  const plan = (raw: unknown, onlyRefs?: string[], priorAssets?: Record<string, string>) =>
    planPromptSpec({ spec: PromptSpecSchema.parse(raw), catalog: fixtureCatalog, ctx: CTX, assetOrigins: assets, ...(onlyRefs && { onlyRefs }), ...(priorAssets && { priorAssets }) });

  it('plans the whole turnaround in one run: the full body, then each view as an edit of it', async () => {
    const run = await plan({ kind: 'character', name: 'Maya', model: 'bytedance/seedream-5.0-lite', resolution: '2K', sheet: { descriptor: maya, expressions: ['smile', 'serious', 'surprised'] }, inputs: { referenceAssetIds: ['ast_photo'] } });
    expect(run.items.map((i) => i.ref)).toEqual(['full_body', 'front', 'three_quarter', 'profile', 'expression_smile', 'expression_serious', 'expression_surprised']);
    expect(run.items.every((i: PlanItem) => i.action === 'run')).toBe(true);
    const [body, ...rest] = run.items;
    expect(body!.spec!.inputs).toEqual([{ role: 'edit', media: 'image', from: { assetId: 'ast_photo', origin: 'upload' } }]);
    expect(body!.spec!.ratio).toBe('3:4');
    for (const i of rest) {
      expect(i.dependsOn).toEqual(['full_body']);
      expect(i.spec!.inputs).toEqual([{ role: 'edit', media: 'image', from: { item: 'full_body' } }]);
      expect(i.spec!.mode).toBe('edit');
    }
  });

  it('needs a description or a picture; an outfit variant needs its base picture', async () => {
    const empty = await plan({ kind: 'character', name: 'X', sheet: { descriptor: { face: '' } } });
    expect(empty.items[0]).toMatchObject({ action: 'blocked', code: 'empty_prompt' });
    const noBase = await plan({ kind: 'character', name: 'Maya', sheet: { mode: 'outfit', descriptor: maya, characterId: 'chr_1', outfit: { name: 'Office', outfit: 'navy suit' } } });
    expect(noBase.items[0]).toMatchObject({ action: 'blocked', code: 'missing_input' });
    const outfit = await plan({ kind: 'character', name: 'Maya', model: 'bytedance/seedream-5.0-lite', resolution: '2K', sheet: { mode: 'outfit', descriptor: maya, characterId: 'chr_1', outfit: { name: 'Office', outfit: 'navy suit' }, baseAssetId: 'ast_body' } });
    expect(outfit.items.map((i) => [i.ref, i.action])).toEqual([
      ['full_body', 'run'],
      ['three_quarter', 'run'],
    ]);
    expect(outfit.items[0]!.spec!.inputs[0]).toEqual({ role: 'edit', media: 'image', from: { assetId: 'ast_body', origin: 'character' } });
  });

  it('a retry of one view draws it from the earlier full body', async () => {
    const run = await plan({ kind: 'character', name: 'Maya', model: 'bytedance/seedream-5.0-lite', resolution: '2K', sheet: { descriptor: maya } }, ['profile'], { full_body: 'ast_prev_body' });
    expect(run.items).toHaveLength(1);
    expect(run.items[0]!.spec!.inputs).toEqual([{ role: 'edit', media: 'image', from: { assetId: 'ast_prev_body', origin: 'generated' } }]);
  });
});

describe('consistency check', () => {
  it('reads head crops from face-detect, most confident first', () => {
    const heads = headCropsOf({ faces: [{ confidence: 70, head_url: 'https://gw/h2.jpg', box: { x: 1, y: 2, width: 3, height: 4 } }, { confidence: 99, head_url: 'https://gw/h1.jpg' }, { confidence: 50, head_url: 'javascript:x' }] });
    expect(heads.map((h) => h.url)).toEqual(['https://gw/h1.jpg', 'https://gw/h2.jpg', null]);
    expect(heads[1]!.box).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(headCropsOf({ faces: [] })).toEqual([]);
  });

  it('scores the best candidate and maps scores to verdicts', () => {
    expect(bestMatch({ matches: [{ image: 2, similarity: 0.41, sameIdentity: false }, { image: 3, similarity: 0.83, sameIdentity: true }] }, 2)).toEqual({ score: 0.83, image: 3, sameIdentity: true });
    expect(() => bestMatch({ matches: [{ image: 9, similarity: 0.9, sameIdentity: true }] }, 1)).toThrow();
    expect(() => bestMatch({ nope: true }, 1)).toThrow();
    expect(driftVerdict(0.9)).toBe('consistent');
    expect(driftVerdict(DRIFT_THRESHOLDS.drift)).toBe('minor');
    expect(driftVerdict(0.3)).toBe('drift');
    expect(driftVerdict(null)).toBe('no_face');
    expect(summarizeDrift([0.9, 0.4, null])).toEqual({ checks: 3, scored: 2, mean: 0.65, min: 0.4, drifted: 1, verdict: 'drift' });
    expect(summarizeDrift([]).verdict).toBeNull();
  });
});

describe('training', () => {
  it('the gateway applies LoRA weights but trains none (D-032)', () => {
    const t = trainingAvailability(fixtureCatalog.models);
    expect(t.available).toBe(false);
    expect(t.appliesLoras).toContain('lumina/w2.2-i2v-lora');
    expect(t.trains).toEqual([]);
  });
});
