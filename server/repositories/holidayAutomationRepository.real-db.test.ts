import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import { employees, holidays, salaryRecords, temporaryAttendance } from '@shared/schema';

let db: typeof import('../db').db;
let repo: typeof import('./holidayAutomationRepository').holidayAutomationRepository;
let planNationalHolidayMarks: typeof import('../services/holidayAutomation').planNationalHolidayMarks;

// 用遠在未來的年份，不碰到任何真實資料。
const TEST_YEAR = 2099;
const employeeIds: number[] = [];

async function createEmployee(name: string, idNumber: string) {
  const [row] = await db.insert(employees).values({ name, idNumber, active: true }).returning();
  employeeIds.push(row.id);
  return row;
}

async function cleanup() {
  if (employeeIds.length === 0) return;
  await db.delete(temporaryAttendance).where(inArray(temporaryAttendance.employeeId, employeeIds));
  await db.delete(holidays).where(inArray(holidays.employeeId, employeeIds));
  await db.delete(salaryRecords).where(inArray(salaryRecords.employeeId, employeeIds));
  await db.delete(employees).where(inArray(employees.id, employeeIds));
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for holidayAutomationRepository real DB tests');
  }
  ({ db } = await import('../db'));
  ({ holidayAutomationRepository: repo } = await import('./holidayAutomationRepository'));
  ({ planNationalHolidayMarks } = await import('../services/holidayAutomation'));
});

afterAll(cleanup);

describe('holidayAutomationRepository (real database)', () => {
  it('marks a holiday with matching holiday + attendance rows, idempotently', async () => {
    const worker = await createEmployee('假日測試A', 'HOLIDAYTEST-A');
    await db.insert(temporaryAttendance).values({
      employeeId: worker.id, date: `${TEST_YEAR}/12/01`, clockIn: '08:00', clockOut: '17:00',
    });

    const context = await repo.loadMonthContext({ year: TEST_YEAR, month: 12 });
    const marks = planNationalHolidayMarks({
      target: { year: TEST_YEAR, month: 12 },
      today: `${TEST_YEAR}-12-26`,
      ...context,
      employees: context.employees.filter((e) => e.id === worker.id),
      statutoryHolidays: [{ date: `${TEST_YEAR}-12-25`, name: '行憲紀念日' }],
    });
    expect(marks).toHaveLength(1);

    expect(await repo.applyNationalHolidayMark(marks[0])).toBe('created');
    expect(await repo.applyNationalHolidayMark(marks[0])).toBe('skipped_occupied');

    const holidayRows = await db.select().from(holidays).where(eq(holidays.employeeId, worker.id));
    expect(holidayRows).toHaveLength(1);
    expect(holidayRows[0]).toMatchObject({ date: `${TEST_YEAR}-12-25`, holidayType: 'national_holiday' });

    const attendanceRows = await db.select().from(temporaryAttendance).where(eq(temporaryAttendance.employeeId, worker.id));
    const holidayAttendance = attendanceRows.find((row) => row.isHoliday);
    expect(holidayAttendance).toMatchObject({
      date: `${TEST_YEAR}-12-25`, clockIn: '--:--', clockOut: '--:--', holidayId: holidayRows[0].id, holidayType: 'national_holiday',
    });

    const after = await repo.loadMonthContext({ year: TEST_YEAR, month: 12 });
    expect(after.holidayRows.filter((row) => row.employeeId === worker.id)).toHaveLength(1);
  });

  it('skips when the date already has a slash-format attendance row', async () => {
    const worker = await createEmployee('假日測試B', 'HOLIDAYTEST-B');
    await db.insert(temporaryAttendance).values({
      employeeId: worker.id, date: `${TEST_YEAR}/10/10`, clockIn: '08:00', clockOut: '17:00',
    });
    const result = await repo.applyNationalHolidayMark({
      employeeId: worker.id, employeeName: worker.name, date: `${TEST_YEAR}-10-10`, name: '國慶日',
    });
    expect(result).toBe('skipped_occupied');
    expect(await db.select().from(holidays).where(eq(holidays.employeeId, worker.id))).toHaveLength(0);
  });

  it('never writes into a month that already has a salary record', async () => {
    const worker = await createEmployee('假日測試C', 'HOLIDAYTEST-C');
    await db.insert(salaryRecords).values({
      employeeId: worker.id, employeeName: worker.name, salaryYear: TEST_YEAR, salaryMonth: 9,
      baseSalary: 30000, grossSalary: 30000, netSalary: 30000,
    } as never);
    const result = await repo.applyNationalHolidayMark({
      employeeId: worker.id, employeeName: worker.name, date: `${TEST_YEAR}-09-28`, name: '教師節',
    });
    expect(result).toBe('skipped_settled');
    expect(await db.select().from(temporaryAttendance).where(eq(temporaryAttendance.employeeId, worker.id))).toHaveLength(0);

    const context = await repo.loadMonthContext({ year: TEST_YEAR, month: 9 });
    expect(context.settledEmployeeIds.has(worker.id)).toBe(true);
  });
});
