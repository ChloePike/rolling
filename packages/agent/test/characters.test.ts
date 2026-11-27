/**
 * D-032 in plans: recurring characters link to saved characters by name or
 * `@` sheet picture, take their locked words, and their sheet views are wired
 * as references (straight to a reference-taking video model, or into the
 * keyframe of a model that animates a first frame).
 */
import { describe, expect, it } from 'vitest';
import { applyGraphOps } from '@rolling/core/project';
import { linkSavedCharacters, runPropose, unsavedRecurringPeople, type ProposeContext } from '../src/proposals';
import type { CharacterItem } from '../src/ports';
import type { PlanBody } from '../src/types';
import { evalPorts, evalWorld, PROJECT_ID } from '../evals/world';

const MAYA: CharacterItem = {
  id: 'chr_maya',
  name: 'Maya Chen',
  kind: 'person',
  look: 'woman in her late twenties, oval face, small mole under the left eye; black side-part bob; slim',
  wardrobe: 'mustard trench coat over a white tee',
  sheet: { full_body: 'ast_maya_full', front: 'ast_maya_front', three_quarter: 'ast_maya_tq', profile: 'ast_maya_profile', expression_smile: 'ast_maya_smile' },
  outfits: [{ name: 'Office', outfit: 'navy suit, white shirt', views: { full_body: 'ast_maya_office_full', three_quarter: 'ast_maya_office_tq' } }],
};

function ctx(characters: CharacterItem[], over: Partial<ProposeContext> = {}): ProposeContext {
  const world = evalWorld();
  world.characters = characters;
  let n = 0;
  return {
    ports: evalPorts(world),
    account: world.account,
    thread: { surface: 'home', projectId: null, canvasId: null },
    newId: () => `prop_c${++n}`,
    now: () => 1_000,
    refs: [],
    userText: 'A short drama with Maya',
    ...over,
  };
}

const shot = (over: Record<string, unknown>) => ({ title: 'A', seconds: 5, subject: 'Maya at her desk', action: 'Maya looks up from her phone', cast: ['Maya'], ...over });
const plan = (model: string, characters: unknown[], shots: unknown[]) => ({ seconds: 10, options: [0, 1].map((k) => ({ title: `O${k}`, ratio: '9:16', model, characters, shots })) });

describe('linking saved characters', () => {
  it('links by name or first name and takes the locked look and the named outfit variant', () => {
    const chars = [{ name: 'Maya', look: 'young woman', wardrobe: 'her office outfit' }, { name: 'Leo', look: 'man in his thirties' }];
    const linked = linkSavedCharacters(chars, [MAYA]);
    expect([...linked.keys()]).toEqual(['maya']);
    expect(chars[0]!.look).toBe(MAYA.look);
    expect(chars[0]!.wardrobe).toBe('navy suit, white shirt');
    expect(linked.get('maya')).toMatchObject({ characterId: 'chr_maya', outfitName: 'Office', outfitViews: { full_body: 'ast_maya_office_full' } });
    // Leo has no saved character: untouched.
    expect(chars[1]).toEqual({ name: 'Leo', look: 'man in his thirties' });
  });

  it('links an `@` sheet picture to the one recurring person; a saved character without a sheet only gives its words', () => {
    const chars = [{ name: 'The heroine', look: 'woman' }];
    expect(linkSavedCharacters(chars, [MAYA], [{ id: 'ast_maya_front' }]).get('the heroine')?.characterId).toBe('chr_maya');
    const plain = [{ name: 'Maya', look: 'woman', wardrobe: 'red dress' }];
    expect(linkSavedCharacters(plain, [{ id: 'chr_x', name: 'Maya', look: 'saved look' }]).size).toBe(0);
    expect(plain[0]).toEqual({ name: 'Maya', look: 'saved look', wardrobe: 'red dress' });
  });
});

