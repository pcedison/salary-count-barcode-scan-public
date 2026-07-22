import { describe, expect, it } from 'vitest';

import {
  buildFinalizedSalaryMonthKeys,
  buildSpecialLeaveCashRecords,
  enhanceAttendanceRecords,
  filterFinalizedAttendance,
  getAttendanceSortValue,
  getEmployeeMonthKey,
  getSpecialLeaveInfoForMonth,
  parseAttendanceDateParts,
  sortAttendanceNewestFirst,
  toMonthKey,
} from './attendanceEnhancement';

const employee = {
  id: 9,
  name: '王小明',
  department: '生產部',
  specialLeaveUsedDates: ['2026/04/10', '2026-04-12', '2026/05/01'],
  specialLeaveCashDays: 2,
  specialLeaveCashMonth: '2026-04',
  specialLeaveNotes: '備註',
};

describe('toMonthKey', () => {
  it('normalizes both date formats to a YYYY-MM key', () => {
    expect(toMonthKey('2026/04/09')).toBe('2026-04');
    expect(toMonthKey('2026-4-9')).toBe('2026-04');
    expect(toMonthKey('garbage')).toBeNull();
    expect(toMonthKey('')).toBeNull();
  });
});

describe('parseAttendanceDateParts', () => {
  it('parses slash and dash dates', () => {
    expect(parseAttendanceDateParts('2026/04/09')).toEqual({ year: 2026, month: 4, day: 9 });
    expect(parseAttendanceDateParts('2026-4-9')).toEqual({ year: 2026, month: 4, day: 9 });
  });

  it('returns null for unparseable dates', () => {
    expect(parseAttendanceDateParts('not-a-date')).toBeNull();
    expect(parseAttendanceDateParts(undefined)).toBeNull();
  });
});

describe('finalized month filtering', () => {
  it('hides attendance for employee-months that already have a salary record', () => {
    const keys = buildFinalizedSalaryMonthKeys([
      { employeeId: 9, salaryYear: 2026, salaryMonth: 4 },
      { employeeId: null, salaryYear: 2026, salaryMonth: 4 },
    ]);

    expect(keys.has(getEmployeeMonthKey(9, 2026, 4))).toBe(true);
    expect(keys.size).toBe(1);

    const records = [
      { id: 1, employeeId: 9, date: '2026/04/09', clockIn: '09:00', clockOut: '18:00', isHoliday: false },
      { id: 2, employeeId: 9, date: '2026/05/02', clockIn: '09:00', clockOut: '18:00', isHoliday: false },
      { id: 3, date: '2026/04/09', clockIn: '09:00', clockOut: '18:00', isHoliday: false },
    ];

    expect(filterFinalizedAttendance(records, keys).map((r) => r.id)).toEqual([2, 3]);
  });
});

describe('enhanceAttendanceRecords', () => {
  it('attaches employee metadata and holiday labels', () => {
    const [enhanced] = enhanceAttendanceRecords(
      [{ id: 1, employeeId: 9, date: '2026/04/09', clockIn: '--:--', clockOut: '--:--', isHoliday: true, holidayType: 'national_holiday' }],
      [employee]
    );

    expect(enhanced._employeeName).toBe('王小明');
    expect(enhanced._employeeDepartment).toBe('生產部');
    expect(enhanced._isLeaveRecord).toBe(true);
    expect(enhanced._isNoClockType).toBe(true);
    expect(enhanced._holidayName).toBe('國定假日');
  });

  it('marks clock-required leave types as clockable', () => {
    const [enhanced] = enhanceAttendanceRecords(
      [{ id: 1, employeeId: 9, date: '2026/04/09', clockIn: '09:00', clockOut: '18:00', isHoliday: true, holidayType: 'worked' }],
      [employee]
    );

    expect(enhanced._isNoClockType).toBe(false);
    expect(enhanced._holidayName).toBe('假日出勤');
  });
});

describe('buildSpecialLeaveCashRecords', () => {
  it('creates a synthetic cash record for the configured month', () => {
    const [record] = buildSpecialLeaveCashRecords([employee], new Set(), 30000);

    expect(record.employeeId).toBe(9);
    expect(record._isSpecialLeaveCashRecord).toBe(true);
    expect(record._specialLeaveCashDays).toBe(2);
    expect(record._specialLeaveCashAmount).toBe(2 * Math.round(30000 / 30));
    expect(record._displayDate).toBe('2026/04');
    expect(record.id).toBeLessThan(0);
  });

  it('skips employees whose cash month is already finalized', () => {
    const finalized = new Set([getEmployeeMonthKey(9, 2026, 4)]);

    expect(buildSpecialLeaveCashRecords([employee], finalized, 30000)).toEqual([]);
  });
});

describe('getSpecialLeaveInfoForMonth', () => {
  it('collects used dates for the month and cash conversion', () => {
    const info = getSpecialLeaveInfoForMonth(employee, 2026, 4, 30000);

    expect(info).toEqual({
      usedDays: 2,
      usedDates: ['2026-04-10', '2026-04-12'],
      cashDays: 2,
      cashAmount: 2 * Math.round(30000 / 30),
      cashMonth: '2026-04',
      notes: '備註',
    });
  });

  it('returns null when the month has no special leave activity', () => {
    expect(getSpecialLeaveInfoForMonth(employee, 2026, 6, 30000)).toBeNull();
  });
});

describe('sortAttendanceNewestFirst', () => {
  it('sorts by date desc then id desc', () => {
    const sorted = sortAttendanceNewestFirst([
      { id: 1, date: '2026/04/09', clockIn: '', clockOut: '', isHoliday: false },
      { id: 3, date: '2026/04/10', clockIn: '', clockOut: '', isHoliday: false },
      { id: 2, date: '2026/04/10', clockIn: '', clockOut: '', isHoliday: false },
    ]);

    expect(sorted.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(getAttendanceSortValue({ date: '2026/04/10' })).toBe(20260410);
  });
});
