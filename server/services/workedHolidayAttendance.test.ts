import { describe, expect, it, vi } from 'vitest';

import type { Holiday, TemporaryAttendance } from '@shared/schema';

import {
  findWorkedHoliday,
  hasWorkedHolidayOn,
  isUntouchedWorkedPlaceholder,
  markExistingAttendanceAsWorked,
  placeholderToClockIn,
  revertAttendanceForDeletedWorkedHoliday,
  type WorkedHolidayAttendanceStore
} from './workedHolidayAttendance';

function holiday(overrides: Partial<Holiday> = {}): Holiday {
  return {
    id: 1,
    employeeId: 7,
    date: '2026/11/14',
    name: '一般休息日加班',
    holidayType: 'worked',
    ...overrides
  } as Holiday;
}

function row(overrides: Partial<TemporaryAttendance> = {}): TemporaryAttendance {
  return {
    id: 100,
    employeeId: 7,
    date: '2026/11/14',
    clockIn: '07:55',
    clockOut: '19:02',
    isHoliday: false,
    isBarcodeScanned: true,
    holidayId: null,
    holidayType: null,
    createdAt: null,
    ...overrides
  } as TemporaryAttendance;
}

function createStore(rows: TemporaryAttendance[], holidays: Holiday[] = []) {
  const store = {
    getAllHolidays: vi.fn(async () => holidays),
    getTemporaryAttendanceByEmployeeAndDate: vi.fn(async (employeeId: number) =>
      rows.filter((item) => item.employeeId === employeeId)
    ),
    updateTemporaryAttendance: vi.fn(async (id: number, patch: Partial<TemporaryAttendance>) => {
      const target = rows.find((item) => item.id === id);
      if (target) Object.assign(target, patch);
      return target;
    })
  };
  return store satisfies WorkedHolidayAttendanceStore;
}

describe('markExistingAttendanceAsWorked', () => {
  it('marks the real clock-in row on that date as 假日出勤 without giving it the holiday id', async () => {
    const rows = [row()];
    const store = createStore(rows);

    await expect(markExistingAttendanceAsWorked(holiday(), store)).resolves.toBe(1);

    expect(store.updateTemporaryAttendance).toHaveBeenCalledWith(100, { holidayType: 'worked', isHoliday: true });
    expect(rows[0]).toMatchObject({ holidayType: 'worked', isHoliday: true, holidayId: null });
  });

  it('marks a clock-in that has not clocked out yet', async () => {
    const store = createStore([row({ clockOut: '' })]);
    await expect(markExistingAttendanceAsWorked(holiday(), store)).resolves.toBe(1);
  });

  it('matches dash-formatted attendance dates', async () => {
    const store = createStore([row({ date: '2026-11-14' })]);
    await expect(markExistingAttendanceAsWorked(holiday(), store)).resolves.toBe(1);
  });

  it('leaves rows that already have a category, belong to a holiday entry, or have no clock times', async () => {
    const store = createStore([
      row({ id: 1, holidayType: 'sick_leave' }),
      row({ id: 2, holidayId: 9, holidayType: 'personal_leave', isBarcodeScanned: false }),
      row({ id: 3, clockIn: '--:--', clockOut: '--:--' }),
      row({ id: 4, date: '2026/11/15' })
    ]);

    await expect(markExistingAttendanceAsWorked(holiday(), store)).resolves.toBe(0);
    expect(store.updateTemporaryAttendance).not.toHaveBeenCalled();
  });

  it('does nothing for other holiday types or entries without an employee', async () => {
    const store = createStore([row()]);
    await expect(markExistingAttendanceAsWorked(holiday({ holidayType: 'sick_leave' }), store)).resolves.toBe(0);
    await expect(markExistingAttendanceAsWorked(holiday({ employeeId: null }), store)).resolves.toBe(0);
    expect(store.updateTemporaryAttendance).not.toHaveBeenCalled();
  });
});

describe('revertAttendanceForDeletedWorkedHoliday', () => {
  it('takes the 假日出勤 mark off clock-in rows when the entry is deleted', async () => {
    const rows = [row({ holidayType: 'worked', isHoliday: true })];
    const store = createStore(rows, [holiday()]);

    await expect(revertAttendanceForDeletedWorkedHoliday(holiday(), store)).resolves.toBe(1);
    expect(rows[0]).toMatchObject({ holidayType: null, isHoliday: false });
  });

  it('keeps the mark while another 假日出勤 entry still covers that employee and date', async () => {
    const rows = [row({ holidayType: 'worked', isHoliday: true })];
    const store = createStore(rows, [holiday(), holiday({ id: 2, date: '2026-11-14' })]);

    await expect(revertAttendanceForDeletedWorkedHoliday(holiday(), store)).resolves.toBe(0);
    expect(rows[0].holidayType).toBe('worked');
  });

  it('leaves the holiday placeholder row and other categories alone', async () => {
    const store = createStore(
      [
        row({ id: 1, holidayId: 1, holidayType: 'worked', clockIn: '08:00', clockOut: '17:00', isBarcodeScanned: false }),
        row({ id: 2, holidayType: 'sick_leave' })
      ],
      [holiday()]
    );

    await expect(revertAttendanceForDeletedWorkedHoliday(holiday(), store)).resolves.toBe(0);
    expect(store.updateTemporaryAttendance).not.toHaveBeenCalled();
  });

  it('does nothing for other holiday types', async () => {
    const store = createStore([row({ holidayType: 'worked' })]);
    await expect(revertAttendanceForDeletedWorkedHoliday(holiday({ holidayType: 'special_leave' }), store)).resolves.toBe(0);
  });
});

describe('clock-in helpers', () => {
  it('finds a 假日出勤 entry for the same employee and date only', async () => {
    const holidays = [
      holiday({ id: 1, employeeId: 8 }),
      holiday({ id: 2, holidayType: 'sick_leave' }),
      holiday({ id: 3, date: '2026-11-21' })
    ];
    expect(findWorkedHoliday(holidays, 7, '2026/11/14')).toBeUndefined();
    expect(findWorkedHoliday(holidays, 7, '2026/11/21')?.id).toBe(3);
    await expect(hasWorkedHolidayOn(7, '2026-11-21', createStore([], holidays))).resolves.toBe(true);
    await expect(hasWorkedHolidayOn(7, '2026-11-14', createStore([], holidays))).resolves.toBe(false);
  });

  it('recognises only the untouched 08:00–17:00 placeholder', () => {
    const placeholder = row({ holidayId: 1, holidayType: 'worked', clockIn: '08:00', clockOut: '17:00', isBarcodeScanned: false });
    expect(isUntouchedWorkedPlaceholder(placeholder)).toBe(true);
    expect(isUntouchedWorkedPlaceholder({ ...placeholder, clockOut: '18:30' })).toBe(false);
    expect(isUntouchedWorkedPlaceholder({ ...placeholder, holidayType: 'personal_leave' })).toBe(false);
    expect(isUntouchedWorkedPlaceholder({ ...placeholder, isBarcodeScanned: true })).toBe(false);
  });

  it('turns the placeholder into a real clock-in that a holiday delete will not remove', () => {
    expect(placeholderToClockIn('07:58')).toEqual({
      clockIn: '07:58',
      clockOut: '',
      isBarcodeScanned: true,
      holidayId: null,
      isHoliday: true,
      holidayType: 'worked'
    });
  });
});
