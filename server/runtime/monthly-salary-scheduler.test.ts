import { afterEach, describe, expect, it, vi } from 'vitest';
const run = vi.hoisted(() => vi.fn());
vi.mock('../services/monthlySalaryAutomation', () => ({ runMonthlySalaryAutomation: run, shouldRunMonthlySalaryAutomation: () => true }));
import { runScheduledMonthlySalaryAutomation, startMonthlySalaryScheduler, stopMonthlySalaryScheduler } from './monthly-salary-scheduler';

afterEach(() => { stopMonthlySalaryScheduler(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('disabled salary worker role', () => {
  it('cannot start startup ticks, timers or directly scheduled salary writes', async () => {
    vi.stubEnv('APP_BACKGROUND_SERVICES', 'disabled'); vi.stubEnv('SALARY_AUTOMATION_ENABLED', 'true');
    const timer = vi.spyOn(globalThis, 'setInterval');
    startMonthlySalaryScheduler().stop(); await runScheduledMonthlySalaryAutomation();
    expect(run).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled();
  });
});

describe('external cron trigger', () => {
  it('runs payroll from the cron route even when in-process background services are off', async () => {
    vi.stubEnv('APP_BACKGROUND_SERVICES', 'disabled');
    run.mockResolvedValue({ status: 'succeeded', target: { year: 2026, month: 11 }, persistedRecords: [], skippedEmployees: [] });
    const outcome = await runScheduledMonthlySalaryAutomation(new Date(), { trigger: 'cron' });
    expect(outcome).toEqual({ ran: true, status: 'succeeded', reason: undefined, target: { year: 2026, month: 11 } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reports background_disabled for in-process calls', async () => {
    vi.stubEnv('APP_BACKGROUND_SERVICES', 'disabled');
    expect(await runScheduledMonthlySalaryAutomation()).toEqual({ ran: false, reason: 'background_disabled' });
  });
});
