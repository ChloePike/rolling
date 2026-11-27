import { describe, expect, it } from 'vitest';
import { ratioIcon } from './ratioIcon';

describe('ratio pill icon follows the ratio', () => {
  it('landscape, portrait or square', () => {
    expect(ratioIcon('16:9')).toBe('wide');
    expect(ratioIcon('21:9')).toBe('wide');
    expect(ratioIcon('4:3')).toBe('wide');
    expect(ratioIcon('9:16')).toBe('ratio');
    expect(ratioIcon('3:4')).toBe('ratio');
    expect(ratioIcon('1:1')).toBe('square');
    expect(ratioIcon('9:16 Original')).toBe('ratio');
    expect(ratioIcon('Auto')).toBe('ratio');
    expect(ratioIcon(undefined)).toBe('ratio');
  });
});
