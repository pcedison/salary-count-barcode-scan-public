/**
 * 月結前檢查：每月 1 日自動月結前，檢查上個月每位員工的考勤，
 * 找出「看起來是假日或休假，但系統沒有對應標記」的日子。
 *
 * 有疑點就暫停月結、寄信給負責人，等他在後台確認後才產生薪資。
 * 這裡只產生報告，不讀寫資料庫、不寄信。
 */
import type { Employee, Holiday, TemporaryAttendance } from '@shared/schema';
import { getWeekdayOfDate, type StatutoryHoliday } from '@shared/taiwanStatutoryHolidays';

import { isRealWorkRecord, normalizeDateKey, type YearMonth } from './holidayAutomation';

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

export type PrepayrollFindingKind =
  /** 平日全公司都沒人打卡、也沒標假別：可能是颱風假或豪雨停班。 */
  | 'company_no_clock_in'
  /** 平日某位員工沒打卡、也沒標假別：可能是颱風假、病假（要有就診證明）或漏打卡。 */
  | 'employee_no_clock_in'
  /** 國定假日有打卡，但沒標「假日出勤」。 */
  | 'worked_national_holiday'
  /** 國定假日沒打卡，也沒有任何標記（月結前的國定假日補標沒標到）。 */
  | 'unmarked_national_holiday'
  /** 週六（休息日）或週日（例假日）有打卡，但沒標「假日出勤」。 */
  | 'unmarked_rest_day_work';

export interface PrepayrollFinding {
  kind: PrepayrollFindingKind;
  /** YYYY-MM-DD */
  date: string;
  employeeId?: number;
  employeeName?: string;
  holidayName?: string;
}

export interface LongBreak {
  start: string;
  end: string;
  days: number;
  holidayNames: string[];
}

export interface PrepayrollReviewInput {
  target: YearMonth;
  employees: Array<Pick<Employee, 'id' | 'name' | 'active' | 'deletedAt'>>;
  attendance: Array<Pick<TemporaryAttendance, 'employeeId' | 'date' | 'clockIn' | 'clockOut' | 'isHoliday' | 'holidayType'>
    & Partial<Pick<TemporaryAttendance, 'holidayId'>>>;
  holidayRows: Array<Pick<Holiday, 'employeeId' | 'date' | 'holidayType'>>;
  /** 該月的國定假日（員工放假的日子）。 */
  nationalHolidays: StatutoryHoliday[];
  /** 該月的補行上班日（YYYY-MM-DD），這些週六照平日看待。 */
  makeupWorkdays: string[];
}

export interface PrepayrollReviewReport {
  findings: PrepayrollFinding[];
  longBreaks: LongBreak[];
  subject: string;
  text: string;
}

type DayKind = 'workday' | 'national_holiday' | 'saturday' | 'sunday';

