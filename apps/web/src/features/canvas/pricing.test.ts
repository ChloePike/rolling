import type { GraphNode } from '@rolling/core/graph';
import { canonicalPrompt } from '@rolling/core/prompting/shot';
import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '@/lib/models';
import { catalogCredits, nodeEnhanceOn, nodeExpands } from './pricing';

const model = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  id: 'bytedance/seedream-5.0-flash',
  kind: 'image',
  name: 'Seedream 5.0 Flash',
  tags: [],
  default: true,
  auto: true,
  mature: false,
  matureOnly: false,
  requiresIdentitySafety: false,
  operations: ['t2i'],
  seconds: null,
  defaultSeconds: null,
  resolutions: ['2K'],
  defaultResolution: '2K',
  ratios: ['1:1'],
  audio: false,
  lipSync: false,
  credits: [{ resolution: '2K', seconds: null, credits: 6, enhanced: 7 }],
  promptExpand: 'available',
  ...over,
});

const node = (params: Record<string, unknown> = {}, over: Partial<GraphNode> = {}): GraphNode => ({
  id: 'node_1',
  kind: 'image',
  title: 'Keyframe',
  params: { prompt: 'a red bicycle', model: 'bytedance/seedream-5.0-flash', resolution: '2K', ...params },
  position: { x: 0, y: 0 },
  groupId: null,
  status: 'idle',
  createdBy: 'user',
  ...over,
});

describe('canvas estimates include Enhance prompt (D-020)', () => {
  it('prices the rewrite when the node has it on and the model takes it, like the quote (7, not 6)', () => {
    const m = model();
    expect(nodeExpands(node(), m, true)).toBe(true);
    expect(catalogCredits(m, node(), { enhance: nodeExpands(node(), m, true) })).toBe(7);
    expect(catalogCredits(m, node())).toBe(6);
  });

  it('leaves it out when the toggle is off, the model lacks it, or the gateway refuses it', () => {
    expect(nodeExpands(node({ promptExpand: false }), model(), true)).toBe(false);
    expect(nodeExpands(node(), model(), false)).toBe(false);
    expect(nodeExpands(node(), model({ promptExpand: null }), true)).toBe(false);
    expect(nodeExpands(node(), model({ promptExpand: 'unavailable' }), true)).toBe(false);
    expect(nodeExpands(node(), undefined, true)).toBe(false);
  });

  it('follows the node toggle: agent-planned nodes default off; the user can turn it on', () => {
    expect(nodeEnhanceOn(node({}, { createdBy: 'agent' }), true)).toBe(false);
    expect(nodeEnhanceOn(node({ promptExpand: true }, { createdBy: 'agent' }), false)).toBe(true);
    expect(nodeEnhanceOn(node(), true)).toBe(true);
  });

  it('never prices it for a prompt composed from a shot', () => {
    const shot = { subject: 'A red bicycle', action: 'leans against a white wall' };
    const composed = node({ shot, prompt: canonicalPrompt(shot, 'still') });
    expect(nodeExpands(composed, model(), true)).toBe(false);
    // Once the user edits the prompt it is their own text again.
    expect(nodeExpands(node({ shot, prompt: 'my own words' }), model(), true)).toBe(true);
  });

  it('falls back to the plain price when the catalog has no enhanced point', () => {
    const m = model({ credits: [{ resolution: '2K', seconds: null, credits: 6 }] });
    expect(catalogCredits(m, node(), { enhance: true })).toBe(6);
  });
});
