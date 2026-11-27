import { describe, expect, it } from 'vitest';
import { reasonFromPlanError, trialReason } from './store';

const err = (data: Record<string, unknown>, path = '/api/runs') => ({ path, error: { code: 'NO_PLAN', message: '', data }, body: {} }) as unknown as Parameters<typeof reasonFromPlanError>[0];

describe('trial refusals (D-022) open the upgrade modal with their own reason', () => {
  it('maps NO_PLAN trial data', () => {
    expect(reasonFromPlanError(err({ trial: 'used' }))).toEqual({ kind: 'trial-used' });
    expect(reasonFromPlanError(err({ trial: 'expired' }))).toEqual({ kind: 'trial-expired' });
    expect(reasonFromPlanError(err({ trial: 'agent_used' }, '/api/agent/threads/t/messages'))).toEqual({ kind: 'trial-agent' });
    expect(reasonFromPlanError(err({ trial: 'active', feature: 'agent_model' }, '/api/agent/threads/t/messages'))).toEqual({ kind: 'trial-agent' });
    expect(reasonFromPlanError(err({ trial: 'active', feature: 'export_1080p' }, '/api/canvases/cnv_1/export'))).toEqual({ kind: 'export', value: '1080p' });
  });

  it('keeps the old reasons without trial data', () => {
    expect(trialReason({})).toBeNull();
    expect(reasonFromPlanError(err({}))).toEqual({ kind: 'generate' });
    expect(reasonFromPlanError(err({}, '/api/agent/threads'))).toEqual({ kind: 'agent' });
  });
});
