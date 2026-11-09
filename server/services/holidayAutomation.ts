/**
 * 假日自動化：
 * 1. 國定假日自動標註：把勞工國定假日（shared/taiwanStatutoryHolidays）自動補成
 *    national_holiday 假日設定＋考勤紀錄，等同管理員在後台逐一員工新增。
 * 2. 月底假日提醒信：列出當月已標假別、平日全廠沒人打卡的日子（可能是天災假或漏標）、
 *    國定假日有打卡的人，讓管理員在月結前確認。天災假無法預知，系統只提醒、不自動標。
 *
 * 安全邊界：
 * - 只標「已經過去」的日期，不會跟當天打卡搶同一筆考勤紀錄。
 * - 已有薪資紀錄（已結算）的員工月份不動。
 * - 該月完全沒有實際打卡的員工不標（避免讓沒上班的人因假日紀錄被月結算出整月薪資）。
 * - 該日已有任何考勤或假日設定就跳過（管理員的手動設定優先）。
 * - 國定假日在計薪上不扣不加（calculateHolidayPayAdjustments），自動標註本身不改變金額。
 */
import type { Employee, Holiday, TemporaryAttendance } from '@shared/schema';
import {
  getStatutoryHolidays,
  getStatutoryHolidaysForMonth,
  getWeekdayOfDate,
  isWeekendDate,
  type StatutoryHoliday,
} from '@shared/taiwanStatutoryHolidays';

export const AUTO_NATIONAL_HOLIDAY_DESCRIPTION = '系統自動標註（勞工國定假日）';

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

const HOLIDAY_TYPE_LABELS: Record<string, string> = {
  national_holiday: '國定假日',
  special_leave: '特別休假',
  typhoon_leave: '颱風假',
  temporary_stop_work_and_classes: '臨時停止上班上課',
  sick_leave: '病假',
  personal_leave: '事假',
  worked: '假日出勤',
};

export interface YearMonth {
  year: number;
  month: number;
}

export interface PlannedNationalHolidayMark {
  employeeId: number;
  employeeName: string;
  date: string;
  name: string;
}

export interface HolidayWorkedNotice {
  employeeId: number;
  employeeName: string;
  date: string;
  holidayName: string;
}

type EmployeeLike = Pick<Employee, 'id' | 'name' | 'active' | 'deletedAt'>;
type AttendanceLike = Pick<TemporaryAttendance, 'employeeId' | 'date' | 'clockIn' | 'clockOut' | 'isHoliday' | 'holidayType'>;
type HolidayLike = Pick<Holiday, 'employeeId' | 'date' | 'holidayType' | 'name'>;

/** 把 YYYY/M/D、YYYY-MM-DD 等格式統一成 YYYY-MM-DD。 */
export function normalizeDateKey(date: string | null | undefined): string {
  const parts = String(date ?? '').trim().split(/[-/]/);
  if (parts.length !== 3) {
    return String(date ?? '').trim();
  }
  const [year, month, day] = parts;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** 取得某時區的今天（YYYY-MM-DD）。 */
export function getLocalDateKey(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getLocalHour(now: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now);
  return Number(hour);
}

export function parseYearMonth(dateKey: string): YearMonth {
  const [year, month] = dateKey.split('-').map(Number);
  return { year, month };
}

export function getPreviousYearMonth({ year, month }: YearMonth): YearMonth {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function isActiveEmployee(employee: EmployeeLike): boolean {
  return employee.active !== false && !employee.deletedAt;
}

function isUsableClockTime(value: string | null | undefined): boolean {
  return Boolean(value && value.trim() && value !== '--:--');
}

/** 實際上班打卡（不是假日紀錄、不是 --:--）。 */
export function isRealWorkRecord(record: AttendanceLike): boolean {
  return !record.isHoliday && isUsableClockTime(record.clockIn);
}

function groupByEmployee<T extends { employeeId: number | null }>(rows: T[]): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    if (row.employeeId == null) continue;
    const list = grouped.get(row.employeeId);
    if (list) list.push(row);
    else grouped.set(row.employeeId, [row]);
  }
  return grouped;
}

function formatDateWithWeekday(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  return `${month}/${day}（${WEEKDAY_LABELS[getWeekdayOfDate(date)]}）`;
}

