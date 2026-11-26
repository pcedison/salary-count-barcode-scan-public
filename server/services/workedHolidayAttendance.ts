import type { Holiday, InsertTemporaryAttendance, TaiwanHoliday, TemporaryAttendance } from '@shared/schema';
import { normalizeDateToSlash } from '@shared/utils/specialLeaveSync';

import { createLogger } from '../utils/logger';

const log = createLogger('worked-holiday');

/**
 * Keeps 考勤 rows in step with 假日出勤 ("worked") entries in 假日設定.
 *
 * Payroll only reads `temporary_attendance.holidayType`, so a 假日出勤 entry
 * has no effect unless the employee's attendance row for that date carries
 * holidayType 'worked'. These helpers write that mark onto real clock-in rows
 * when the entry is added, take it off again when the entry is removed, and
 * mark clock-ins that happen after the entry exists.
 *
 * A clock-in on a Saturday (休息日) is also marked 假日出勤 on its own, unless
 * taiwan_holidays lists that Saturday as a workday (is_holiday = false), which
 * is how a government 補行上班 day, or a workday the company adds, is stored.
 *
 * Real clock-in rows never get a holidayId: deleting a holiday deletes every
 * row carrying its id, and a real clock-in must survive that.
 */

export const WORKED_HOLIDAY_TYPE = 'worked' as const;

const PLACEHOLDER_CLOCK_IN = '08:00';
const PLACEHOLDER_CLOCK_OUT = '17:00';
const CLOCK_TIME_PATTERN = /^\d{1,2}:\d{2}$/;

type AttendanceRow = Pick<
  TemporaryAttendance,
  'id' | 'employeeId' | 'date' | 'clockIn' | 'clockOut' | 'holidayId' | 'holidayType' | 'isBarcodeScanned'
>;

export interface WorkedHolidayAttendanceStore {
  getAllHolidays(): Promise<Holiday[]>;
  getTaiwanHolidays(year?: number): Promise<TaiwanHoliday[]>;
  getTemporaryAttendanceByEmployeeAndDate(employeeId: number, date: string): Promise<TemporaryAttendance[]>;
  updateTemporaryAttendance(
    id: number,
    attendance: Partial<InsertTemporaryAttendance>
  ): Promise<TemporaryAttendance | undefined>;
}

function hasRealClockTime(value: string | null | undefined): boolean {
  return typeof value === 'string' && CLOCK_TIME_PATTERN.test(value.trim());
}

function sameDate(a: string, b: string): boolean {
  return normalizeDateToSlash(a) === normalizeDateToSlash(b);
}

/** The 08:00–17:00 row 假日設定 creates when a 假日出勤 entry is added before anyone clocked in. */
export function isUntouchedWorkedPlaceholder(row: AttendanceRow): boolean {
  return (
    row.holidayType === WORKED_HOLIDAY_TYPE &&
    row.holidayId != null &&
    !row.isBarcodeScanned &&
    row.clockIn === PLACEHOLDER_CLOCK_IN &&
    row.clockOut === PLACEHOLDER_CLOCK_OUT
  );
}

/** A real clock-in row with no category yet, which a 假日出勤 entry should mark. */
export function shouldMarkAsWorked(row: AttendanceRow): boolean {
  return (
    row.holidayId == null &&
    !row.holidayType &&
    (hasRealClockTime(row.clockIn) || hasRealClockTime(row.clockOut))
  );
}

/** A row this module (or the 考勤 dropdown) marked 假日出勤 that no holiday entry owns. */
export function shouldRevertWorkedMark(row: AttendanceRow): boolean {
  return row.holidayId == null && row.holidayType === WORKED_HOLIDAY_TYPE;
}

export function findWorkedHoliday(
  holidays: Holiday[],
  employeeId: number,
  date: string,
  excludeHolidayId?: number
): Holiday | undefined {
  return holidays.find(
    (holiday) =>
      holiday.holidayType === WORKED_HOLIDAY_TYPE &&
      holiday.employeeId === employeeId &&
      holiday.id !== excludeHolidayId &&
      sameDate(holiday.date, date)
  );
}

export async function hasWorkedHolidayOn(
  employeeId: number,
  date: string,
  store: Pick<WorkedHolidayAttendanceStore, 'getAllHolidays'>
): Promise<boolean> {
  const holidays = await store.getAllHolidays();
  return findWorkedHoliday(holidays, employeeId, date) !== undefined;
}

