import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';

const runScheduledMock = vi.hoisted(() => vi.fn());

vi.mock('../runtime/monthly-salary-scheduler', () => ({
  runScheduledMonthlySalaryAutomation: runScheduledMock,
}));

const SECRET = 'cron-secret-'.padEnd(48, 'x');

let registerSalaryAutomationCronRoutes: typeof import('./salaryAutomationCron.routes').registerSalaryAutomationCronRoutes;

beforeAll(async () => {
  ({ registerSalaryAutomationCronRoutes } = await import('./salaryAutomationCron.routes'));
});

beforeEach(() => {
  runScheduledMock.mockReset();
  process.env.SALARY_AUTOMATION_CRON_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.SALARY_AUTOMATION_CRON_SECRET;
});

describe('salary automation cron tick', () => {
  it('runs the scheduled automation inside the request when authorised', async () => {
    runScheduledMock.mockResolvedValue({ ran: true, status: 'succeeded', target: { year: 2026, month: 11 } });
    const server = await createJsonTestServer(registerSalaryAutomationCronRoutes);
    try {
      const result = await jsonRequest<Record<string, unknown>>(server.baseUrl, '/api/salary-automation/cron-tick', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      expect(result.response.status).toBe(200);
      expect(result.body).toEqual({ ran: true, status: 'succeeded', target: { year: 2026, month: 11 } });
      expect(runScheduledMock).toHaveBeenCalledTimes(1);
      expect(runScheduledMock).toHaveBeenCalledWith(expect.any(Date), { trigger: 'cron' });
    } finally {
      await server.close();
    }
  });

  it('rejects requests without the secret and never runs the automation', async () => {
    const server = await createJsonTestServer(registerSalaryAutomationCronRoutes);
    try {
      const noHeader = await jsonRequest(server.baseUrl, '/api/salary-automation/cron-tick', { method: 'POST' });
      expect(noHeader.response.status).toBe(401);
      const wrong = await jsonRequest(server.baseUrl, '/api/salary-automation/cron-tick', {
        method: 'POST',
        headers: { Authorization: 'Bearer nope' },
      });
      expect(wrong.response.status).toBe(401);
      expect(runScheduledMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('stays closed when the secret is not configured', async () => {
    delete process.env.SALARY_AUTOMATION_CRON_SECRET;
    const server = await createJsonTestServer(registerSalaryAutomationCronRoutes);
    try {
      const result = await jsonRequest(server.baseUrl, '/api/salary-automation/cron-tick', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      expect(result.response.status).toBe(401);
      expect(runScheduledMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('returns 500 without details when the automation throws', async () => {
    runScheduledMock.mockRejectedValue(new Error('db down'));
    const server = await createJsonTestServer(registerSalaryAutomationCronRoutes);
    try {
      const result = await jsonRequest<Record<string, unknown>>(server.baseUrl, '/api/salary-automation/cron-tick', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      expect(result.response.status).toBe(500);
      expect(result.body).toEqual({ code: 'cron_tick_failed' });
    } finally {
      await server.close();
    }
  });
});
