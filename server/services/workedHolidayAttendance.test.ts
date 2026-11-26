import { describe, expect, it, vi } from 'vitest';

import type { Holiday, TaiwanHoliday, TemporaryAttendance } from '@shared/schema';

import {
  findWorkedHoliday,
  hasWorkedHolidayOn,
  isDefaultRestDayWork,
  isSaturday,
  isUntouchedWorkedPlaceholder,
  markExistingAttendanceAsWorked,
  placeholderToClockIn,
  revertAttendanceForDeletedWorkedHoliday,
  shouldMarkClockInAsWorked,
  type WorkedHolidayAttendanceStore
} from './workedHolidayAttendance';

function holiday(overrides: Partial<Holiday> = {}): Holiday {
  return {
    id: 1,
    employeeId: 7,
    date: '2026/11/18',
    name: '一般休息日加班',
    holidayType: 'worked',
    ...overrides
  } as Holiday;
}

function row(overrides: Partial<TemporaryAttendance> = {}): TemporaryAttendance {
  return {
    id: 100,
    employeeId: 7,
    date: '2026/11/18',
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

function workday(date: string): TaiwanHoliday {
  return { id: `w-${date}`, year: Number(date.slice(0, 4)), holidayDate: date, holidayName: '補行上班', isHoliday: false, createdAt: null } as TaiwanHoliday;
}

function createStore(rows: TemporaryAttendance[], holidays: Holiday[] = [], calendar: TaiwanHoliday[] = []) {
  const store = {
    getAllHolidays: vi.fn(async () => holidays),
    getTaiwanHolidays: vi.fn(async () => calendar),
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
    const store = createStore([row({ date: '2026-11-18' })]);
    await expect(markExistingAttendanceAsWorked(holiday(), store)).resolves.toBe(1);
  });

  it('leaves rows that already have a category, belong to a holiday entry, or have no clock times', async () => {
    const store = createStore([
      row({ id: 1, holidayType: 'sick_leave' }),
      row({ id: 2, holidayId: 9, holidayType: 'personal_leave', isBarcodeScanned: false }),
      row({ id: 3, clockIn: '--:--', clockOut: '--:--' }),
      row({ id: 4, date: '2026/11/19' })
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
    const store = createStore(rows, [holiday(), holiday({ id: 2, date: '2026-11-18' })]);

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
    await expect(hasWorkedHolidayOn(7, '2026-11-18', createStore([], holidays))).resolves.toBe(false);
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

describe('Saturday clock-ins count as 休息日出勤 by default', () => {
  it('knows which dates are Saturdays in either date format', () => {
    expect(isSaturday('2026/11/14')).toBe(true);
    expect(isSaturday('2026-11-21')).toBe(true);
    expect(isSaturday('2026/11/15')).toBe(false); // Sunday
    expect(isSaturday('2026/11/18')).toBe(false);
    expect(isSaturday('not a date')).toBe(false);
  });

  it('marks a Saturday clock-in with no 假日設定 entry', async () => {
    await expect(shouldMarkClockInAsWorked(7, '2026/11/14', createStore([]))).resolves.toBe(true);
  });

  it('does not mark a 補班 Saturday listed as a workday in the calendar', async () => {
    const store = createStore([], [], [workday('2026-11-14')]);
    await expect(shouldMarkClockInAsWorked(7, '2026/11/14', store)).resolves.toBe(false);
    expect(store.getTaiwanHolidays).toHaveBeenCalledWith(2026);
  });

  it('ignores calendar days off on the same Saturday', async () => {
    const dayOff = { ...workday('2026-11-14'), holidayName: '放假', isHoliday: true } as TaiwanHoliday;
    await expect(shouldMarkClockInAsWorked(7, '2026/11/14', createStore([], [], [dayOff]))).resolves.toBe(true);
  });

  it('does not mark weekdays or Sundays without an entry', async () => {
    await expect(shouldMarkClockInAsWorked(7, '2026/11/18', createStore([]))).resolves.toBe(false);
    await expect(shouldMarkClockInAsWorked(7, '2026/11/15', createStore([]))).resolves.toBe(false);
  });

  it('still marks a weekday that has a 假日出勤 entry', async () => {
    await expect(shouldMarkClockInAsWorked(7, '2026/11/18', createStore([], [holiday()]))).resolves.toBe(true);
  });

  it('leaves the Saturday unmarked when the calendar cannot be read', async () => {
    const store = createStore([]);
    store.getTaiwanHolidays.mockRejectedValueOnce(new Error('db down'));
    await expect(isDefaultRestDayWork('2026/11/14', store)).resolves.toBe(false);
  });

  it('keeps the Saturday mark when its 假日出勤 entry is deleted', async () => {
    const saturdayEntry = holiday({ date: '2026/11/14' });
    const rows = [row({ date: '2026/11/14', holidayType: 'worked', isHoliday: true })];
    const store = createStore(rows, [saturdayEntry]);
    await expect(revertAttendanceForDeletedWorkedHoliday(saturdayEntry, store)).resolves.toBe(0);
    expect(rows[0].holidayType).toBe('worked');
  });

  it('removes the mark on a 補班 Saturday when its entry is deleted', async () => {
    const saturdayEntry = holiday({ date: '2026/11/14' });
    const rows = [row({ date: '2026/11/14', holidayType: 'worked', isHoliday: true })];
    const store = createStore(rows, [saturdayEntry], [workday('2026-11-14')]);
    await expect(revertAttendanceForDeletedWorkedHoliday(saturdayEntry, store)).resolves.toBe(1);
    expect(rows[0].holidayType).toBeNull();
  });
});
