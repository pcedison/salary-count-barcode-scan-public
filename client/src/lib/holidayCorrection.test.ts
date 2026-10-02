import { describe, expect, it } from 'vitest';
import { correctionErrorMessage, correctionMonthBounds, normalizeSnapshotDate, validateHolidayCorrection, type CorrectionSalaryRecord, type HolidayCorrectionInput } from './holidayCorrection';
const record: CorrectionSalaryRecord = {
  id: 101, revision: 0, employeeId: 7, employeeName: 'Synthetic Employee', salaryYear: 2026, salaryMonth: 9,
  grossSalary: 30000, totalDeductions: 1000, netSalary: 29000, totalHolidayPay: 0, holidayDays: 0,
  attendanceData: [{ date: '2026/9/2', clockIn: '08:00', clockOut: '17:00', isHoliday: false }],
};
const holiday = (date: string, mode: 'add' | 'replace' = 'add'): HolidayCorrectionInput => ({ date, holidayType: 'national_holiday', name: 'Synthetic Holiday', mode });
const validate = (rows: HolidayCorrectionInput[], reason = 'Synthetic correction', payment = 'unpaid', source = record) => validateHolidayCorrection(source, rows, reason, payment);
describe('historical holiday correction form validation', () => {
  it('accepts both omitted September dates for one employee/month without changing the snapshot', () => {
    const before = structuredClone(record);
    expect(validate([holiday('2026-09-25'), holiday('2026-09-28')])).toBeNull();
    expect(record).toEqual(before);
  });
  it('rejects repeat dates within one correction', () => expect(validate([holiday('2026-09-25'), holiday('2026-09-25')])).toContain('重複日期'));
  it('rejects an add over existing archived attendance', () => expect(validate([holiday('2026-09-02')])).toContain('已有出勤'));
  it('permits explicit replacement over a slash-formatted legacy date', () => expect(validate([holiday('2026-09-02', 'replace')])).toBeNull());
  it('rejects replacement of an absent date', () => expect(validate([holiday('2026-09-25', 'replace')])).toContain('沒有既有紀錄'));
  it('also detects a date that already has a leave entry without clocks', () => expect(validate([holiday('2026-09-25')], undefined, undefined, { ...record, attendanceData: [{ date: '2026-09-25', holidayType: 'national_holiday' }] })).toContain('已有出勤'));
  it.each(['2026-08-31', '2026-10-01', '2026-09-31', '2026-9-25', 'invalid'])('rejects invalid/cross-month date %s', (date) => expect(validate([holiday(date)])).toContain('此結算月份'));
  it('rejects an empty correction', () => expect(validate([])).toContain('1 至 31'));
  it('requires a reason and explicit payment state', () => {
    expect(validate([holiday('2026-09-25')], ' ')).toContain('原因');
    expect(validate([holiday('2026-09-25')], undefined, '')).toContain('發薪狀態');
  });
  it.each(['unpaid', 'paid_adjustment', 'unknown_adjustment'])('accepts explicit %s handling', (payment) => expect(validate([holiday('2026-09-25')], undefined, payment)).toBeNull());
  it('rejects records without a valid employee or revision', () => {
    expect(validate([holiday('2026-09-25')], undefined, undefined, { ...record, employeeId: null })).toContain('未指定員工');
    expect(validate([holiday('2026-09-25')], undefined, undefined, { ...record, revision: -1 })).toContain('重新讀取');
  });
  it('rejects unsupported or prototype category/payment keys', () => {
    expect(validate([{ ...holiday('2026-09-25'), holidayType: '__proto__' as never }])).toContain('支援');
    expect(validate([holiday('2026-09-25')], undefined, 'constructor')).toContain('發薪狀態');
  });
  it('rejects a blank holiday name and excessive reason', () => {
    expect(validate([{ ...holiday('2026-09-25'), name: ' ' }])).toContain('假日名稱');
    expect(validate([holiday('2026-09-25')], 'x'.repeat(1001))).toContain('1000');
  });
});
describe('correction dates and errors', () => {
  it('uses the exact month end including leap February', () => {
    expect(correctionMonthBounds(record)).toEqual({ min: '2026-09-01', max: '2026-09-30', month: '2026-09' });
    expect(correctionMonthBounds({ salaryYear: 2024, salaryMonth: 2 }).max).toBe('2024-02-29');
  });
  it('normalizes archived slash/ISO dates without parsing in local timezone', () => {
    expect(normalizeSnapshotDate('2026/9/2')).toBe('2026-09-02');
    expect(normalizeSnapshotDate('2026-09-02T00:00:00Z')).toBe('2026-09-02');
  });
  it('shows a concurrency recovery path and hides unknown internal error details', () => {
    expect(correctionErrorMessage(new Error('400: {"message":"Validation error","errors":[{"path":["deductions",0,"description"]}]}'))).toBe('更正內容未通過檢查，請確認各項金額、更正原因與發薪狀態。');
    expect(correctionErrorMessage(new Error('409: stale'))).toContain('重新讀取');
    expect(correctionErrorMessage(new Error('500: internal connection details'))).not.toContain('connection');
    expect(correctionErrorMessage(new Error('403: forbidden'))).toContain('重新登入');
  });
});
