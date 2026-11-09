import { describe, expect, it } from 'vitest';

import { getStatutoryHolidays, isWeekendDate } from '@shared/taiwanStatutoryHolidays';

import {
  buildHolidayReminder,
  getLocalDateKey,
  normalizeDateKey,
  planNationalHolidayMarks,
} from './holidayAutomation';

const emp = (id: number, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, active: true, deletedAt: null, ...extra }) as never;
const work = (employeeId: number, date: string, clockIn = '08:00', clockOut = '17:00') =>
  ({ employeeId, date, clockIn, clockOut, isHoliday: false, holidayType: null }) as never;
const mark = (employeeId: number, date: string, holidayType: string) =>
  ({ employeeId, date, holidayType, name: '' }) as never;

describe('statutory holiday list', () => {
  it('has the 16 labour holidays per year and no government-only adjusted days', () => {
    for (const year of [2026, 2027]) {
      const list = getStatutoryHolidays(year)!;
      expect(list).toHaveLength(16);
      expect(new Set(list.map((h) => h.date)).size).toBe(16);
      expect(list.every((h) => h.date.startsWith(`${year}-`))).toBe(true);
    }
    // 2027-02-09/10 是公務員補假，不是勞工國定假日
    expect(getStatutoryHolidays(2027)!.map((h) => h.date)).not.toContain('2027-02-09');
    expect(getStatutoryHolidays(2028)).toBeUndefined();
  });

  it('computes weekdays independent of server time zone', () => {
    expect(isWeekendDate('2026-12-25')).toBe(false); // Friday
    expect(isWeekendDate('2027-12-25')).toBe(true); // Saturday
  });
});

describe('normalizeDateKey / getLocalDateKey', () => {
  it('normalizes slash and unpadded dates', () => {
    expect(normalizeDateKey('2026/12/5')).toBe('2026-12-05');
    expect(normalizeDateKey('2026-12-25')).toBe('2026-12-25');
  });

  it('uses Taipei local date', () => {
    expect(getLocalDateKey(new Date('2026-12-25T16:30:00Z'), 'Asia/Taipei')).toBe('2026-12-26');
  });
});

describe('planNationalHolidayMarks', () => {
  const target = { year: 2026, month: 12 };
  const base = {
    target,
    today: '2026-12-26',
    employees: [emp(1, '阿明'), emp(2, '小美'), emp(3, '離職', { active: false }), emp(4, '沒上班')],
    holidayRows: [],
    settledEmployeeIds: new Set<number>(),
  };

  it('marks past holidays only for active employees who actually worked that month', () => {
    const marks = planNationalHolidayMarks({
      ...base,
      attendance: [work(1, '2026/12/01'), work(2, '2026-12-02'), work(3, '2026/12/01')],
    });
    expect(marks.map((m) => [m.employeeId, m.date])).toEqual([
      [1, '2026-12-25'],
      [2, '2026-12-25'],
    ]);
    expect(marks[0].name).toBe('行憲紀念日');
  });

  it('does not mark a holiday that has not passed yet', () => {
    const marks = planNationalHolidayMarks({ ...base, today: '2026-12-25', attendance: [work(1, '2026/12/01')] });
    expect(marks).toEqual([]);
  });

  it('respects existing attendance, manual marks and settled months', () => {
    const marks = planNationalHolidayMarks({
      ...base,
      employees: [emp(1, 'A'), emp(2, 'B'), emp(5, 'C')],
      attendance: [work(1, '2026/12/01'), work(1, '2026/12/25'), work(2, '2026/12/01'), work(5, '2026/12/01')],
      holidayRows: [mark(2, '2026-12-25', 'typhoon_leave')],
      settledEmployeeIds: new Set([5]),
    });
    expect(marks).toEqual([]);
  });
});

describe('buildHolidayReminder', () => {
  it('flags weekdays with no clock-ins, holiday work and lists marks', () => {
    const target = { year: 2026, month: 10 };
    const attendance = [];
    // 10 月平日都有打卡，除了 10/16（五）全廠沒人打卡、10/23（五）只有小美有標颱風假
    for (let day = 1; day <= 27; day += 1) {
      const date = `2026-10-${String(day).padStart(2, '0')}`;
      if (isWeekendDate(date) || date === '2026-10-16' || date === '2026-10-23') continue;
      attendance.push(work(1, date.replace(/-/g, '/')), work(2, date));
    }
    attendance.push(work(1, '2026/10/10')); // 國慶日（六）來上班
    const report = buildHolidayReminder({
      target,
      today: '2026-10-28',
      employees: [emp(1, '阿明'), emp(2, '小美')],
      attendance,
      holidayRows: [mark(2, '2026-10-23', 'typhoon_leave'), mark(1, '2026-10-25', 'national_holiday')],
    });

    expect(report.unmarkedNoClockInDates).toEqual(['2026-10-16', '2026-10-23']);
    expect(report.workedOnHoliday).toEqual([
      { employeeId: 1, employeeName: '阿明', date: '2026-10-10', holidayName: '國慶日' },
    ]);
    expect(report.subject).toBe('2026年10月假日標註確認（有日子要看）');
    expect(report.text).toContain('10/16（五）：全部 2 人都沒打卡，也還沒標假別');
    expect(report.text).toContain('10/23（五）：沒人打卡，還沒標假別的有 阿明');
    expect(report.text).toContain('- 小美：10/23（五） 颱風假');
    expect(report.text).toContain('10/28（三）到月底的日子不在這封信裡');
    expect(report.text).not.toContain('五、');
  });

  it('counts barcode scans flagged isHoliday as real work, but not holiday-setting records', () => {
    const report = buildHolidayReminder({
      target: { year: 2026, month: 12 },
      today: '2026-12-28',
      employees: [emp(1, '阿明'), emp(2, '小美')],
      attendance: [
        work(1, '2026/12/01'),
        work(2, '2026/12/01'),
        // 有人先被標了假，當天掃碼的紀錄會帶 isHoliday=true，但確實有上班
        { employeeId: 1, date: '2026/12/25', clockIn: '08:00', clockOut: '17:00', isHoliday: true, holidayType: null, holidayId: null },
        // 後台病假設定產生的紀錄（帶 holidayId）不算上班
        { employeeId: 2, date: '2026-12-25', clockIn: '08:00', clockOut: '17:00', isHoliday: true, holidayType: 'sick_leave', holidayId: 9 },
      ] as never,
      holidayRows: [mark(2, '2026-12-25', 'sick_leave')],
    });
    expect(report.workedOnHoliday.map((n) => n.employeeName)).toEqual(['阿明']);
  });

  it('checks next year list in December', () => {
    const base = {
      target: { year: 2026, month: 12 },
      today: '2026-12-28',
      employees: [emp(1, '阿明')],
      attendance: [work(1, '2026/12/01')],
      holidayRows: [],
    };
    const withList = buildHolidayReminder({ ...base, nextYearHolidays: getStatutoryHolidays(2027) });
    expect(withList.text).toContain('2027 年會自動標註的日期');
    expect(withList.text).toContain('2/4（四） 除夕前一日');
    const missing = buildHolidayReminder({ ...base, nextYearHolidays: undefined });
    expect(missing.text).toContain('系統還沒收錄 2027 年的國定假日');
  });

  it('says so when nothing needs attention', () => {
    const report = buildHolidayReminder({
      target: { year: 2026, month: 11 },
      today: '2026-11-28',
      employees: [],
      attendance: [],
      holidayRows: [],
    });
    expect(report.subject).toBe('2026年11月假日標註確認');
    expect(report.text).toContain('本月沒有國定假日。');
  });
});
