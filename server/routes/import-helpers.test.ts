import { describe, expect, it } from 'vitest';

import {
  parseAttendanceImportCsv,
  parseSalaryImportCsv,
  splitCsvLine,
  toImportedHistoryAttendanceData,
  validateAttendanceImportRow,
  type AttendanceImportRow,
} from './import-helpers';

describe('import helpers', () => {
  it('parses quoted CSV fields with embedded commas', () => {
    expect(splitCsvLine('"日期","上班,時間","下班時間"')).toEqual([
      '日期',
      '上班,時間',
      '下班時間'
    ]);
  });

  it('parses attendance import rows and normalizes slash dates', () => {
    const csv = [
      '日期,上班時間,下班時間,是否假日',
      '2026-03-12,08:00,17:00,false',
      '2026/03/13,08:30,17:30,是'
    ].join('\n');

    const parsed = parseAttendanceImportCsv(csv);

    expect(parsed.rows).toEqual([
      {
        date: '2026/03/12',
        clockIn: '08:00',
        clockOut: '17:00',
        isHoliday: false
      },
      {
        date: '2026/03/13',
        clockIn: '08:30',
        clockOut: '17:30',
        isHoliday: true
      }
    ]);
    expect(parsed.result.successCount).toBe(2);
    expect(parsed.result.failCount).toBe(0);
  });

  it('rejects malformed attendance rows but keeps counting failures', () => {
    const csv = [
      '日期,上班時間,下班時間',
      '2026-03-12,08:00,17:00',
      'bad-date,08:00,17:00'
    ].join('\n');

    const parsed = parseAttendanceImportCsv(csv);

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.result.successCount).toBe(1);
    expect(parsed.result.failCount).toBe(1);
    expect(parsed.result.errors[0]).toContain('日期格式不正確');
  });

  it('parses salary import payload including attendance and deductions', () => {
    const csv = [
      '薪資年份,薪資月份,基本底薪,福利津貼,加班總時數OT1,加班總時數OT2,加班總費用,假日天數,假日總薪資,總薪資,總扣除額,實領金額',
      '2026,3,30000,500,10,5,2500,2,2000,35000,1200,33800',
      '扣除項目',
      '勞保費,300',
      '健保費,200',
      '考勤詳細記錄',
      '日期,上班時間,下班時間,是否假日',
      '2026-03-01,08:00,17:00,false',
      '2026/03/02,08:00,17:00,是'
    ].join('\n');

    expect(parseSalaryImportCsv(csv)).toEqual({
      salaryYear: 2026,
      salaryMonth: 3,
      baseSalary: 30000,
      housingAllowance: 0,
      welfareAllowance: 500,
      totalOT1Hours: 10,
      totalOT2Hours: 5,
      totalOvertimePay: 2500,
      holidayDays: 2,
      holidayDailySalary: 1000,
      totalHolidayPay: 2000,
      grossSalary: 35000,
      deductions: [
        { name: '勞保費', amount: 300 },
        { name: '健保費', amount: 200 }
      ],
      totalDeductions: 1200,
      netSalary: 33800,
      attendanceData: [
        { date: '2026/03/01', clockIn: '08:00', clockOut: '17:00', isHoliday: false },
        { date: '2026/03/02', clockIn: '08:00', clockOut: '17:00', isHoliday: true }
      ]
    });
  });

  it('converts imported attendance rows into historical snapshot rows', () => {
    expect(
      toImportedHistoryAttendanceData([
        { date: '2026/03/01', clockIn: '08:00', clockOut: '17:00', isHoliday: false }
      ])
    ).toEqual([
      {
        id: 1,
        date: '2026/03/01',
        clockIn: '08:00',
        clockOut: '17:00',
        isHoliday: false,
        isBarcodeScanned: false
      }
    ]);
  });

  it('手動出勤匯入可保留每日快照，雙空白維持舊資料未知狀態', () => {
    const parsed = parseAttendanceImportCsv([
      '日期,上班時間,下班時間,OT1 hours snapshot,OT2 hours snapshot',
      '2026-09-01,08:00,18:00,1.75,0',
      '2026-09-02,08:00,18:00,0,0',
      '2026-09-03,08:00,18:00,,',
    ].join('\n'));
    expect(parsed.result).toMatchObject({ successCount: 3, failCount: 0 });
    expect(parsed.rows.map(row => row.overtimeHours)).toEqual([{ ot1: 1.75, ot2: 0 }, { ot1: 0, ot2: 0 }, undefined]);
    const rebuilt = toImportedHistoryAttendanceData(parsed.rows);
    expect(rebuilt[0].overtimeHours).toEqual({ ot1: 1.75, ot2: 0 });
    expect(rebuilt[0].overtimeHours).not.toBe(parsed.rows[0].overtimeHours);
  });

  it('舊薪資格式的考勤區段也可保留每日時數快照', () => {
    const parsed = parseSalaryImportCsv([
      '薪資年份,薪資月份,基本底薪', '2026,9,10000', '考勤詳細記錄',
      '日期,上班時間,下班時間,OT1 hours snapshot,OT2 hours snapshot',
      '2026-09-01,08:00,19:00,2,0.25',
    ].join('\n'));
    expect(parsed.attendanceData[0].overtimeHours).toEqual({ ot1: 2, ot2: 0.25 });
  });

  it.each([
    { ot1: undefined, ot2: 0 }, { ot1: 0, ot2: undefined },
    { ot1: Number.NaN, ot2: 0 }, { ot1: 0, ot2: Number.POSITIVE_INFINITY },
    { ot1: -1, ot2: 0 }, { ot1: 0, ot2: 24.1 }, { ot1: '1', ot2: 0 }, null,
  ])('直接校驗拒絕不完整、非數字或超出範圍的時數 %j', overtimeHours => {
    expect(() => validateAttendanceImportRow({ date: '2026-09-01', clockIn: '08:00', clockOut: '18:00', isHoliday: false, overtimeHours: overtimeHours as unknown as AttendanceImportRow['overtimeHours'] })).toThrow('加班時數快照');
  });

  it('直接校驗接受 0 與上限 24，原有欄位保持不變', () => {
    const row = { date: '2026/09/01', clockIn: '08:00', clockOut: '18:00', isHoliday: false, overtimeHours: { ot1: 0, ot2: 24 } };
    expect(validateAttendanceImportRow(row)).toEqual(row);
  });

  it('缺少任一階段快照欄的手動 CSV 會回報清楚錯誤', () => {
    const parsed = parseAttendanceImportCsv('日期,上班時間,下班時間,OT1 hours snapshot\n2026-09-01,08:00,18:00,0');
    expect(parsed.result.failCount).toBe(1);
    expect(parsed.result.errors[0]).toContain('缺少第一階段或第二階段');
  });
});