function listDatesInMonth({ year, month }: YearMonth): string[] {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  return Array.from({ length: daysInMonth }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`);
}

export interface PlanNationalHolidayMarksInput {
  target: YearMonth;
  /** 今天（YYYY-MM-DD，台北時間）；只標比今天早的日期。 */
  today: string;
  employees: EmployeeLike[];
  attendance: AttendanceLike[];
  holidayRows: HolidayLike[];
  /** 該月已有薪資紀錄（已結算）的員工 id。 */
  settledEmployeeIds: Set<number>;
  statutoryHolidays?: StatutoryHoliday[];
}

export function planNationalHolidayMarks(input: PlanNationalHolidayMarksInput): PlannedNationalHolidayMark[] {
  const statutory = (input.statutoryHolidays ?? getStatutoryHolidaysForMonth(input.target.year, input.target.month))
    .filter((holiday) => holiday.date < input.today);
  if (statutory.length === 0) {
    return [];
  }

  const attendanceByEmployee = groupByEmployee(input.attendance);
  const holidaysByEmployee = groupByEmployee(input.holidayRows);
  const marks: PlannedNationalHolidayMark[] = [];

  for (const employee of input.employees) {
    if (!isActiveEmployee(employee) || input.settledEmployeeIds.has(employee.id)) {
      continue;
    }

    const attendance = attendanceByEmployee.get(employee.id) ?? [];
    if (!attendance.some(isRealWorkRecord)) {
      continue;
    }

    const occupiedDates = new Set<string>([
      ...attendance.map((record) => normalizeDateKey(record.date)),
      ...(holidaysByEmployee.get(employee.id) ?? []).map((row) => normalizeDateKey(row.date)),
    ]);

    for (const holiday of statutory) {
      if (occupiedDates.has(holiday.date)) {
        continue;
      }
      marks.push({ employeeId: employee.id, employeeName: employee.name, date: holiday.date, name: holiday.name });
    }
  }

  return marks;
}

export interface HolidayReminderInput {
  target: YearMonth;
  today: string;
  employees: EmployeeLike[];
  attendance: AttendanceLike[];
  holidayRows: HolidayLike[];
  statutoryHolidays?: StatutoryHoliday[];
  /** 12 月時附上的下一年清單；undefined 代表還沒收錄。 */
  nextYearHolidays?: StatutoryHoliday[] | undefined;
}

export interface HolidayReminderReport {
  subject: string;
  text: string;
  unmarkedNoClockInDates: string[];
  workedOnHoliday: HolidayWorkedNotice[];
}

export function buildHolidayReminder(input: HolidayReminderInput): HolidayReminderReport {
  const { target, today } = input;
  const statutory = input.statutoryHolidays ?? getStatutoryHolidaysForMonth(target.year, target.month);
  const statutoryByDate = new Map(statutory.map((holiday) => [holiday.date, holiday]));
  const monthDates = listDatesInMonth(target);
  const pastDates = monthDates.filter((date) => date < today);
  const laterDates = monthDates.filter((date) => date >= today);

  // 只看本月有實際上班的在職員工；沒上班的人不會進月結。
  const attendanceByEmployee = groupByEmployee(input.attendance);
  const workingEmployees = input.employees
    .filter(isActiveEmployee)
    .filter((employee) => (attendanceByEmployee.get(employee.id) ?? []).some(isRealWorkRecord))
    .sort((a, b) => a.id - b.id);
  const workingIds = new Set(workingEmployees.map((employee) => employee.id));

  const holidayRows = input.holidayRows
    .filter((row) => row.employeeId != null && workingIds.has(row.employeeId))
    .map((row) => ({ ...row, date: normalizeDateKey(row.date) }));
  const holidayRowsByEmployee = groupByEmployee(holidayRows);

  const lines: string[] = [];
  const monthLabel = `${target.year}年${target.month}月`;
  lines.push(`${monthLabel}假日標註確認（下個月 1 日凌晨會自動月結）`);
  lines.push('');

  // 1. 本月國定假日
  lines.push('一、本月勞工國定假日');
  if (statutory.length === 0) {
    lines.push('本月沒有國定假日。');
  } else {
    for (const holiday of statutory) {
      const notes: string[] = [];
      if (isWeekendDate(holiday.date)) {
        notes.push('落在週末，若是員工休息日，補假要和員工另外約定');
      }
      if (holiday.date >= today) {
        notes.push('還沒到，過了之後系統會自動標');
      }
      lines.push(`- ${formatDateWithWeekday(holiday.date)} ${holiday.name}${notes.length ? `：${notes.join('；')}` : ''}`);
    }
  }
  lines.push('');

  // 2. 平日全廠沒人打卡
  const unmarkedNoClockInDates: string[] = [];
  const noClockInLines: string[] = [];
  for (const date of pastDates) {
    if (isWeekendDate(date) || statutoryByDate.has(date)) continue;
    const anyoneWorked = input.attendance.some(
      (record) => record.employeeId != null && workingIds.has(record.employeeId)
        && normalizeDateKey(record.date) === date && isRealWorkRecord(record)
    );
    if (anyoneWorked || workingEmployees.length === 0) continue;

    const unmarked = workingEmployees.filter(
      (employee) => !(holidayRowsByEmployee.get(employee.id) ?? []).some((row) => row.date === date)
    );
    if (unmarked.length === 0) {
      continue;
    }
    unmarkedNoClockInDates.push(date);
    noClockInLines.push(
      unmarked.length === workingEmployees.length
        ? `- ${formatDateWithWeekday(date)}：全部 ${workingEmployees.length} 人都沒打卡，也還沒標假別`
        : `- ${formatDateWithWeekday(date)}：沒人打卡，還沒標假別的有 ${unmarked.map((employee) => employee.name).join('、')}`
    );
  }
  lines.push('二、平日全廠沒人打卡、也還沒標假別的日子（可能是颱風假、豪雨停班或漏標）');
  if (noClockInLines.length === 0) {
    lines.push('沒有。');
  } else {
    lines.push(...noClockInLines);
    lines.push('颱風假、豪雨停班照公司規定不給薪，請到後台「假日設定」幫每位員工補上「颱風假」或「臨時停止上班上課」，否則月結會照常給薪。');
  }
  lines.push('');

  // 3. 國定假日有打卡
  const workedOnHoliday: HolidayWorkedNotice[] = [];
  for (const holiday of statutory) {
    if (holiday.date >= today) continue;
    for (const employee of workingEmployees) {
      const worked = (attendanceByEmployee.get(employee.id) ?? []).some(
        (record) => normalizeDateKey(record.date) === holiday.date && isRealWorkRecord(record)
      );
      const markedWorked = (holidayRowsByEmployee.get(employee.id) ?? []).some(
        (row) => row.date === holiday.date && row.holidayType === 'worked'
      );
      if (worked && !markedWorked) {
        workedOnHoliday.push({ employeeId: employee.id, employeeName: employee.name, date: holiday.date, holidayName: holiday.name });
      }
    }
  }
  lines.push('三、國定假日有打卡、還沒標「假日出勤」的人');
  if (workedOnHoliday.length === 0) {
    lines.push('沒有。');
  } else {
    for (const notice of workedOnHoliday) {
      lines.push(`- ${notice.employeeName}：${formatDateWithWeekday(notice.date)} ${notice.holidayName}`);
    }
    lines.push('如果是公司安排上班，要標「假日出勤」才會加發一天。');
  }
  lines.push('');

  // 4. 已標假別
  lines.push('四、本月已標的假別');
  const markedLines = workingEmployees
    .map((employee) => {
      const rows = [...(holidayRowsByEmployee.get(employee.id) ?? [])].sort((a, b) => a.date.localeCompare(b.date));
      if (rows.length === 0) return null;
      const items = rows.map((row) => `${formatDateWithWeekday(row.date)} ${HOLIDAY_TYPE_LABELS[row.holidayType] ?? row.holidayType}`);
      return `- ${employee.name}：${items.join('、')}`;
    })
    .filter((line): line is string => line !== null);
  lines.push(...(markedLines.length ? markedLines : ['還沒有任何標註。']));
  lines.push('');

  if (laterDates.length > 0) {
    lines.push(`${formatDateWithWeekday(laterDates[0])}到月底的日子不在這封信裡；這幾天如果停班，月結前記得到後台補標。`);
    lines.push('');
  }

  // 5. 12 月檢查下一年清單
  if (target.month === 12) {
    const nextYear = target.year + 1;
    lines.push(`五、${nextYear} 年國定假日清單`);
    if (!input.nextYearHolidays) {
      lines.push(`系統還沒收錄 ${nextYear} 年的國定假日，1 月起不會自動標註，請更新程式裡的國定假日清單。`);
    } else {
      lines.push(`以下是 ${nextYear} 年會自動標註的日期，若和公告不符請更新程式：`);
      for (const holiday of input.nextYearHolidays) {
        lines.push(`- ${formatDateWithWeekday(holiday.date)} ${holiday.name}`);
      }
    }
    lines.push('');
  }

  lines.push('這封信只是提醒，不會新增或修改任何薪資或考勤資料。');

  return {
    subject: `${monthLabel}假日標註確認${unmarkedNoClockInDates.length || workedOnHoliday.length ? '（有日子要看）' : ''}`,
    text: lines.join('\n'),
    unmarkedNoClockInDates,
    workedOnHoliday,
  };
}

export function getNextYearHolidaysForReminder(target: YearMonth): StatutoryHoliday[] | undefined {
  return target.month === 12 ? getStatutoryHolidays(target.year + 1) : undefined;
}
