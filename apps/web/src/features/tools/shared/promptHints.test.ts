import { describe, expect, it } from 'vitest';
import { avatarHints, remixHints, shotPrompt } from './promptHints';

describe('tool prompt hints', () => {
  it('avatar: persona, expression and setting become direction lines', () => {
    expect(avatarHints({ persona: 'Calm news anchor', emotion: 'Warm', setting: { scene: 'Bright studio' } })).toEqual([
      'Presenting style: Calm news anchor.',
      'Expression: warm.',
      'Setting: Bright studio.',
    ]);
    expect(avatarHints({ setting: { keepPhoto: true } })).toEqual(['Keep the background of the photo.']);
    expect(avatarHints({ persona: ' ' })).toEqual([]);
  });

  it('remix: motion and outfit target', () => {
    expect(remixHints({ motion: 6, outfitFor: 'Character 2' })).toEqual(['Motion intensity: 6 of 10.', 'Apply the new outfit only to Character 2.']);
    expect(remixHints({})).toEqual([]);
  });

  it('remix: shot fields join into one shot prompt, skipping empty ones', () => {
    expect(shotPrompt([['Camera', 'Slow push-in'], ['Line · Character 1', ''], ['Character 1 action', 'Waves']])).toBe('Camera: Slow push-in. Character 1 action: Waves');
    expect(shotPrompt([['Camera', ' ']])).toBe('');
  });
});
