import { describe, expect, it } from 'vitest';
import { isSendKey } from './keys';

describe('prompt send key (PromptBox and the tool composer)', () => {
  it('Enter sends; Shift+Enter, other keys and IME composition do not', () => {
    expect(isSendKey({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(isSendKey({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(isSendKey({ key: 'a', shiftKey: false })).toBe(false);
    expect(isSendKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(isSendKey({ key: 'Enter', shiftKey: false, keyCode: 229 })).toBe(false);
  });
});
