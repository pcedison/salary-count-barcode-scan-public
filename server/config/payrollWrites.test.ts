import { afterEach, describe, expect, it, vi } from 'vitest';
import { arePayrollWritesPaused, assertPayrollWritesEnabled, assertRestoreMaintenance, PayrollWritesPausedError } from './payrollWrites';

afterEach(() => vi.unstubAllEnvs());
describe('payroll maintenance switch', () => {
  it('requires production recovery to pause writers', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYROLL_WRITES_PAUSED', 'false');
    expect(assertRestoreMaintenance).toThrow();
    vi.stubEnv('PAYROLL_WRITES_PAUSED', 'true');
    expect(assertRestoreMaintenance).not.toThrow();
  });
  it.each([undefined, '', 'false', '0', ' FALSE '])('permits normal operation for %s', value => {
    vi.stubEnv('PAYROLL_WRITES_PAUSED', value);
    expect(arePayrollWritesPaused()).toBe(false);
    expect(assertPayrollWritesEnabled).not.toThrow();
  });
  it.each(['true', '1', ' TRUE ', 'tru'])('fails closed for %s', value => {
    vi.stubEnv('PAYROLL_WRITES_PAUSED', value);
    expect(arePayrollWritesPaused()).toBe(true);
    expect(assertPayrollWritesEnabled).toThrow(PayrollWritesPausedError);
  });
});
