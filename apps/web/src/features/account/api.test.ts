import { describe, expect, it } from 'vitest';
import { fetchTopUps, formatUsd, topUpFor } from './api';

const fmt = (n: number, o: Intl.NumberFormatOptions) => new Intl.NumberFormat('en-US', o).format(n);

describe('account api helpers', () => {
  it('formats whole dollars without cents and others with cents', () => {
    expect(formatUsd(15, fmt)).toBe('$15');
    expect(formatUsd(39.17, fmt)).toBe('$39.17');
    expect(formatUsd(10000, fmt)).toBe('$10,000');
  });

  it('quotes top-ups with tier bonus, plus the plan bonus only for members', () => {
    expect(topUpFor(10, null)).toMatchObject({ credits: 1000, bonusCredits: 0 });
    expect(topUpFor(25, null)).toMatchObject({ credits: 2600, bonusCredits: 100 });
    expect(topUpFor(25, 'pro')).toMatchObject({ credits: 2850, bonusCredits: 350 });
    expect(topUpFor(10, 'plus')).toMatchObject({ credits: 1050 });
  });

  it('lists the preset amounts in order', async () => {
    expect((await fetchTopUps(null)).map((t) => t.amountUsd)).toEqual([10, 25, 50, 100, 250]);
  });
});