function parseDateParts(date: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(normalizeDateToSlash(date));
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function isSaturday(date: string): boolean {
  const parts = parseDateParts(date);
  if (!parts) return false;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() === 6;
}

/** taiwan_holidays lists the date as a workday (補行上班, or a workday the company added). */
export function isListedWorkday(date: string, calendar: TaiwanHoliday[]): boolean {
  return calendar.some((entry) => entry.isHoliday === false && sameDate(entry.holidayDate, date));
}

/**
 * A clock-in on this date counts as 休息日出勤 by default: it is a Saturday and
 * the stored calendar does not list it as a workday. If the calendar cannot be
 * read, the clock-in is left unmarked so a 補班 Saturday is never overpaid; the
 * admin can still mark it in 考勤登記.
 */
export async function isDefaultRestDayWork(
  date: string,
  store: Pick<WorkedHolidayAttendanceStore, 'getTaiwanHolidays'>
): Promise<boolean> {
  if (!isSaturday(date)) return false;
  const parts = parseDateParts(date);
  try {
    const calendar = await store.getTaiwanHolidays(parts?.year);
    return !isListedWorkday(date, calendar);
  } catch (error) {
    log.warn(`無法讀取 ${date} 的行事曆，這筆週六打卡先不自動標假日出勤`, error);
    return false;
  }
}

/** Whether a new clock-in on this date should start out marked 假日出勤. */
export async function shouldMarkClockInAsWorked(
  employeeId: number,
  date: string,
  store: Pick<WorkedHolidayAttendanceStore, 'getAllHolidays' | 'getTaiwanHolidays'>
): Promise<boolean> {
  if (await hasWorkedHolidayOn(employeeId, date, store)) return true;
  return isDefaultRestDayWork(date, store);
}

async function loadRowsForDate(holiday: Holiday, store: WorkedHolidayAttendanceStore): Promise<TemporaryAttendance[]> {
  if (!holiday.employeeId) return [];
  const rows = await store.getTemporaryAttendanceByEmployeeAndDate(holiday.employeeId, holiday.date);
  return rows.filter((row) => sameDate(row.date, holiday.date));
}

/** Marks the employee's existing clock-in rows on the holiday's date as 假日出勤. Returns how many rows changed. */
export async function markExistingAttendanceAsWorked(
  holiday: Holiday,
  store: WorkedHolidayAttendanceStore
): Promise<number> {
  if (holiday.holidayType !== WORKED_HOLIDAY_TYPE) return 0;

  let updated = 0;
  for (const row of await loadRowsForDate(holiday, store)) {
    if (!shouldMarkAsWorked(row)) continue;
    await store.updateTemporaryAttendance(row.id, { holidayType: WORKED_HOLIDAY_TYPE, isHoliday: true });
    updated += 1;
  }
  return updated;
}

/**
 * Takes the 假日出勤 mark off the employee's clock-in rows when its entry is deleted,
 * unless another 假日出勤 entry still covers that employee and date, or the date is a Saturday
 * that counts as 休息日出勤 anyway. Returns how many rows changed.
 */
export async function revertAttendanceForDeletedWorkedHoliday(
  holiday: Holiday,
  store: WorkedHolidayAttendanceStore
): Promise<number> {
  if (holiday.holidayType !== WORKED_HOLIDAY_TYPE || !holiday.employeeId) return 0;

  const otherHolidays = await store.getAllHolidays();
  if (findWorkedHoliday(otherHolidays, holiday.employeeId, holiday.date, holiday.id)) return 0;
  // A Saturday stays 假日出勤 by default, entry or not
  if (await isDefaultRestDayWork(holiday.date, store)) return 0;

  let updated = 0;
  for (const row of await loadRowsForDate(holiday, store)) {
    if (!shouldRevertWorkedMark(row)) continue;
    await store.updateTemporaryAttendance(row.id, { holidayType: null, isHoliday: false });
    updated += 1;
  }
  return updated;
}

/** Fields that turn an untouched placeholder into the employee's real clock-in. */
export function placeholderToClockIn(time: string): Partial<InsertTemporaryAttendance> {
  return {
    clockIn: time,
    clockOut: '',
    isBarcodeScanned: true,
    holidayId: null,
    isHoliday: true,
    holidayType: WORKED_HOLIDAY_TYPE
  };
}
