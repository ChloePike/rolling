import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import messages from '../../../../../../messages/en/tools.json';
import { formatAgo, formatClock } from './format';

const intl = createIntl({ locale: 'en', messages });

describe('tool feed formatting', () => {
  it('formats media durations as mm:ss', () => {
    expect(formatClock(intl, 15)).toBe('00:15');
    expect(formatClock(intl, 75)).toBe('01:15');
  });
  it('formats finished times like the design', () => {
    expect(formatAgo(intl, 10)).toBe('10 min ago');
    expect(formatAgo(intl, 60)).toBe('1h ago');
    expect(formatAgo(intl, 24 * 60)).toBe('Yesterday');
    expect(formatAgo(intl, 3 * 24 * 60)).toBe('3d ago');
  });
});
