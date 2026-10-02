import { describe, expect, it } from 'vitest';

import {
  buildAttendanceCsv,
  buildSalaryRecordCsv,
  salaryRecordFileName,
  type ExportSalaryRecord,
} from './historyExport';

const settledRecord: ExportSalaryRecord = {
  id: 41,
  revision: 0,
  salaryYear: 2026,
  salaryMonth: 9,
  employeeId: 7,
  employeeName: 'Test Employee',
  baseSalary: 12000,
  housingAllowance: 250,
  welfareAllowance: 100,
  allowances: [{ name: 'Test allowance', amount: 100, description: 'A "quoted" value' }],
  totalOT1Hours: 3,
  totalOT2Hours: 1,
  totalOvertimePay: 765,
  holidayDays: 0,
  holidayDailySalary: 400,
  totalHolidayPay: 0,
  grossSalary: 13115,
  deductions: [{ name: 'Test deduction', amount: 75 }],
  totalDeductions: 75,
  netSalary: 13040,
  attendanceData: [
    { date: '2026-09-24', clockIn: '08:00', clockOut: '19:00', isHoliday: false },
  ],
};

describe('finalized salary CSV exports', () => {
  it('uses snapshot totals without deriving pay from clocks or a current rate', () => {
    const before = structuredClone(settledRecord);
    const csv = buildSalaryRecordCsv(settledRecord);
    expect(csv).toContain('Overtime pay,765\r\n');
    expect(csv).toContain('Gross salary,13115\r\n');
    expect(csv).toContain('Net salary,13040\r\n');
    expect(csv).toContain('41,0,2026-09-24,08:00,19:00,No,,,,,\r\n');
    expect(csv).not.toContain('Daily OT Pay');
    expect(settledRecord).toEqual(before);
  });

  it('exports both corrected holidays with empty clocks and confirmed revision totals', () => {
    const corrected: ExportSalaryRecord = {
      ...settledRecord,
      revision: 1,
      holidayDays: 2,
      totalHolidayPay: 800,
      grossSalary: 13915,
      netSalary: 13840,
      attendanceData: [
        ...settledRecord.attendanceData!,
        { date: '2026-09-25', clockIn: '', clockOut: '', isHoliday: true, holidayType: 'national_holiday' },
        { date: '2026-09-28', isHoliday: true, holidayType: 'national_holiday' },
      ],
    };

    const csv = buildSalaryRecordCsv(corrected);
    const attendanceCsv = buildAttendanceCsv(corrected);
    expect(csv).toContain('Revision,1\r\n');
    expect(csv).toContain('Holiday days,2\r\n');
    expect(csv).toContain('Holiday pay,800\r\n');
    expect(csv).toContain('Net salary,13840\r\n');
    for (const date of ['2026-09-25', '2026-09-28']) {
      const row = `41,1,${date},,,Yes,national_holiday,,,,\r\n`;
      expect(csv).toContain(row);
      expect(attendanceCsv).toContain(row);
    }
    expect(attendanceCsv).not.toContain('NaN');
    expect(attendanceCsv.split('\r\n')).toHaveLength(5);
  });

  it('escapes formula-like employee names, deduction labels, notes and raw fields', () => {
    const csv = buildSalaryRecordCsv({
      ...settledRecord,
      employeeName: '\t=SUM(1)',
      deductions: [{ name: ' +SUM(2)', amount: -10 }],
      attendanceData: [{ date: '=SUM(3)', holidayType: '@SUM(4)', isHoliday: true }],
      specialLeaveInfo: { usedDays: 0, usedDates: [], cashDays: 0, cashAmount: 0, notes: '\u0000-SUM(5)' },
    });
    expect(csv).toContain("Employee,'\t=SUM(1)\r\n");
    expect(csv).toContain("' +SUM(2),-10\r\n");
    expect(csv).toContain("'=SUM(3)");
    expect(csv).toContain("'@SUM(4)");
    expect(csv).toContain("Notes,'\u0000-SUM(5)\r\n");
  });

  it('preserves commas, quotes and newlines in metadata and detail fields', () => {
    const csv = buildSalaryRecordCsv({
      ...settledRecord,
      employeeName: 'Test, "Employee"',
      deductions: [{ name: 'line one\nline two', amount: 75 }],
    });
    expect(csv).toContain('Employee,"Test, ""Employee"""\r\n');
    expect(csv).toContain('"line one\nline two",75\r\n');
  });

  it('exports unavailable legacy fields as blank instead of invented zero amounts', () => {
    const csv = buildSalaryRecordCsv({
      id: 42, salaryYear: 2026, salaryMonth: 9,
      baseSalary: 100, grossSalary: 100, netSalary: 100,
    });
    expect(csv).toContain('Holiday daily salary,\r\n');
    expect(csv).toContain('Overtime pay,\r\n');
    expect(buildAttendanceCsv({ ...settledRecord, attendanceData: null })).toBe(
      '\uFEFFRecord ID,Revision,Date,Clock In,Clock Out,Holiday,Holiday Type,Holiday ID,Barcode Scanned,OT1 hours snapshot,OT2 hours snapshot\r\n',
    );
  });

  it('匯出每日已保存的加班時數並保留零值，不從打卡時間重新計算', () => {
    const record: ExportSalaryRecord = {
      ...settledRecord,
      attendanceData: [
        { date: '2026-09-24', clockIn: '08:00', clockOut: '19:00', overtimeHours: { ot1: 1.25, ot2: 0 } },
        { date: '2026-09-25', clockIn: '08:00', clockOut: '19:00', overtimeHours: { ot1: 0, ot2: 0 } },
        { date: '2026-09-28', clockIn: '08:00', clockOut: '19:00' },
      ],
    };
    const before = structuredClone(record);
    for (const csv of [buildAttendanceCsv(record), buildSalaryRecordCsv(record)]) {
      expect(csv).toContain('OT1 hours snapshot,OT2 hours snapshot\r\n');
      expect(csv).toContain('2026-09-24,08:00,19:00,,,,,1.25,0\r\n');
      expect(csv).toContain('2026-09-25,08:00,19:00,,,,,0,0\r\n');
      expect(csv).toContain('2026-09-28,08:00,19:00,,,,,,\r\n');
      expect(csv).not.toContain('Daily OT Pay');
    }
    expect(record).toEqual(before);
  });

  it('keeps all exports identifiable and UTF-8 spreadsheet compatible', () => {
    expect(buildAttendanceCsv(settledRecord)).toMatch(/^\uFEFFRecord ID,Revision,/);
    expect(buildSalaryRecordCsv(settledRecord)).toMatch(/^\uFEFFSalary record,/);
    expect(buildSalaryRecordCsv(settledRecord)).toContain('Record ID,41\r\n');
  });

  it('generates distinct filenames for different records in the same month', () => {
    const first = salaryRecordFileName(settledRecord);
    const second = salaryRecordFileName({ ...settledRecord, id: 42 });
    expect(first).not.toBe(second);
    expect(first).toContain('record-41');
    expect(salaryRecordFileName({ ...settledRecord, revision: 1 })).toContain('_r1.csv');
    expect(salaryRecordFileName(settledRecord, 'attendance')).toMatch(/^attendance_/);
  });

  it('removes path, control and traversal characters from names and prefixes', () => {
    const fileName = salaryRecordFileName({
      ...settledRecord,
      employeeName: '../Test\\Employee:<>|?"*\u0000',
    }, '../attendance/unsafe');
    expect(fileName).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/);
    expect(fileName).not.toMatch(/^\./);
    expect(fileName).toContain('record-41');
    expect(fileName).toMatch(/\.csv$/);
    expect(salaryRecordFileName({ ...settledRecord, employeeName: '... ' }, '... ')).toMatch(
      /^salary-record_employee_/,
    );
  });
});
