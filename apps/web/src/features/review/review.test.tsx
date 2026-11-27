import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { buildReview, takeVerdict, type ResultReview } from '@rolling/core/review';
import { englishMessages } from '@/i18n/messages';
import { QualityBadge } from './QualityBadge';
import { QualityReview } from './QualityReview';
import { retryWithFixOp, reviewViewOf } from './types';

const BAD: ResultReview = {
  ...buildReview({
    model: 'deepseek/deepseek-v4.1-flash',
    costUsd: 0.0009,
    takes: [
      takeVerdict({
        scores: { anatomy: 2, text: 5, adherence: 4, continuity: null, framing: 5, artifacts: 4 },
        issues: [{ dimension: 'anatomy', severity: 'major', note: 'Left hand has six fingers' }],
        fix: { prompt: 'A chef plating pasta, relaxed hands', negativePrompt: 'extra fingers', note: 'Asks for natural hands' },
      }),
    ],
  }),
  action: { kind: 'offer', reason: 'manual' },
};
const GOOD = buildReview({ model: 'm', costUsd: null, takes: [takeVerdict({ scores: { anatomy: 5, text: 5, adherence: 5, continuity: null, framing: 5, artifacts: 5 }, issues: [], fix: null })] });

const html = (node: React.ReactElement) => renderToStaticMarkup(<IntlProvider locale="en" messages={englishMessages}>{node}</IntlProvider>);

describe('result review UI (D-024)', () => {
  it('reads a version review and ignores anything else', () => {
    expect(reviewViewOf(BAD)).toMatchObject({ grade: 'poor', offer: true, fix: { note: 'Asks for natural hands' } });
    expect(reviewViewOf({ ...BAD, action: { kind: 'offer', reason: 'budget' } })?.overBudget).toBe(true);
    expect(reviewViewOf(null)).toBeUndefined();
    expect(reviewViewOf({ score: 'x' })).toBeUndefined();
  });

  it('shows the badge with grade and score', () => {
    const out = html(<QualityBadge review={reviewViewOf(BAD)!} />);
    expect(out).toContain('data-grade="poor"');
    expect(out).toContain('Has issues');
    expect(out).toContain('2.5/5');
    expect(out).toContain('aria-label="Quality check: has issues, 2.5 out of 5"');
    expect(html(<QualityBadge review={reviewViewOf(GOOD)!} compact />)).not.toContain('Looks good</span>');
  });

  it('lists the issues and offers Retry with fix with its cost', () => {
    const out = html(<QualityReview review={reviewViewOf(BAD)!} onRetryWithFix={() => undefined} retryCost={6} />);
    expect(out).toContain('Anatomy');
    expect(out).toContain('Major');
    expect(out).toContain('Left hand has six fingers');
    expect(out).toContain('Suggested fix: Asks for natural hands');
    expect(out).toContain('data-testid="retry-with-fix"');
    expect(out).toContain('Retry with fix');
    expect(out).toMatch(/Retry with fix<span[^>]*>6<\/span>/);
  });

  it('has no retry button for a good result, an Auto retry or where results cannot be retried', () => {
    expect(html(<QualityReview review={reviewViewOf(GOOD)!} onRetryWithFix={() => undefined} />)).not.toContain('retry-with-fix');
    expect(html(<QualityReview review={reviewViewOf(GOOD)!} />)).toContain('No issues found.');
    const auto = reviewViewOf({ ...BAD, action: { kind: 'auto', runId: 'run_1' } })!;
    const out = html(<QualityReview review={auto} onRetryWithFix={() => undefined} />);
    expect(out).not.toContain('retry-with-fix');
    expect(out).toContain('Retried once with the fix');
    expect(html(<QualityReview review={reviewViewOf(BAD)!} />)).not.toContain('retry-with-fix');
  });

  it('Retry with fix writes the fix to the node and keeps its other params', () => {
    const node = { id: 'node_1', params: { prompt: 'A chef plating pasta', negativePrompt: 'blur', model: 'm', ratio: '1:1' } };
    expect(retryWithFixOp(node, reviewViewOf(BAD))).toEqual({
      op: 'updateNode',
      nodeId: 'node_1',
      params: { prompt: 'A chef plating pasta, relaxed hands', negativePrompt: 'blur, extra fingers' },
    });
    expect(retryWithFixOp(node, reviewViewOf(GOOD))).toBeNull();
    expect(retryWithFixOp(node, undefined)).toBeNull();
  });
});