describe('plans with saved characters', () => {
  it('passes the best sheet views straight to a model that takes reference images, without a keyframe', async () => {
    const res = await runPropose(
      'propose.plan',
      plan('bytedance/seedance-2.0-mini', [{ name: 'Maya', look: 'young woman' }], [shot({ camera: { size: 'close_up' } }), shot({ title: 'B', camera: { size: 'wide' }, subject: 'Maya crossing the street', action: 'Maya walks to the curb' })]),
      ctx([MAYA]),
    );
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    const o = (res.proposal.body as PlanBody).options[0]!;
    expect(o.characters![0]!.look).toContain('small mole under the left eye');
    expect(o.shots[0]!.shot!.characters![0]!.wardrobe).toBe(MAYA.wardrobe);
    expect(o.shots.map((s) => s.characterRefs?.strategy)).toEqual(['refs', 'refs']);
    expect(o.shots[0]!.characterRefs!.refs.map((r) => r.view)).toEqual(['front', 'three_quarter']);
    expect(o.shots[1]!.characterRefs!.refs[0]!.view).toBe('full_body');
    expect(o.shots.every((s) => s.mode === 't2v')).toBe(true);
    // No keyframe, no generated sheet: asset nodes of the saved pictures feed the videos in reference mode.
    const added = o.ops.filter((x) => x.op === 'addNode') as Array<{ kind: string; tempId: string; title: string; params: Record<string, unknown> }>;
    expect(added.filter((n) => n.kind === 'image')).toEqual([]);
    const sheetNodes = added.filter((n) => n.kind === 'asset');
    expect(sheetNodes.map((n) => n.params.assetId).sort()).toEqual(['ast_maya_front', 'ast_maya_full', 'ast_maya_tq'].sort());
    expect(sheetNodes.find((n) => n.params.assetId === 'ast_maya_front')!.title).toBe('Character: Maya · front');
    const video = added.find((n) => n.kind === 'video')!;
    expect(video.params.mode).toBe('Reference to video');
    const applied = applyGraphOps({ revision: 0, nodes: [], edges: [], groups: [] }, o.ops, { actor: 'agent' });
    expect(applied.ok).toBe(true);
    // The estimate prices the reference pictures with the clip; no sheet to suggest.
    expect(o.estimate.items.map((i) => i.kind)).toEqual(['video', 'video']);
    expect(res.proposal.risks.some((r) => r.code === 'character_sheet_suggested')).toBe(false);
  });

  it('chains through a keyframe drawn from the sheets when the reference slots cannot hold the cast', async () => {
    // The video node takes two reference pictures; three saved people in one shot go through a keyframe instead.
    const people = ['Ana', 'Ben', 'Cy'].map((name) => ({ ...MAYA, id: `chr_${name}`, name, outfits: [], sheet: { full_body: `ast_${name}_full`, front: `ast_${name}_front` } }));
    const chars = people.map((p) => ({ name: p.name, look: 'adult' }));
    const group = (title: string) => shot({ title, subject: 'Ana, Ben and Cy at a table', action: 'Ana, Ben and Cy raise their glasses', cast: ['Ana', 'Ben', 'Cy'] });
    const res = await runPropose('propose.plan', plan('bytedance/seedance-2.0-mini', chars, [group('A'), group('B')]), ctx(people));
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    const o = (res.proposal.body as PlanBody).options[0]!;
    expect(o.shots.every((s) => s.characterRefs?.strategy === 'chain' && s.mode === 'i2v')).toBe(true);
    expect(new Set(o.shots[0]!.characterRefs!.refs.map((r) => r.characterId)).size).toBe(3);
    const keyframe = o.ops.find((x) => x.op === 'addNode' && x.kind === 'image') as { tempId: string; params: Record<string, unknown> };
    expect(keyframe.params.mode).toBe('edit');
    const refsInto = o.ops.filter((x) => x.op === 'connect' && x.to.node === keyframe.tempId && x.to.port === 'refs');
    expect(refsInto.length).toBeGreaterThanOrEqual(3);
    expect(applyGraphOps({ revision: 0, nodes: [], edges: [], groups: [] }, o.ops, { actor: 'agent' }).ok).toBe(true);
  });

  it('suggests a character sheet for recurring people that have none', async () => {
    const res = await runPropose('propose.plan', plan('bytedance/seedance-2.0-mini', [{ name: 'Leo', look: 'man in his thirties' }], [shot({ subject: 'Leo at a desk', action: 'Leo types', cast: ['Leo'] }), shot({ title: 'B', subject: 'Leo outside', action: 'Leo waves', cast: ['Leo'] })]), ctx([MAYA]));
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.proposal.risks).toContainEqual({ code: 'character_sheet_suggested', data: { names: ['Leo'] } });
    expect(unsavedRecurringPeople((res.proposal.body as PlanBody).options, new Set(['leo']))).toEqual([]);
  });

  it('works on canvas threads too', async () => {
    const res = await runPropose('propose.plan', plan('bytedance/seedance-2.0-mini', [{ name: 'Maya', look: 'young woman' }], [shot({}), shot({ title: 'B' })]), ctx([MAYA], { thread: { surface: 'canvas', projectId: PROJECT_ID, canvasId: null } }));
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
  });
});
