import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import {
  salaryRecords,
  type Employee,
  type TemporaryAttendance
} from '@shared/schema';

import {
  EMPLOYEE_RECYCLE_RETENTION_DAYS,
  SALARY_RETENTION_POLICY,
  SALARY_RETENTION_YEARS
} from './config/retentionPolicy';

let storage: typeof import('./storage').storage;
let db: typeof import('./db').db;
let runEmployeeRetentionCycle: typeof import('./employee-retention').runEmployeeRetentionCycle;

const TEST_PREFIX = `__retention_${Date.now()}`;
const ANONYMIZED_EMPLOYEE_NAME = '[ANONYMIZED EMPLOYEE - RETAIN 5 YEARS]';

const trackedEmployeeIds = new Set<number>();
const trackedSalaryRecordIds = new Set<number>();
const trackedHolidayIds = new Set<number>();
const trackedAttendanceIds = new Set<number>();

function buildIdNumber(suffix: string): string {
  return `${TEST_PREFIX}_${suffix}`;
}

function buildLineUserId(suffix: string): string {
  return `U${TEST_PREFIX.replace(/[^a-zA-Z0-9]/g, '').slice(-18)}${suffix}`;
}

function addYears(base: Date, years: number): Date {
  const next = new Date(base);
  next.setFullYear(next.getFullYear() + years);
  return next;
}

async function hardCleanupEmployee(employeeId: number): Promise<void> {
  try {
    await storage.deleteEmployee(employeeId, 'retention-test-cleanup');
  } catch {
    // ignore cleanup failures
  }

  try {
    await storage.purgeEmployee(employeeId);
  } catch {
    // ignore cleanup failures
  }
}

async function cleanup(): Promise<void> {
  for (const attendanceId of trackedAttendanceIds) {
    try {
      await storage.deleteTemporaryAttendance(attendanceId);
    } catch {
      // ignore cleanup failures
    }
  }

  for (const holidayId of trackedHolidayIds) {
    try {
      await storage.deleteHoliday(holidayId);
    } catch {
      // ignore cleanup failures
    }
  }

  for (const employeeId of trackedEmployeeIds) {
    await hardCleanupEmployee(employeeId);
  }

  for (const salaryRecordId of trackedSalaryRecordIds) {
    try {
      await storage.deleteSalaryRecord(salaryRecordId);
    } catch {
      // ignore cleanup failures
    }
  }
}

function expectTimestampWithinRange(
  value: Date | null | undefined,
  lowerBound: number,
  upperBound: number
): void {
  expect(value).toBeInstanceOf(Date);
  const actual = value!.getTime();
  expect(actual).toBeGreaterThanOrEqual(lowerBound);
  expect(actual).toBeLessThanOrEqual(upperBound);
}

async function createSalaryRecordForEmployee(
  employee: Employee,
  attendanceSnapshot: TemporaryAttendance[]
) {
  const salaryRecord = await storage.createSalaryRecord({
    salaryYear: 2099,
    salaryMonth: employee.id % 12 + 1,
    employeeId: employee.id,
    employeeName: employee.name,
    baseSalary: 32000,
    housingAllowance: 1500,
    welfareAllowance: 500,
    totalOT1Hours: 2,
    totalOT2Hours: 1,
    totalOvertimePay: 900,
    holidayDays: 1,
    holidayDailySalary: 1200,
    totalHolidayPay: 1200,
    grossSalary: 36100,
    deductions: [{ name: '勞保', amount: 250 }],
    allowances: [{ name: '餐費', amount: 200 }],
    totalDeductions: 250,
    netSalary: 35850,
    attendanceData: attendanceSnapshot
  });

  trackedSalaryRecordIds.add(salaryRecord.id);
  return salaryRecord;
}

beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for retention real DB tests');
  }

  process.env.PGSSLREJECT_UNAUTHORIZED ??= 'false';
});

afterAll(async () => {
  await cleanup();
});

beforeAll(async () => {
  ({ storage } = await import('./storage'));
  ({ db } = await import('./db'));
  ({ runEmployeeRetentionCycle } = await import('./employee-retention'));
});

