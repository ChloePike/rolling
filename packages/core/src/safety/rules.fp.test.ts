/**
 * D-005 false-positive eval, rules level (free): every case of
 * evals/false-positives.json through the agent gate with a classifier that
 * finds nothing, for a non-mature caller and a mature-allowed caller.
 * Benign cases must allow; rules-layer true positives must block.
 */
import { describe, expect, it } from 'vitest';
import { fixtureCatalog } from '../models/__fixtures__/catalog';
import { CALLER_KINDS, FP_CASES, isTruePositive, rulesLevelExpectation, rulesLevelGate, runThroughGate } from './evals';
import { HARD_LIMIT_CODES, type SafetyCode } from './types';

const gate = rulesLevelGate(fixtureCatalog.list({ kind: 'chat', includeMatureOnly: true }));

describe('false-positive eval set', () => {
  it('has unique ids and covers en, zh-CN, ja and ko', () => {
    expect(new Set(FP_CASES.map((c) => c.id)).size).toBe(FP_CASES.length);
    for (const lang of ['en', 'zh-CN', 'ja', 'ko']) expect(FP_CASES.some((c) => c.lang === lang && !isTruePositive(c)), lang).toBe(true);
  });

  it('has a true positive for every hard-limit code, plain and in Chinese', () => {
    for (const code of HARD_LIMIT_CODES) {
      const tps = FP_CASES.filter((c) => c.code === code);
      expect(tps.some((c) => c.lang === 'en'), code).toBe(true);
      expect(tps.some((c) => c.lang === 'zh-CN'), code).toBe(true);
    }
    for (const c of FP_CASES.filter(isTruePositive)) {
      expect(HARD_LIMIT_CODES.has(c.code as SafetyCode), c.id).toBe(true);
      expect(c.expect).toEqual({ nonMature: 'block', matureAllowed: 'block' });
    }
  });
});

describe.each(CALLER_KINDS)('rules level, %s caller', (caller) => {
  const cases = FP_CASES.flatMap((c) => {
    const expected = rulesLevelExpectation(c, caller);
    return expected === null ? [] : [{ ...c, expected }];
  });

  it.each(cases.filter((c) => !isTruePositive(c)))('$id allows ($category, $lang)', async (c) => {
    expect(await runThroughGate(gate, c, caller), c.text).toBe(c.expected);
  });

  it.each(cases.filter(isTruePositive))('$id blocks ($code, $lang)', async (c) => {
    expect(await runThroughGate(gate, c, caller), c.text).toBe('block');
  });
});
