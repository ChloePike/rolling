import { describe, expect, it } from 'vitest';
import { enhanceChoice, enhanceStateOf } from './enhance';

describe('D-020 Enhance prompt toggle', () => {
  it('shows only for models that take the gateway expansion; "Not available yet" while refused', () => {
    expect(enhanceStateOf([{ promptExpand: 'available' }])).toBe('available');
    expect(enhanceStateOf([{ promptExpand: 'unavailable' }])).toBe('unavailable');
    expect(enhanceStateOf([{ promptExpand: null }])).toBeNull();
    expect(enhanceStateOf([{}])).toBeNull();
    expect(enhanceStateOf([undefined])).toBeNull();
    // Auto: available when any candidate takes it.
    expect(enhanceStateOf([{ promptExpand: null }, { promptExpand: 'available' }])).toBe('available');
    expect(enhanceStateOf([{ promptExpand: null }, { promptExpand: 'unavailable' }])).toBe('unavailable');
    expect(enhanceStateOf([])).toBeNull();
  });

  it('starts from the Preferences default; a per-run change wins; the spec carries it only when usable', () => {
    expect(enhanceChoice('available', null, true)).toEqual({ on: true, spec: { promptExpand: true } });
    expect(enhanceChoice('available', null, false)).toEqual({ on: false, spec: { promptExpand: false } });
    expect(enhanceChoice('available', false, true)).toEqual({ on: false, spec: { promptExpand: false } });
    expect(enhanceChoice('available', true, false)).toEqual({ on: true, spec: { promptExpand: true } });
    expect(enhanceChoice('unavailable', true, true).spec).toEqual({});
    expect(enhanceChoice(null, null, true).spec).toEqual({});
  });
});
