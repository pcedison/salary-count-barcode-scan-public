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