function listDatesInMonth({ year, month }: YearMonth): string[] {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  return Array.from({ length: daysInMonth }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`);
}

function formatDate(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  return `${month}/${day}（${WEEKDAY_LABELS[getWeekdayOfDate(date)]}）`;
}

function addToMap<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  const existing = map.get(key);
  if (existing) existing.add(value);
  else map.set(key, new Set([value]));
}

export function buildPrepayrollReview(input: PrepayrollReviewInput): PrepayrollReviewReport {
  const { target } = input;
  const holidayByDate = new Map(input.nationalHolidays.map((holiday) => [normalizeDateKey(holiday.date), holiday]));
  const makeup = new Set(input.makeupWorkdays.map(normalizeDateKey));
  const dates = listDatesInMonth(target);

  const kindOf = (date: string): DayKind => {
    if (makeup.has(date)) return 'workday';
    if (holidayByDate.has(date)) return 'national_holiday';
    const weekday = getWeekdayOfDate(date);
    if (weekday === 6) return 'saturday';
    if (weekday === 0) return 'sunday';
    return 'workday';
  };

  // 只看在職、該月有實際上班的員工：沒上班的人不會進月結。
  const workedDates = new Map<number, Set<string>>();
  for (const record of input.attendance) {
    if (record.employeeId == null || !isRealWorkRecord(record)) continue;
    addToMap(workedDates, record.employeeId, normalizeDateKey(record.date));
  }
  const employees = input.employees
    .filter((employee) => employee.active !== false && !employee.deletedAt && workedDates.has(employee.id))
    .sort((a, b) => a.id - b.id);

  // 標記有兩個來源：假日設定（holidays 表）與考勤上直接改的假別。
  const marks = new Map<string, Set<string>>();
  const markKey = (employeeId: number, date: string) => `${employeeId}|${date}`;
  for (const row of input.holidayRows) {
    if (row.employeeId == null || !row.holidayType) continue;
    addToMap(marks, markKey(row.employeeId, normalizeDateKey(row.date)), row.holidayType);
  }
  for (const record of input.attendance) {
    if (record.employeeId == null || !record.holidayType) continue;
    addToMap(marks, markKey(record.employeeId, normalizeDateKey(record.date)), record.holidayType);
  }

  const findings: PrepayrollFinding[] = [];
  for (const date of dates) {
    const kind = kindOf(date);
    const holiday = holidayByDate.get(date);

    if (kind === 'workday') {
      const absent = employees.filter(
        (employee) => !workedDates.get(employee.id)?.has(date) && !marks.has(markKey(employee.id, date))
      );
      const anyoneWorked = employees.some((employee) => workedDates.get(employee.id)?.has(date));
      if (absent.length > 0 && !anyoneWorked && absent.length === employees.length) {
        findings.push({ kind: 'company_no_clock_in', date });
      } else {
        for (const employee of absent) {
          findings.push({ kind: 'employee_no_clock_in', date, employeeId: employee.id, employeeName: employee.name });
        }
      }
      continue;
    }

    for (const employee of employees) {
      const worked = workedDates.get(employee.id)?.has(date) ?? false;
      const employeeMarks = marks.get(markKey(employee.id, date));
      const markedWorked = employeeMarks?.has('worked') ?? false;
      if (worked && !markedWorked) {
        findings.push({
          kind: kind === 'national_holiday' ? 'worked_national_holiday' : 'unmarked_rest_day_work',
          date,
          employeeId: employee.id,
          employeeName: employee.name,
          ...(holiday ? { holidayName: holiday.name } : {}),
        });
      } else if (kind === 'national_holiday' && !worked && !employeeMarks) {
        findings.push({
          kind: 'unmarked_national_holiday',
          date,
          employeeId: employee.id,
          employeeName: employee.name,
          holidayName: holiday?.name,
        });
      }
    }
  }

  // 連假：連續 3 天以上不上班、且包含國定假日的區間。只列出來參考。
  const longBreaks: LongBreak[] = [];
  let run: string[] = [];
  const flush = () => {
    const names = Array.from(new Set(run.map((date) => holidayByDate.get(date)?.name).filter((name): name is string => !!name)));
    if (run.length >= 3 && names.length > 0) {
      longBreaks.push({ start: run[0], end: run[run.length - 1], days: run.length, holidayNames: names });
    }
    run = [];
  };
  for (const date of dates) {
    if (kindOf(date) === 'workday') flush();
    else run.push(date);
  }
  flush();

  return { findings, longBreaks, ...renderReport(target, findings, longBreaks, input.nationalHolidays) };
}

function renderReport(
  target: YearMonth,
  findings: PrepayrollFinding[],
  longBreaks: LongBreak[],
  nationalHolidays: StatutoryHoliday[]
): { subject: string; text: string } {
  const monthLabel = `${target.year}年${target.month}月`;
  const of = (kind: PrepayrollFindingKind) => findings.filter((finding) => finding.kind === kind);
  const byEmployee = (items: PrepayrollFinding[]) => {
    const grouped = new Map<string, string[]>();
    for (const item of items) {
      const name = item.employeeName ?? '';
      const label = item.holidayName ? `${formatDate(item.date)} ${item.holidayName}` : formatDate(item.date);
      grouped.set(name, [...(grouped.get(name) ?? []), label]);
    }
    return Array.from(grouped, ([name, labels]) => `- ${name}：${labels.join('、')}`);
  };

  const lines: string[] = [];
  lines.push(`${monthLabel}的考勤有 ${findings.length} 件系統沒有標註的地方，${monthLabel}的月結已先暫停。`);
  lines.push('請先確認是否真的漏登記，補好之後到後台「薪資月結 Email」區塊按「確認無誤，執行月結」，系統才會產生薪資。');
  lines.push('');

  const sections: Array<[string, string[], string?]> = [
    ['平日全公司都沒人打卡、也沒標假別（可能是颱風假或豪雨停班）',
      of('company_no_clock_in').map((item) => `- ${formatDate(item.date)}`),
      '如果是颱風假或停班，請到「假日設定」幫每位員工補上「颱風假」或「臨時停止上班上課」。'],
    ['平日沒打卡、也沒標假別的員工（可能是颱風假、病假或漏打卡；病假要有就診證明）',
      byEmployee(of('employee_no_clock_in'))],
    ['國定假日有打卡、還沒標「假日出勤」',
      byEmployee(of('worked_national_holiday')),
      '如果是公司安排上班，要標「假日出勤」才會加發一天。'],
    ['週六、週日有打卡、還沒標「假日出勤」',
      byEmployee(of('unmarked_rest_day_work')),
      '週六是休息日，週日是例假日。是加班的話請在考勤登記改成「假日出勤」。'],
    ['國定假日沒打卡、也沒有任何標記',
      byEmployee(of('unmarked_national_holiday'))],
  ];
  let index = 0;
  const numerals = ['一', '二', '三', '四', '五', '六'];
  for (const [title, items, hint] of sections) {
    if (items.length === 0) continue;
    lines.push(`${numerals[index++]}、${title}`);
    lines.push(...items);
    if (hint) lines.push(hint);
    lines.push('');
  }

  lines.push('參考：本月國定假日與連假');
  if (nationalHolidays.length === 0) {
    lines.push('- 本月沒有國定假日。');
  } else {
    for (const holiday of nationalHolidays) lines.push(`- ${formatDate(normalizeDateKey(holiday.date))} ${holiday.name}`);
  }
  for (const longBreak of longBreaks) {
    lines.push(`- 連假 ${formatDate(longBreak.start)} 到 ${formatDate(longBreak.end)}，共 ${longBreak.days} 天（${longBreak.holidayNames.join('、')}）`);
  }
  lines.push('');
  lines.push('這封信不會新增或修改任何考勤或薪資資料。');

  return {
    subject: `${monthLabel}月結前檢查：有 ${findings.length} 件要確認，月結已暫停`,
    text: lines.join('\n'),
  };
}