describe('real database - retention lifecycle', () => {
  it('soft deletes employees into the recycle bin, clears LINE bindings, removes pending bindings, and restores unbound', async () => {
    const boundLineUserId = buildLineUserId('BOUND');
    const pendingLineUserId = buildLineUserId('PENDING');

    const employee = await storage.createEmployee({
      name: `${TEST_PREFIX}_recycle_employee`,
      idNumber: buildIdNumber('RECYCLE'),
      employeeType: 'local',
      position: '作業員',
      department: '測試部',
      active: true,
      lineUserId: boundLineUserId,
      lineDisplayName: 'Bound User',
      linePictureUrl: 'https://example.com/bound.png',
      lineBindingDate: new Date('2026-04-08T00:00:00.000Z')
    });
    trackedEmployeeIds.add(employee.id);

    const pendingBinding = await storage.createPendingBinding({
      employeeId: employee.id,
      lineUserId: pendingLineUserId,
      lineDisplayName: 'Pending User',
      status: 'pending',
      requestedAt: new Date('2026-04-08T01:00:00.000Z')
    });

    const deleted = await storage.deleteEmployee(employee.id, 'retention-real-db-test');
    expect(deleted).toBe(true);

    const activeLookup = await storage.getEmployeeById(employee.id);
    expect(activeLookup).toBeUndefined();

    const deletedEmployee = await storage.getEmployeeByIdIncludingDeleted(employee.id);
    expect(deletedEmployee).toBeDefined();
    expect(deletedEmployee).toMatchObject({
      id: employee.id,
      deletedBy: 'retention-real-db-test',
      lineUserId: null,
      lineDisplayName: null,
      linePictureUrl: null,
      lineBindingDate: null
    });
    expect(deletedEmployee?.deletedAt).toBeInstanceOf(Date);
    expect(deletedEmployee?.purgeAfterAt).toBeInstanceOf(Date);

    const deletedAt = deletedEmployee!.deletedAt!;
    const purgeAfterAt = deletedEmployee!.purgeAfterAt!;
    const expectedLowerBound = deletedAt.getTime() + (EMPLOYEE_RECYCLE_RETENTION_DAYS - 1) * 24 * 60 * 60 * 1000;
    const expectedUpperBound = deletedAt.getTime() + (EMPLOYEE_RECYCLE_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
    expectTimestampWithinRange(purgeAfterAt, expectedLowerBound, expectedUpperBound);

    const recycleBinList = await storage.getDeletedEmployees();
    expect(recycleBinList.some((candidate) => candidate.id === employee.id)).toBe(true);

    expect(await storage.getEmployeeByLineUserId(boundLineUserId)).toBeUndefined();
    expect(await storage.getPendingBindingById(pendingBinding.id)).toBeUndefined();
    expect(await storage.getPendingBindingByLineUserId(pendingLineUserId)).toBeUndefined();

    const restored = await storage.restoreEmployee(employee.id);
    expect(restored).toBeDefined();
    expect(restored).toMatchObject({
      id: employee.id,
      deletedAt: null,
      deletedBy: null,
      purgeAfterAt: null,
      lineUserId: null,
      lineDisplayName: null,
      linePictureUrl: null,
      lineBindingDate: null
    });

    const restoredActiveEmployee = await storage.getEmployeeById(employee.id);
    expect(restoredActiveEmployee).toBeDefined();
    expect(restoredActiveEmployee?.lineUserId).toBeNull();
  });

  it('purges soft-deleted employees, deletes dependent holiday/attendance rows, and anonymizes salary records for 5-year retention', async () => {
    const employee = await storage.createEmployee({
      name: `${TEST_PREFIX}_purge_employee`,
      idNumber: buildIdNumber('PURGE'),
      employeeType: 'foreign',
      position: '技術員',
      department: '製造部',
      active: true
    });
    trackedEmployeeIds.add(employee.id);

    const holiday = await storage.createHoliday({
      employeeId: employee.id,
      date: '2099/06/15',
      name: `${TEST_PREFIX}_holiday`,
      holidayType: 'special_leave'
    });
    trackedHolidayIds.add(holiday.id);

    const attendance = await storage.createTemporaryAttendance({
      employeeId: employee.id,
      date: '2099/06/15',
      clockIn: '08:00',
      clockOut: '17:00',
      isHoliday: true,
      isBarcodeScanned: false,
      holidayId: holiday.id,
      holidayType: 'special_leave'
    });
    trackedAttendanceIds.add(attendance.id);

    const salaryRecord = await createSalaryRecordForEmployee(employee, [attendance]);

    const deleted = await storage.deleteEmployee(employee.id, 'retention-purge-test');
    expect(deleted).toBe(true);

    const deletedEmployee = await storage.getEmployeeByIdIncludingDeleted(employee.id);
    expect(deletedEmployee?.deletedAt).toBeInstanceOf(Date);

    const purgeResult = await storage.purgeEmployee(employee.id);
    expect(purgeResult).toEqual({
      purged: true,
      anonymizedSalaryRecords: 1
    });

    expect(await storage.getEmployeeByIdIncludingDeleted(employee.id)).toBeUndefined();
    expect(await storage.getHolidayById(holiday.id)).toBeUndefined();
    expect(await storage.getTemporaryAttendanceById(attendance.id)).toBeUndefined();

    trackedHolidayIds.delete(holiday.id);
    trackedAttendanceIds.delete(attendance.id);
    trackedEmployeeIds.delete(employee.id);

    const anonymizedRecord = await storage.getSalaryRecordById(salaryRecord.id);
    expect(anonymizedRecord).toBeDefined();
    expect(anonymizedRecord).toMatchObject({
      id: salaryRecord.id,
      employeeId: null,
      employeeName: ANONYMIZED_EMPLOYEE_NAME
    });
    expect(anonymizedRecord?.anonymizedAt).toBeInstanceOf(Date);
    expect(anonymizedRecord?.retentionUntil).toBeInstanceOf(Date);
    expect(anonymizedRecord?.employeeSnapshot).toMatchObject({
      employeeType: 'foreign',
      department: '製造部',
      position: '技術員',
      deletedBy: 'retention-purge-test',
      retentionYears: SALARY_RETENTION_YEARS,
      retentionPolicy: SALARY_RETENTION_POLICY
    });

    const expectedRetentionUntil = addYears(deletedEmployee!.deletedAt!, SALARY_RETENTION_YEARS).getTime();
    expectTimestampWithinRange(
      anonymizedRecord!.retentionUntil,
      expectedRetentionUntil - 5_000,
      expectedRetentionUntil + 5_000
    );

    const attendanceSnapshot = anonymizedRecord!.attendanceData as TemporaryAttendance[] | null;
    expect(Array.isArray(attendanceSnapshot)).toBe(true);
    expect(attendanceSnapshot).toHaveLength(1);
    expect(attendanceSnapshot?.[0]).toMatchObject({
      id: attendance.id,
      holidayId: holiday.id,
      employeeId: null
    });
  });

  it('deletes expired anonymized salary records when the retention scheduler runs', async () => {
    const employee = await storage.createEmployee({
      name: `${TEST_PREFIX}_expired_salary_employee`,
      idNumber: buildIdNumber('EXPIRED_SALARY'),
      employeeType: 'local',
      position: 'Retention QA',
      department: 'Retention QA',
      active: true
    });
    trackedEmployeeIds.add(employee.id);

    const salaryRecord = await createSalaryRecordForEmployee(employee, []);

    const deleted = await storage.deleteEmployee(employee.id, 'retention-expired-salary-test');
    expect(deleted).toBe(true);

    const purgeResult = await storage.purgeEmployee(employee.id);
    expect(purgeResult).toEqual({
      purged: true,
      anonymizedSalaryRecords: 1
    });

    trackedEmployeeIds.delete(employee.id);

    const expiredAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db
      .update(salaryRecords)
      .set({
        anonymizedAt: expiredAt,
        retentionUntil: expiredAt
      })
      .where(eq(salaryRecords.id, salaryRecord.id));

    const anonymizedBeforeCleanup = await storage.getSalaryRecordById(salaryRecord.id);
    expect(anonymizedBeforeCleanup).toBeDefined();
    expect(anonymizedBeforeCleanup?.employeeId).toBeNull();
    expect(anonymizedBeforeCleanup?.retentionUntil).toBeInstanceOf(Date);

    const cleanupResult = await runEmployeeRetentionCycle();

    expect(cleanupResult.purgedEmployeeIds).toEqual([]);
    expect(cleanupResult.anonymizedSalaryRecords).toBe(0);
    expect(cleanupResult.purgedSalaryRecords).toBeGreaterThanOrEqual(1);
    expect(await storage.getSalaryRecordById(salaryRecord.id)).toBeUndefined();

    trackedSalaryRecordIds.delete(salaryRecord.id);
  });

});
