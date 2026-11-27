import { describe, expect, it } from 'vitest';
import { gradeReviewCase, REVIEW_CASES, REVIEW_GRADER_IDS, reviewScorecard } from './review';

describe('result review graders (D-024): verdict to action', () => {
  it.each(REVIEW_CASES.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const grades = gradeReviewCase(c);
    expect(grades.length).toBeGreaterThan(0);
    for (const g of grades) expect(g.failures, `${g.grader}`).toEqual([]);
  });

  it('applies every grader to some case', () => {
    const card = reviewScorecard();
    for (const id of REVIEW_GRADER_IDS) {
      expect(card[id].applied, id).toBeGreaterThan(0);
      expect(card[id].passed, id).toBe(card[id].applied);
    }
  });

  it('catches a wrong decision (the graders are not vacuous)', () => {
    const c = REVIEW_CASES.find((x) => x.id === 'hands-edit-offer')!;
    const wrong = gradeReviewCase({ ...c, expect: { ...c.expect, action: 'auto' } });
    expect(wrong.find((g) => g.grader === 'action')!.pass).toBe(false);
    const quiet = gradeReviewCase({ ...c, expect: { ...c.expect, agentMentions: ['seven fingers'] } });
    expect(quiet.find((g) => g.grader === 'agent_line')!.pass).toBe(false);
  });
});

describe('agent awareness (D-024)', () => {
  it('puts the reviews of the current versions in the canvas context and the rule in the canvas prompt only', async () => {
    const { buildContext, systemPromptFor } = await import('../src/context');
    const { evalPorts, evalWorld, PROJECT_ID } = await import('./world');
    const { toolDefinition, toolsFor } = await import('../src/tools');
    const { buildReview, summarizeReview, takeVerdict } = await import('@rolling/core/review');
    const world = evalWorld();
    const ports = evalPorts(world);
    const bad = buildReview({
      model: 'm',
      costUsd: null,
      takes: [
        takeVerdict({
          scores: { anatomy: 2, text: 5, adherence: 5, continuity: null, framing: 5, artifacts: 5 },
          issues: [{ dimension: 'anatomy', severity: 'major', note: 'Left hand has six fingers' }],
          fix: { prompt: 'Same shot, relaxed hands', note: 'Asks for natural hands' },
        }),
      ],
    });
    const getGraph = ports.canvas.getGraph.bind(ports.canvas);
    ports.canvas.getGraph = async (id) => {
      const g = await getGraph(id);
      return g ? { ...g, reviews: { node_shot2: summarizeReview({ ...bad, action: { kind: 'offer', reason: 'manual' } }) } } : null;
    };
    const ctx = await buildContext({
      thread: { threadId: 'thr_r', surface: 'canvas', skill: null, projectId: PROJECT_ID, canvasId: null, summary: '', messages: [], proposals: [] },
      input: { text: 'how did it go?', refs: [], selection: [] },
      account: world.account,
      ports,
      tools: toolsFor('canvas').map(toolDefinition),
    });
    const system = ctx.messages[0]!.content as string;
    expect(system).toContain('Result reviews (current versions with a problem, worst first):\nnode_shot2 "');
    expect(system).toContain('anatomy (major): Left hand has six fingers');
    expect(system).toContain('"Retry with fix" is offered.');
    expect(systemPromptFor('canvas')).toContain('# Result reviews');
    expect(systemPromptFor('home')).not.toContain('# Result reviews');
  });
});
