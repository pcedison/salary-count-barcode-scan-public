import { describe, expect, it } from 'vitest';

import {
  getOperationalMetricsSummary,
  recordCounter,
  recordLatency,
  resetOperationalMetricsForTest
} from './runtimeMetrics';

describe('runtimeMetrics', () => {
  it('tracks rolling counters for operational failures', () => {
    resetOperationalMetricsForTest();
    const now = new Date('2026-04-10T12:00:00.000Z').getTime();

    recordCounter('admin.login.failure', now - 61 * 60 * 1000);
    recordCounter('admin.login.failure', now - 10 * 60 * 1000);
    recordCounter('admin.login.failure', now - 2 * 60 * 1000);

    const summary = getOperationalMetricsSummary(now);

    expect(summary.auth.adminLoginFailures).toEqual({
      total: 3,
      lastHour: 2,
      last15Minutes: 2,
      last5Minutes: 1
    });
  });

  it('tracks rolling latency summaries for critical list endpoints', () => {
    resetOperationalMetricsForTest();
    const now = new Date('2026-04-10T12:00:00.000Z').getTime();

    recordLatency('api.attendance.list', 90, now - 70 * 60 * 1000);
    recordLatency('api.attendance.list', 40, now - 20 * 60 * 1000);
    recordLatency('api.attendance.list', 60, now - 5 * 60 * 1000);

    const summary = getOperationalMetricsSummary(now);

    expect(summary.api.attendanceListLatency).toMatchObject({
      totalCount: 3,
      avgMs: 63.33,
      maxMs: 90,
      minMs: 40,
      lastHour: {
        count: 2,
        avgMs: 50,
        maxMs: 60,
        minMs: 40,
        latestMs: 60
      }
    });
  });
});
