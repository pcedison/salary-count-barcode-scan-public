import { afterEach, describe, expect, it, vi } from 'vitest';
const run = vi.hoisted(() => vi.fn());
vi.mock('../services/monthlySalaryAutomation', () => ({ runMonthlySalaryAutomation: run, shouldRunMonthlySalaryAutomation: () => true }));
const gate = vi.hoisted(() => vi.fn());
vi.mock('./prepayroll-review', () => ({ runPrepayrollReviewGate: gate }));
import { runScheduledMonthlySalaryAutomation, startMonthlySalaryScheduler, stopMonthlySalaryScheduler } from './monthly-salary-scheduler';

afterEach(() => { stopMonthlySalaryScheduler(); vi.unstubAllEnvs(); vi.restoreAllMocks(); run.mockReset(); gate.mockReset(); });
const proceed = { proceed: true, reason: 'clear', target: { year: 2026, month: 11 } };
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
    gate.mockResolvedValue(proceed);
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

describe('pre-payroll review gate', () => {
  it('does not run payroll while the month waits for review', async () => {
    gate.mockResolvedValue({ proceed: false, reason: 'awaiting_review', target: { year: 2026, month: 11 }, findingCount: 3, notified: true });
    const outcome = await runScheduledMonthlySalaryAutomation(new Date(), { trigger: 'cron' });
    expect(outcome).toEqual({ ran: false, reason: 'awaiting_review', target: { year: 2026, month: 11 } });
    expect(run).not.toHaveBeenCalled();
  });

  it('runs payroll once the gate lets it through', async () => {
    gate.mockResolvedValue({ ...proceed, reason: 'confirmed' });
    run.mockResolvedValue({ status: 'succeeded', target: { year: 2026, month: 11 }, persistedRecords: [], skippedEmployees: [] });
    await runScheduledMonthlySalaryAutomation(new Date(), { trigger: 'cron' });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
