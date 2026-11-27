import { describe, expect, it } from 'vitest';
import { fixtureCatalog, fixtureModel } from '../models/__fixtures__/catalog';
import { creditsFor, MARKUP, PLANS, TRIAL, USD_PER_CREDIT, trialWorstCaseUsd } from './config';
import { isTrialModel, trialGrant, trialProblem, trialStatus } from './trial';

const DAY = 86_400_000;

describe('trial grant math (D-022)', () => {
  it('covers five Seedream 5.0 Lite images and one 5 s 480p Seedance 2.0 Mini video at live prices', () => {
    const image = creditsFor(fixtureModel('bytedance/seedream-5.0-lite'), {});
    const video = creditsFor(fixtureModel('bytedance/seedance-2.0-mini'), { resolution: '480p', seconds: 5 });
    expect(image).toBe(11);
    expect(video).toBe(53);
    expect(5 * image + video).toBe(108);
    expect(TRIAL.credits).toBeGreaterThanOrEqual(5 * image + video);
    // Not much more than that: the trial stays small.
    expect(TRIAL.credits).toBeLessThanOrEqual(Math.ceil((5 * image + video) * 1.2));
  });

  it('fits every trial video model once at the cap, and three cheap images besides', () => {
    for (const id of TRIAL.models.video) {
      const m = fixtureModel(id);
      const v = creditsFor(m, { resolution: TRIAL.maxVideoResolution, seconds: TRIAL.maxVideoSeconds });
      expect(v, id).toBeLessThanOrEqual(TRIAL.credits);
    }
    const flash = creditsFor(fixtureModel('bytedance/seedream-5.0-flash'), {});
    const mini = creditsFor(fixtureModel('bytedance/seedance-2.0-mini'), { resolution: '480p', seconds: 5 });
    expect(3 * flash + mini).toBeLessThanOrEqual(TRIAL.credits);
  });

  it('costs at most $0.45 of gateway spend per trial user, worst case', () => {
    // credits = ceil(usd × MARKUP / USD_PER_CREDIT), so usd ≤ credits × USD_PER_CREDIT / MARKUP.
    expect((TRIAL.credits * USD_PER_CREDIT) / MARKUP).toBeCloseTo(0.4, 6);
    expect(trialWorstCaseUsd()).toBeCloseTo(0.45, 6);
    // Smaller than the cheapest plan's own monthly grant.
    expect(TRIAL.credits).toBeLessThan(PLANS.starter.monthlyCredits);
  });

  it('expires 14 days after the grant', () => {
    expect(trialGrant(1_000)).toEqual({ credits: TRIAL.credits, expiresAt: 1_000 + 14 * DAY });
    expect(() => trialGrant(Number.NaN)).toThrow(RangeError);
  });

  it('lists only models that exist, are not adult-only and are featured', () => {
    for (const id of [...TRIAL.models.image, ...TRIAL.models.video]) {
      const m = fixtureCatalog.get(id);
      expect(m, id).toBeTruthy();
      expect(m!.matureOnly, id).toBe(false);
      expect(m!.placement, id).toBe('featured');
    }
  });
});

describe('trial model and settings caps', () => {
  const mini = fixtureModel('bytedance/seedance-2.0-mini');
  const lite = fixtureModel('bytedance/seedream-5.0-lite');

  it('allows the curated models within the caps', () => {
    expect(trialProblem(mini, { resolution: '480p', seconds: 5 })).toBeNull();
    expect(trialProblem(mini, {})).toBeNull(); // default 480p, 4 s
    expect(trialProblem(lite, { n: 4 })).toBeNull();
    expect(trialProblem(lite, { resolution: '2K' })).toBeNull();
    expect(trialProblem(lite, { resolution: '1K', size: '2048x2048' })).toBeNull();
    expect(isTrialModel('bytedance/seedream-5.0-flash', 'image')).toBe(true);
    expect(isTrialModel('bytedance/seedream-5.0-flash', 'video')).toBe(false);
  });

  it('locks other models, including the default Seedance 2.5 and mature ones', () => {
    expect(trialProblem(fixtureModel('bytedance/seedance-2.5'), { resolution: '480p', seconds: 5 })).toEqual({ code: 'model', lowestPlan: 'starter' });
    expect(trialProblem(fixtureModel('lumina/z-image-spicy'), {})).toMatchObject({ code: 'model' });
    expect(trialProblem(fixtureModel('minimax/minimax-h3'), {})).toMatchObject({ code: 'model' });
  });

  it('locks video above 480p and longer than 5 s', () => {
    expect(trialProblem(mini, { resolution: '720p', seconds: 5 })).toEqual({ code: 'resolution', value: '720p', lowestPlan: 'starter' });
    expect(trialProblem(fixtureModel('lumina/berry-1.0'), { resolution: '1080p', seconds: 5 })).toEqual({ code: 'resolution', value: '1080p', lowestPlan: 'plus' });
    expect(trialProblem(mini, { resolution: '480p', seconds: 6 })).toEqual({ code: 'duration', value: 6, lowestPlan: 'starter' });
  });

  it('locks 4K images, oversized sizes and more than four images a run', () => {
    expect(trialProblem(lite, { resolution: '4K' })).toEqual({ code: 'resolution', value: '4K', lowestPlan: 'pro' });
    expect(trialProblem(lite, { size: '4096x4096' })).toMatchObject({ code: 'resolution' });
    expect(trialProblem(lite, { size: 'huge' })).toMatchObject({ code: 'resolution' });
    expect(trialProblem(lite, { n: 5 })).toEqual({ code: 'count', value: 5, lowestPlan: 'starter' });
  });

  it('refuses unknown resolution labels', () => {
    expect(trialProblem(mini, { resolution: 'ultra', seconds: 5 })).toMatchObject({ code: 'resolution' });
  });
});

describe('trial status', () => {
  const base = { trial: 50, trialExpiresAt: 10_000, trialGrantedAt: 0 };
  it('is none, active, used or expired', () => {
    expect(trialStatus({ trial: 0, trialExpiresAt: null, trialGrantedAt: null }, 0)).toBe('none');
    expect(trialStatus(base, 5_000)).toBe('active');
    expect(trialStatus({ ...base, trial: 0 }, 5_000)).toBe('used');
    expect(trialStatus({ ...base, trial: 0, trialHeld: 20 }, 5_000)).toBe('active');
    expect(trialStatus(base, 10_000)).toBe('expired');
  });
});
