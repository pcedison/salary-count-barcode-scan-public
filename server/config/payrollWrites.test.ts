import { afterEach, describe, expect, it, vi } from 'vitest';
import { arePayrollWritesPaused, assertMaintenanceStartup } from './payrollWrites';

afterEach(() => vi.unstubAllEnvs());

describe('compatible maintenance startup', () => {
  it.each([undefined, '', 'false', '0', 'yes', 'TRUE', ' true '])('refuses production without exact true (%s)', value => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYROLL_WRITES_PAUSED', value);
    expect(assertMaintenanceStartup).toThrow('PAYROLL_WRITES_PAUSED=true');
    expect(arePayrollWritesPaused).toThrow('PAYROLL_WRITES_PAUSED=true');
  });
  it('allows production only with true', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYROLL_WRITES_PAUSED', 'true');
    expect(assertMaintenanceStartup).not.toThrow();
    expect(arePayrollWritesPaused()).toBe(true);
  });
  it('treats misspelled configured pause as paused', () => {
    vi.stubEnv('PAYROLL_WRITES_PAUSED', 'ture');
    expect(arePayrollWritesPaused()).toBe(true);
  });
});
