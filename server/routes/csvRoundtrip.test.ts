import { describe, expect, it } from 'vitest';
import { buildAttendanceCsv, buildSalaryRecordCsv, type ExportSalaryRecord } from '../../client/src/lib/historyExport';
import { parseCsvRows } from '@shared/utils/csv';
import { parseAttendanceImportCsv, parseSalaryImportCsv, toImportedHistoryAttendanceData } from './import-helpers';

function snapshot(): ExportSalaryRecord {
  return { id: 7, revision: 2, employeeId: 11, employeeName: 'Synthetic, "employee"\nsecond line', salaryYear: 2026, salaryMonth: 9, baseSalary: 24000, housingAllowance: 123.45, welfareAllowance: 200.25, allowances: [{ name: 'Allowance, "quoted"\nnext line', amount: 200.25, description: 'Description, "quoted"\r\nnext line' }], totalOT1Hours: 1.25, totalOT2Hours: 0.5, totalOvertimePay: 432.1, holidayDays: 1, holidayDailySalary: 1000, holidayCalculationBaseSalary: 30000, totalHolidayPay: 1000, grossSalary: 25755.8, deductions: [{ name: 'Deduction, "quoted"\nnext line', amount: 50.75 }], totalDeductions: 50.75, netSalary: 25705.05, specialLeaveInfo: { usedDays: 1, usedDates: ['2026-09-01'], cashDays: 0, cashAmount: 0, cashMonth: '2026-09', notes: 'Snapshot, "note"\nnext line' }, attendanceData: [
    { date: '2026-09-24', clockIn: '08:00', clockOut: '18:30', isHoliday: false, holidayType: null, holidayId: null, isBarcodeScanned: true },
    { date: '2026-09-25', clockIn: '--:--', clockOut: '--:--', isHoliday: true, holidayType: 'national_holiday', holidayId: null, isBarcodeScanned: false },
    { date: '2026-09-28', clockIn: '08:00', clockOut: '17:00', isHoliday: true, holidayType: 'worked', holidayId: 4, isBarcodeScanned: true },
  ] };
}

describe('real finalized CSV export to server parser round trips', () => {
  it('retains exact persisted money, calculation basis, labels and special-leave snapshot across quoted multiline CSV', () => {
    const original = snapshot();
    const parsed = parseSalaryImportCsv(buildSalaryRecordCsv(original));
    for (const key of ['employeeId', 'employeeName', 'salaryYear', 'salaryMonth', 'baseSalary', 'housingAllowance', 'welfareAllowance', 'allowances', 'totalOT1Hours', 'totalOT2Hours', 'totalOvertimePay', 'holidayDays', 'holidayDailySalary', 'holidayCalculationBaseSalary', 'totalHolidayPay', 'grossSalary', 'deductions', 'totalDeductions', 'netSalary', 'specialLeaveInfo'] as const) expect(parsed[key]).toEqual(original[key]);
    expect(parsed.snapshotRevision).toBe(2);
    expect(parsed.attendanceData).toEqual(original.attendanceData!.map(row => ({ ...row, date: row.date.replaceAll('-', '/') })));
    expect(toImportedHistoryAttendanceData(parsed.attendanceData)).toEqual(parsed.attendanceData.map((row, index) => ({ id: index + 1, ...row })));
  });

  it('retains absent national holidays and worked classification through the standalone attendance export', () => {
    const parsed = parseAttendanceImportCsv(buildAttendanceCsv(snapshot()));
    expect(parsed.result).toMatchObject({ successCount: 3, failCount: 0, totalRecords: 3 });
    expect(parsed.rows).toEqual(snapshot().attendanceData!.map(row => ({ ...row, date: row.date.replaceAll('-', '/') })));
  });

  it.each([['', ''], ['--:--', '--:--']])('accepts missing clocks only as non-worked holiday placeholders: %j', (clockIn, clockOut) => {
    const original = snapshot(); original.attendanceData = [{ date: '2026-09-25', clockIn, clockOut, isHoliday: true, holidayType: 'national_holiday' }];
    const parsed = parseSalaryImportCsv(buildSalaryRecordCsv(original));
    expect(parsed.attendanceData[0]).toMatchObject({ clockIn: '--:--', clockOut: '--:--', holidayType: 'national_holiday', isHoliday: true });
  });

  it.each([false, true])('rejects missing clocks for ordinary or worked attendance without inventing hours: %s', (isHoliday) => {
    const original = snapshot(); original.attendanceData = [{ date: '2026-09-25', clockIn: '--:--', clockOut: '--:--', isHoliday, holidayType: isHoliday ? 'worked' : null }];
    expect(() => parseSalaryImportCsv(buildSalaryRecordCsv(original))).toThrow('上班時間格式不正確');
  });

  it('keeps formula-protection prefixes safe during parsing and repeated export', () => {
    const original = snapshot(); original.employeeName = '=SUM(1)'; original.allowances = [{ name: '@SUM(2)', amount: 200.25, description: '\t+SUM(3)' }];
    const csv = buildSalaryRecordCsv(original);
    expect(csv).toContain("Employee,'=SUM(1)");
    const parsed = parseSalaryImportCsv(csv);
    expect(parsed.employeeName).toBe("'=SUM(1)");
    expect(parsed.allowances).toEqual([{ name: "'@SUM(2)", amount: 200.25, description: "'\t+SUM(3)" }]);
    const second = buildSalaryRecordCsv({ ...original, employeeName: parsed.employeeName, allowances: parsed.allowances });
    expect(second).toContain("Employee,'=SUM(1)");
    expect(second).not.toContain('Employee,=SUM(1)');
  });

  it('preserves unknown optional legacy amounts as null and accepts an empty archived attendance snapshot', () => {
    const parsed = parseSalaryImportCsv(buildSalaryRecordCsv({ id: 9, revision: 0, salaryYear: 2026, salaryMonth: 9, baseSalary: 100, grossSalary: 100, netSalary: 100, attendanceData: [] }));
    expect(parsed.holidayCalculationBaseSalary).toBeNull(); expect(parsed.totalOvertimePay).toBeNull(); expect(parsed.holidayDailySalary).toBeNull(); expect(parsed.attendanceData).toEqual([]);
  });

  it('rejects malformed quotes, impossible dates and duplicate archived dates', () => {
    expect(() => parseCsvRows('a,"unterminated')).toThrow('Unclosed');
    const original = snapshot(); original.attendanceData = [{ date: '2026-09-31', clockIn: '', clockOut: '', isHoliday: true, holidayType: 'national_holiday' }];
    expect(() => parseSalaryImportCsv(buildSalaryRecordCsv(original))).toThrow('日曆日期');
    original.attendanceData = [snapshot().attendanceData![0], snapshot().attendanceData![0]];
    expect(() => parseSalaryImportCsv(buildSalaryRecordCsv(original))).toThrow('Duplicate');
  });
});
