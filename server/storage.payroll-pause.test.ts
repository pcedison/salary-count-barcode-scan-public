import { afterEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ transaction: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() }));
vi.mock('./db', () => ({ db }));
import { storage } from './storage';
import { salaryRepository } from './repositories/salaryRepository';
import { DatabaseEmployeeRepository } from './repositories/employeeRepository';
const employeeRepository = new DatabaseEmployeeRepository();
import { monthlySalaryRunRepository } from './repositories/monthlySalaryRunRepository';

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('salary repository maintenance guard', () => {
  it('rejects direct writes before opening a transaction or changing any table', async () => {
    vi.stubEnv('PAYROLL_WRITES_PAUSED', 'true');
    const writes = [
      () => salaryRepository.createSalaryRecord({} as never),
      () => salaryRepository.updateSalaryRecord(101, { netSalary: 123 }),
      () => salaryRepository.deleteSalaryRecord(101),
      () => salaryRepository.commitSalaryCorrection(101, {} as never, () => { throw new Error('must not build'); }),
      () => monthlySalaryRunRepository.createMonthlySalaryRun({} as never),
      () => monthlySalaryRunRepository.updateMonthlySalaryRun(101, { status: 'running' }),
      () => salaryRepository.saveSalaryRecordsAtomically([]),
      () => monthlySalaryRunRepository.acquireRun({} as never),
      () => employeeRepository.purgeEmployee(101),
      () => employeeRepository.purgeExpiredDeletedEmployees(),
      () => storage.purgeEmployee(101),
      () => storage.purgeExpiredDeletedEmployees(),
      () => salaryRepository.purgeExpiredRetainedSalaryRecords(),
    ];
    for (const write of writes) await expect(write()).rejects.toMatchObject({ status: 503, code: 'PAYROLL_WRITES_PAUSED' });
    for (const method of Object.values(db)) expect(method).not.toHaveBeenCalled();
  });
});
