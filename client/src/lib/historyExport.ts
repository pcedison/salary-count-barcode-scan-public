import { encodeCsv, type CsvCell } from '@shared/utils/csv';

export interface ExportAttendanceSnapshot {
  date: string;
  clockIn?: string | null;
  clockOut?: string | null;
  isHoliday?: boolean | null;
  holidayType?: string | null;
  holidayId?: number | null;
  isBarcodeScanned?: boolean | null;
}

export interface ExportSalaryRecord {
  id: number;
  revision?: number;
  salaryYear: number;
  salaryMonth: number;
  employeeId?: number | null;
  employeeName?: string | null;
  baseSalary: number;
  housingAllowance?: number | null;
  welfareAllowance?: number | null;
  allowances?: ReadonlyArray<{ name: string; amount: number; description?: string }> | null;
  totalOT1Hours?: number | null;
  totalOT2Hours?: number | null;
  totalOvertimePay?: number | null;
  holidayDays?: number | null;
  holidayDailySalary?: number | null;
  holidayCalculationBaseSalary?: number | null;
  totalHolidayPay?: number | null;
  grossSalary: number;
  deductions?: ReadonlyArray<{ name: string; amount: number }> | null;
  totalDeductions?: number | null;
  netSalary: number;
  attendanceData?: ReadonlyArray<ExportAttendanceSnapshot> | null;
  specialLeaveInfo?: {
    usedDays: number;
    usedDates: string[];
    cashDays: number;
    cashAmount: number;
    cashMonth?: string;
    notes?: string;
  } | null;
  createdAt?: string | Date | null;
}

function attendanceRows(record: ExportSalaryRecord): CsvCell[][] {
  return [
    ['Record ID', 'Revision', 'Date', 'Clock In', 'Clock Out', 'Holiday', 'Holiday Type', 'Holiday ID', 'Barcode Scanned'],
    ...(record.attendanceData ?? []).map((attendance) => [
      record.id,
      record.revision ?? 0,
      attendance.date,
      attendance.clockIn,
      attendance.clockOut,
      attendance.isHoliday === null || attendance.isHoliday === undefined
        ? '' : attendance.isHoliday ? 'Yes' : 'No',
      attendance.holidayType,
      attendance.holidayId,
      attendance.isBarcodeScanned === null || attendance.isBarcodeScanned === undefined
        ? '' : attendance.isBarcodeScanned ? 'Yes' : 'No',
    ]),
  ];
}

/** Export only persisted settlement values, including any confirmed correction. */
export function buildSalaryRecordCsv(record: ExportSalaryRecord): string {
  const createdAt = record.createdAt instanceof Date
    ? record.createdAt.toISOString() : record.createdAt;
  const rows: CsvCell[][] = [
    ['Salary record', `${record.salaryYear}/${record.salaryMonth}`],
    ['Record ID', record.id],
    ['Revision', record.revision ?? 0],
    ['Employee ID', record.employeeId],
    ['Employee', record.employeeName],
    ['Year', record.salaryYear],
    ['Month', record.salaryMonth],
    ['Created at', createdAt],
    [],
    ['Finalized summary'],
    ['Base salary', record.baseSalary],
    ['Housing allowance', record.housingAllowance],
    ['Welfare allowance', record.welfareAllowance],
    ['OT1 hours', record.totalOT1Hours],
    ['OT2 hours', record.totalOT2Hours],
    ['Overtime pay', record.totalOvertimePay],
    ['Holiday days', record.holidayDays],
    ['Holiday daily salary', record.holidayDailySalary],
    ['Holiday calculation base salary', record.holidayCalculationBaseSalary],
    ['Holiday pay', record.totalHolidayPay],
    ['Gross salary', record.grossSalary],
    ['Deductions', record.totalDeductions],
    ['Net salary', record.netSalary],
    [],
    ['Allowances detail'],
    ['Name', 'Amount', 'Description'],
    ...(record.allowances ?? []).map((item) => [item.name, item.amount, item.description]),
    [],
    ['Deductions detail'],
    ['Name', 'Amount'],
    ...(record.deductions ?? []).map((item) => [item.name, item.amount]),
  ];

  if (record.specialLeaveInfo) {
    const leave = record.specialLeaveInfo;
    rows.push(
      [],
      ['Special leave snapshot'],
      ['Used days', leave.usedDays],
      ['Used dates', leave.usedDates.join(', ')],
      ['Cash days', leave.cashDays],
      ['Cash amount', leave.cashAmount],
      ['Cash month', leave.cashMonth],
      ['Notes', leave.notes],
    );
  }

  rows.push([], ['Finalized attendance snapshot'], ...attendanceRows(record));
  return encodeCsv(rows);
}

/** Raw clock and holiday fields belong to this record, with no current-rule recalculation. */
export function buildAttendanceCsv(record: ExportSalaryRecord): string {
  return encodeCsv(attendanceRows(record));
}

function fileNamePart(value: string, fallback: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60);
  return sanitized || fallback;
}

export function salaryRecordFileName(
  record: ExportSalaryRecord,
  prefix = 'salary-record',
): string {
  return `${fileNamePart(prefix, 'salary-record')}_${fileNamePart(record.employeeName ?? '', 'employee')}_${record.salaryYear}_${record.salaryMonth}_record-${record.id}_r${record.revision ?? 0}.csv`;
}
