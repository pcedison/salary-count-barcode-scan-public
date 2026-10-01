import { afterEach, describe, expect, it, vi } from 'vitest';
import { salaryRepository } from './repositories/salaryRepository';
import { monthlySalaryRunRepository } from './repositories/monthlySalaryRunRepository';
import { DatabaseEmployeeRepository } from './repositories/employeeRepository';
import { storage } from './storage';
import { runEmployeeRetentionCycle, startEmployeeRetentionScheduler } from './employee-retention';
import { runMonthlySalaryAutomation } from './services/monthlySalaryAutomation';
import { runScheduledMonthlySalaryAutomation, startMonthlySalaryScheduler } from './runtime/monthly-salary-scheduler';
import { createDatabaseBackup, restoreFromBackup, rehearseRestoreFromBackup, deleteBackup, setupAutomaticBackups } from './db-monitoring';
import { db } from './db';

vi.mock('./db', () => {
  const unexpected = vi.fn(() => { throw new Error('guard contacted database'); });
  return { db: { select: unexpected, insert: unexpected, update: unexpected, delete: unexpected, transaction: unexpected, execute: unexpected } };
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('maintenance direct writer protection', () => {
  const employeeRepository = new DatabaseEmployeeRepository();
  const writers: [string, () => Promise<unknown>][] = [
    ['salary create', () => salaryRepository.createSalaryRecord({} as any)],
    ['salary update', () => salaryRepository.updateSalaryRecord(1, {})],
    ['salary atomic insert', () => salaryRepository.saveSalaryRecordsAtomically([{ record: {} as any }])],
    ['salary atomic update', () => salaryRepository.saveSalaryRecordsAtomically([{ existingId: 1, record: {} as any }])],
    ['salary atomic empty', () => salaryRepository.saveSalaryRecordsAtomically([])],
    ['salary delete', () => salaryRepository.deleteSalaryRecord(1)],
    ['salary retention purge', () => salaryRepository.purgeExpiredRetainedSalaryRecords()],
    ['employee direct purge', () => employeeRepository.purgeEmployee(1)],
    ['employee direct retention', () => employeeRepository.purgeExpiredDeletedEmployees()],
    ['storage purge', () => storage.purgeEmployee(1)],
    ['storage retention', () => storage.purgeExpiredDeletedEmployees()],
    ['automation acquire', () => monthlySalaryRunRepository.acquireRun({} as any)],
    ['automation create', () => monthlySalaryRunRepository.createMonthlySalaryRun({} as any)],
    ['automation update', () => monthlySalaryRunRepository.updateMonthlySalaryRun(1, {})],
    ['automation run', () => runMonthlySalaryAutomation()],
    ['automation dry run', () => runMonthlySalaryAutomation({ dryRun: true })],
  ];
  it.each(writers)('blocks %s before database access', async (_name, write) => {
    vi.stubEnv('PAYROLL_WRITES_PAUSED', 'true');
    await expect(write()).rejects.toMatchObject({ status: 503, code: 'PAYROLL_WRITES_PAUSED' });
    for (const method of Object.values(db)) if (typeof method === 'function') expect(method).not.toHaveBeenCalled();
  });
  it.each([
    ['create backup', () => createDatabaseBackup()],
    ['restore backup', () => restoreFromBackup('missing')],
    ['restore skipping safeguard', () => restoreFromBackup('missing', undefined, { skipPreRestoreBackup: true })],
    ['rehearse restore', () => rehearseRestoreFromBackup('missing')],
    ['delete backup', () => deleteBackup('missing')],
  ] as const)('blocks %s before filesystem/database access', async (_name, write) => {
    vi.stubEnv('PAYROLL_WRITES_PAUSED', 'true');
    await expect(write()).rejects.toMatchObject({ status: 503, code: 'MAINTENANCE_BACKUP_READ_ONLY' });
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('does not start destructive background jobs', async () => {
    vi.stubEnv('PAYROLL_WRITES_PAUSED', 'true');
    expect(setupAutomaticBackups()).toBeNull();
    expect(startEmployeeRetentionScheduler()).toBeNull();
    expect(await runEmployeeRetentionCycle()).toEqual({ purgedEmployeeIds: [], anonymizedSalaryRecords: 0, purgedSalaryRecords: 0 });
    const scheduler = startMonthlySalaryScheduler();
    await runScheduledMonthlySalaryAutomation();
    scheduler.stop();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });
});
