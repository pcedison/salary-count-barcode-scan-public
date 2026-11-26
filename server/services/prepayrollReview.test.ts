import { describe, expect, it } from 'vitest';

import { buildPrepayrollReview, type PrepayrollReviewInput } from './prepayrollReview';

const target = { year: 2026, month: 11 };

function weekdaysOf(year: number, month: number): string[] {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const result: string[] = [];
  for (let day = 1; day <= days; day += 1) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      result.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  }
  return result;
}

function clockIn(employeeId: number, date: string, holidayType: string | null = null) {
  return {
    employeeId,
    date: date.replace(/-/g, '/'),
    clockIn: '08:00',
    clockOut: '17:00',
    isHoliday: holidayType != null,
    holidayType,
    holidayId: null,
  };
}

function baseInput(overrides: Partial<PrepayrollReviewInput> = {}): PrepayrollReviewInput {
  const employees = [
    { id: 1, name: '陳文山', active: true, deletedAt: null },
    { id: 2, name: '林小美', active: true, deletedAt: null },
  ];
  const attendance = employees.flatMap((employee) => weekdaysOf(2026, 11).map((date) => clockIn(employee.id, date)));
  return { target, employees, attendance, holidayRows: [], nationalHolidays: [], makeupWorkdays: [], ...overrides };
}

describe('buildPrepayrollReview', () => {
  it('finds nothing when every weekday has a clock-in and no weekend work', () => {
    const report = buildPrepayrollReview(baseInput());
    expect(report.findings).toEqual([]);
  });

  it('flags a Saturday clock-in that is not marked 假日出勤, but not one that is', () => {
    const input = baseInput();
    input.attendance.push(clockIn(1, '2026-11-14'), clockIn(2, '2026-11-14', 'worked'));
    const report = buildPrepayrollReview(input);
    expect(report.findings).toEqual([
      { kind: 'unmarked_rest_day_work', date: '2026-11-14', employeeId: 1, employeeName: '陳文山' },
    ]);
    expect(report.subject).toBe('2026年11月月結前檢查：有 1 件要確認，月結已暫停');
    expect(report.text).toContain('陳文山：11/14（六）');
    expect(report.text).toContain('確認無誤，執行月結');
  });

  it('reports a weekday with no clock-ins at all as one company-wide finding (typhoon day)', () => {
    const input = baseInput();
    input.attendance = input.attendance.filter((row) => row.date !== '2026/11/18');
    const report = buildPrepayrollReview(input);
    expect(report.findings).toEqual([{ kind: 'company_no_clock_in', date: '2026-11-18' }]);
    expect(report.text).toContain('颱風假');
  });

  it('accepts a typhoon day once it is marked in 假日設定', () => {
    const input = baseInput({
      holidayRows: [
        { employeeId: 1, date: '2026-11-18', holidayType: 'typhoon_leave' },
        { employeeId: 2, date: '2026-11-18', holidayType: 'typhoon_leave' },
      ],
    });
    input.attendance = input.attendance.filter((row) => row.date !== '2026/11/18');
    expect(buildPrepayrollReview(input).findings).toEqual([]);
  });

  it('reports one absent employee on a weekday by name', () => {
    const input = baseInput();
    input.attendance = input.attendance.filter((row) => !(row.employeeId === 2 && row.date === '2026/11/18'));
    expect(buildPrepayrollReview(input).findings).toEqual([
      { kind: 'employee_no_clock_in', date: '2026-11-18', employeeId: 2, employeeName: '林小美' },
    ]);
  });

  it('treats a makeup workday Saturday as a normal workday', () => {
    const input = baseInput({ makeupWorkdays: ['2026-11-14'] });
    input.attendance.push(clockIn(1, '2026-11-14'));
    expect(buildPrepayrollReview(input).findings).toEqual([
      { kind: 'employee_no_clock_in', date: '2026-11-14', employeeId: 2, employeeName: '林小美' },
    ]);
  });

  it('flags national holiday work and unmarked national holidays, and lists long breaks', () => {
    // 假設 11/20（五）是國定假日：連同週末 11/20~11/22 是 3 天連假。
    const input = baseInput({ nationalHolidays: [{ date: '2026-11-20', name: '測試紀念日' }] });
    input.attendance = input.attendance.filter((row) => !(row.employeeId === 2 && row.date === '2026/11/20'));
    const report = buildPrepayrollReview(input);
    expect(report.findings).toEqual([
      { kind: 'worked_national_holiday', date: '2026-11-20', employeeId: 1, employeeName: '陳文山', holidayName: '測試紀念日' },
      { kind: 'unmarked_national_holiday', date: '2026-11-20', employeeId: 2, employeeName: '林小美', holidayName: '測試紀念日' },
    ]);
    expect(report.longBreaks).toEqual([
      { start: '2026-11-20', end: '2026-11-22', days: 3, holidayNames: ['測試紀念日'] },
    ]);
  });

  it('ignores inactive employees and employees with no work that month', () => {
    const input = baseInput({
      employees: [
        { id: 1, name: '陳文山', active: true, deletedAt: null },
        { id: 2, name: '林小美', active: true, deletedAt: null },
        { id: 3, name: '離職員工', active: false, deletedAt: null },
        { id: 4, name: '沒上班', active: true, deletedAt: null },
      ],
    });
    input.attendance.push(clockIn(3, '2026-11-14'));
    expect(buildPrepayrollReview(input).findings).toEqual([]);
  });
});
