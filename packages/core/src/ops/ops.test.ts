import { describe, expect, it } from 'vitest';
import { CLOSED, DEFAULT_BREAKER, countsAsOutage, isOpen, onFailure, onSuccess, phaseOf } from './breaker';
import { buildNcmecPacket } from './ncmec';
import { componentStatus, overallStatus } from './status';
import { lastDays, margin, percentile, routeGroup, successRate } from './metrics';
import { staffCan } from './staff';
import { addBusinessDays, actionAllowed, DmcaNoticeBody, ReportBody, reportPriority } from './trust';

describe('breaker', () => {
  it('opens after the threshold inside the window, fails fast, half-opens, closes on success', () => {
    let s = CLOSED;
    const t = 1_000_000;
    for (let i = 0; i < DEFAULT_BREAKER.threshold - 1; i++) s = onFailure(s, t + i, '503');
    expect(s.state).toBe('closed');
    s = onFailure(s, t + 10, '503');
    expect(isOpen(s, t + 11)).toBe(true);
    expect(phaseOf(s, t + 10 + DEFAULT_BREAKER.openMs)).toBe('half_open');
    // A failure while half-open opens it again at once.
    const again = onFailure(s, t + 10 + DEFAULT_BREAKER.openMs, 'timeout');
    expect(isOpen(again, t + 11 + DEFAULT_BREAKER.openMs)).toBe(true);
    expect(onSuccess(again)).toEqual(CLOSED);
  });

  it('forgets failures outside the window and ignores client errors', () => {
    let s = onFailure(CLOSED, 0, '500');
    s = onFailure(s, DEFAULT_BREAKER.windowMs + 1, '500');
    expect(s.failures).toBe(1);
    expect([0, 408, 500, 502, 504].every(countsAsOutage)).toBe(true);
    expect([400, 402, 403, 404, 422, 429].some(countsAsOutage)).toBe(false);
  });
});

describe('status', () => {
  const p = (ok: boolean, at: number, latencyMs = 100) => ({ component: 'api' as const, ok, latencyMs, detail: null, checkedAt: at });
  it('maps probes to component and overall status', () => {
    const now = 10_000_000;
    expect(componentStatus('api', [], now)).toBe('unknown');
    expect(componentStatus('api', [p(true, now - 1000)], now)).toBe('operational');
    expect(componentStatus('api', [p(true, now - 1000, 5000)], now)).toBe('degraded');
    expect(componentStatus('api', [p(false, now - 1000), p(true, now - 300_000)], now)).toBe('degraded');
    expect(componentStatus('api', [p(false, now - 1000), p(false, now - 300_000)], now)).toBe('down');
    expect(componentStatus('api', [p(true, now - 3_600_000)], now)).toBe('unknown');
    expect(overallStatus(['operational', 'operational'], false)).toBe('operational');
    expect(overallStatus(['operational'], true)).toBe('degraded');
    expect(overallStatus(['down', 'operational'], false)).toBe('outage');
  });
});

describe('metrics', () => {
  it('percentiles, success rate, margin, days, route groups', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 90)).toBe(5);
    expect(percentile([], 50)).toBeNull();
    expect(successRate(9, 1)).toBe(0.9);
    expect(successRate(0, 0)).toBeNull();
    expect(margin(1000, 3.5)).toMatchObject({ revenueUsd: 10, costUsd: 3.5, marginUsd: 6.5 });
    expect(margin(1000, 3.5).marginPct).toBeCloseTo(0.65);
    expect(lastDays(3, Date.UTC(2026, 10, 27, 15))).toEqual(['2026-11-25', '2026-11-26', '2026-11-27']);
    expect(routeGroup('/api/runs/run_01ABC/cancel')).toBe('/api/runs');
    expect(routeGroup('/share/x')).toBe('web');
  });
});

describe('staff and trust contracts', () => {
  it('permissions per role', () => {
    expect(staffCan('admin', 'credits')).toBe(true);
    expect(staffCan('reviewer', 'review')).toBe(true);
    expect(staffCan('reviewer', 'credits')).toBe(false);
    expect(staffCan('reviewer', 'child_safety')).toBe(false);
    expect(staffCan(null, 'view')).toBe(false);
  });

  it('reports, DMCA notices, priorities and actions', () => {
    expect(ReportBody.safeParse({ targetKind: 'share', targetId: 'shr_1', category: 'spam' }).success).toBe(true);
    expect(ReportBody.safeParse({ targetKind: 'url', category: 'spam' }).success).toBe(false);
    expect(reportPriority('child_safety')).toBe(2);
    expect(reportPriority('spam')).toBe(0);
    const dmca = { fullName: 'A B', email: 'a@b.co', phone: '1', address: 'x', workDescription: 'w', infringingUrls: ['https://rolling.actor/share/shr_1'], goodFaith: true, accuracyUnderPenalty: true, signature: 'A B' };
    expect(DmcaNoticeBody.safeParse(dmca).success).toBe(true);
    expect(DmcaNoticeBody.safeParse({ ...dmca, accuracyUnderPenalty: false }).success).toBe(false);
    expect(actionAllowed('appeal', 'overturn')).toBe(true);
    expect(actionAllowed('appeal', 'suspend')).toBe(false);
    // Friday + 10 business days = two weeks later (a Friday).
    expect(new Date(addBusinessDays(Date.UTC(2026, 10, 27), 10)).toISOString().slice(0, 10)).toBe('2026-12-11');
  });

  it('builds an NCMEC packet without content, pending human submission', () => {
    const pkt = buildNcmecPacket(
      {
        caseId: 'case_1',
        createdAt: 1,
        source: 'automated_check',
        stage: 'post',
        codes: ['MINOR_SEXUAL'],
        appUrl: 'https://rolling.actor',
        incidentAt: Date.UTC(2026, 10, 27),
        reportedUser: { id: 'usr_1', email: 'u@example.com', name: 'U', createdAt: null, workspaceId: 'ws_1' },
        location: { runId: 'run_1', jobId: 'job_1', shareUrl: null },
        evidence: [{ id: 'evi_1', kind: 'object', sha256: 'ab', size: 10, contentType: 'image/png', capturedAt: 2 }],
      },
      3,
    );
    expect(pkt.submission.status).toBe('pending');
    expect(pkt.incident.detection).toContain('MINOR_SEXUAL');
    expect(pkt.uploadedFiles[0]).toMatchObject({ evidenceId: 'evi_1', sha256: 'ab', viewedByEsp: false });
    expect(JSON.stringify(pkt)).not.toContain('evidence/');
  });
});
