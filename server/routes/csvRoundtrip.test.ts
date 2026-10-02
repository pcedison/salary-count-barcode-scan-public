import { describe, expect, it } from 'vitest';
import { buildAttendanceCsv, buildSalaryRecordCsv, type ExportSalaryRecord } from '../../client/src/lib/historyExport';
import { encodeCsv, parseCsvRows } from '@shared/utils/csv';
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

  it('新出勤及薪資 CSV 往返保留每日已保存時數，包括零值，重建歷史資料不遺失', () => {
    const original = snapshot();
    original.attendanceData = original.attendanceData!.map((row, index) => ({ ...row, overtimeHours: index === 0 ? { ot1: 1.25, ot2: 0.5 } : { ot1: 0, ot2: 0 } }));
    const salaryParsed = parseSalaryImportCsv(buildSalaryRecordCsv(original));
    const attendanceParsed = parseAttendanceImportCsv(buildAttendanceCsv(original));
    expect(attendanceParsed.result.failCount).toBe(0);
    const expected = original.attendanceData.map(row => ({ ...row, date: row.date.replaceAll('-', '/') }));
    expect(salaryParsed.attendanceData).toEqual(expected);
    expect(attendanceParsed.rows).toEqual(expected);
    expect(toImportedHistoryAttendanceData(salaryParsed.attendanceData)).toEqual(expected.map((row, index) => ({ id: index + 1, ...row })));
    const second = parseSalaryImportCsv(buildSalaryRecordCsv({ ...original, attendanceData: salaryParsed.attendanceData }));
    expect(second.attendanceData).toEqual(expected);
    expect(second.totalOvertimePay).toBe(original.totalOvertimePay);
    expect(second.netSalary).toBe(original.netSalary);
  });

  it('舊版 CSV 缺少快照欄仍可匯入，新版雙空白也不發明每日時數', () => {
    const original = snapshot();
    for (const builder of [buildSalaryRecordCsv, buildAttendanceCsv]) {
      const newRows = parseCsvRows(builder(original));
      const headerIndex = newRows.findIndex(row => row.includes('OT1 hours snapshot'));
      const oldRows = newRows.map((row, index) => index >= headerIndex ? row.slice(0, -2) : row);
      const csv = encodeCsv(oldRows);
      const oldAttendance = builder === buildSalaryRecordCsv ? parseSalaryImportCsv(csv).attendanceData : parseAttendanceImportCsv(csv).rows;
      expect(oldAttendance.every(row => !Object.hasOwn(row, 'overtimeHours'))).toBe(true);
      const newAttendance = builder === buildSalaryRecordCsv ? parseSalaryImportCsv(builder(original)).attendanceData : parseAttendanceImportCsv(builder(original)).rows;
      expect(newAttendance.every(row => !Object.hasOwn(row, 'overtimeHours'))).toBe(true);
    }
  });

  it.each([
    ['1', '', '同時提供'], ['', '1', '同時提供'], ['NaN', '0', '有限數值'],
    ['0', 'Infinity', '有限數值'], ['-0.5', '0', '0 至 24'], ['0', '24.01', '0 至 24'],
    ['1e309', '0', '有限數值'], ['1hour', '0', '有限數值'],
  ])('拒絕不完整或無效的每日快照 %s／%s', (ot1, ot2, message) => {
    const rows = parseCsvRows(buildSalaryRecordCsv(snapshot()));
    const headerIndex = rows.findIndex(row => row.includes('OT1 hours snapshot'));
    rows[headerIndex + 1][9] = ot1;
    rows[headerIndex + 1][10] = ot2;
    expect(() => parseSalaryImportCsv(encodeCsv(rows))).toThrow(message);
    const manual = parseAttendanceImportCsv(encodeCsv(rows.slice(headerIndex)));
    expect(manual.result.failCount).toBe(1);
    expect(manual.result.errors[0]).toContain(message);
  });

  it('缺少單邊快照欄時拒絕薪資 CSV', () => {
    const rows = parseCsvRows(buildSalaryRecordCsv(snapshot()));
    const headerIndex = rows.findIndex(row => row.includes('OT1 hours snapshot'));
    for (let index = headerIndex; index < rows.length; index += 1) rows[index].pop();
    expect(() => parseSalaryImportCsv(encodeCsv(rows))).toThrow('缺少第一階段或第二階段');
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
