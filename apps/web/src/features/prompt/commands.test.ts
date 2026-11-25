import { describe, expect, it } from 'vitest';
import { filterCommands, isSlashQuery, stripTrailingAt, trailingAtQuery } from './commands';
import type { PromptCommandGroup } from './types';

const groups: PromptCommandGroup[] = [
  { id: 's', title: 'Skills', items: [{ id: 'a', name: 'TV ad', description: 'Ads with a storyboard', icon: 'film', kind: 'skill' }] },
  { id: 'c', title: 'Create', items: [{ id: 'b', name: 'Voice', description: 'Pick a voice', icon: 'wave', kind: 'action' }] },
];

describe('prompt commands', () => {
  it('opens the palette only for a leading slash without whitespace', () => {
    expect(isSlashQuery('/')).toBe(true);
    expect(isSlashQuery('/tv')).toBe(true);
    expect(isSlashQuery('/tv ad')).toBe(false);
    expect(isSlashQuery('a /tv')).toBe(false);
    expect(isSlashQuery('/tv\n')).toBe(false);
  });
  it('filters by name or description and drops empty groups', () => {
    expect(filterCommands(groups, '').map((g) => g.id)).toEqual(['s', 'c']);
    expect(filterCommands(groups, 'VOI').flatMap((g) => g.items.map((i) => i.id))).toEqual(['b']);
    expect(filterCommands(groups, 'storyboard').map((g) => g.id)).toEqual(['s']);
    expect(filterCommands(groups, 'zzz')).toEqual([]);
  });
  it('detects and strips an @query at the end of the prompt', () => {
    expect(trailingAtQuery('Ad for @')).toBe('');
    expect(trailingAtQuery('Ad for @mi')).toBe('mi');
    expect(trailingAtQuery('mail me@ x')).toBeNull();
    expect(stripTrailingAt('Ad for @mi')).toBe('Ad for ');
  });
});
