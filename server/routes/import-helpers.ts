import { normalizeDateToSlash } from '@shared/utils/specialLeaveSync';
import { parseCsvRows } from '@shared/utils/csv';
import { payrollHolidayTypes } from '@shared/payrollCorrection';
import { parseClockTimeMinutes } from '@shared/utils/salaryMath';

export interface ImportResult {
  success: boolean;
  totalRecords?: number;
  successCount?: number;
  failCount?: number;
  errors?: string[];
  message?: string;
  record?: unknown;
}

export interface AttendanceImportRow {
  date: string;
  clockIn: string;
  clockOut: string;
  isHoliday: boolean;
  holidayType?: string | null;
  holidayId?: number | null;
  isBarcodeScanned?: boolean;
  overtimeHours?: { ot1: number; ot2: number };
}

export interface SalaryRecordImportPayload {
  snapshotRevision?: number;
  salaryYear: number;
  salaryMonth: number;
  baseSalary: number;
  employeeId?: number;
  employeeName?: string;
  housingAllowance: number | null;
  welfareAllowance: number | null;
  allowances?: Array<{ name: string; amount: number; description?: string }>;
  totalOT1Hours: number | null;
  totalOT2Hours: number | null;
  totalOvertimePay: number | null;
  holidayDays: number | null;
  holidayDailySalary: number | null;
  holidayCalculationBaseSalary?: number | null;
  totalHolidayPay: number | null;
  grossSalary: number;
  deductions: Array<{ name: string; amount: number }>;
  totalDeductions: number | null;
  netSalary: number;
  specialLeaveInfo?: { usedDays: number; usedDates: string[]; cashDays: number; cashAmount: number; cashMonth?: string; notes?: string } | null;
  attendanceData: AttendanceImportRow[];
}

export interface ImportedHistoryAttendanceRow {
  id: number;
  date: string;
  clockIn: string;
  clockOut: string;
  isHoliday: boolean;
  isBarcodeScanned: boolean;
  overtimeHours?: { ot1: number; ot2: number };
  employeeId?: number;
  holidayId?: number | null;
  holidayType?: string | null;
  createdAt?: Date;
}

const DATE_PATTERN = /^\d{4}[-/](0?[1-9]|1[012])[-/](0?[1-9]|[12][0-9]|3[01])$/;
const MAX_IMPORT_ROWS = 5000;

export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  fields.push(current.trim());
  return fields.map(field => field.replace(/^\uFEFF/, '').trim());
}

export function splitCsvContent(csvContent: string): string[] {
  return csvContent
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0);
}

export function parseBooleanCsvValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '是' || normalized === 'true' || normalized === '1' || normalized === 'yes';
}

export function parseRequiredInteger(value: string | undefined, fieldName: string): number {
  const parsed = Number.parseInt(value || '', 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${fieldName}格式不正確`);
  }
  return parsed;
}

export function parseOptionalInteger(value: string | undefined): number {
  const parsed = Number.parseInt((value || '').trim(), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function parseOptionalFloat(value: string | undefined): number {
  const parsed = Number.parseFloat((value || '').trim());
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function validateAttendanceImportRow(row: AttendanceImportRow): AttendanceImportRow {
  if (row.overtimeHours !== undefined) {
    for (const [stage, hours] of [['第一階段', row.overtimeHours?.ot1], ['第二階段', row.overtimeHours?.ot2]] as const) {
      if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 || hours > 24) {
        throw new Error(`${stage}加班時數快照必須是 0 至 24 的有限數值，兩階段都須提供`);
      }
    }
  }
  if (!DATE_PATTERN.test(row.date)) {
    throw new Error(`日期格式不正確: ${row.date}`);
  }
  const [year, month, day] = row.date.split(/[-/]/).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('日期不是有效的日曆日期');
  }
  if (row.holidayType && !(payrollHolidayTypes as readonly string[]).includes(row.holidayType)) {
    throw new Error('假日類別不正確');
  }
  if (row.holidayType && !row.isHoliday) throw new Error('假日類別與假日標記不一致');
  const missingClock = (value: string) => value === '' || value === '--:--' || value === "'--:--";
  const absentHoliday = row.isHoliday && row.holidayType !== 'worked' && missingClock(row.clockIn) && missingClock(row.clockOut);

  if (!absentHoliday && parseClockTimeMinutes(row.clockIn) === null) {
    throw new Error(`上班時間格式不正確: ${row.clockIn}`);
  }

  if (!absentHoliday && parseClockTimeMinutes(row.clockOut) === null) {
    throw new Error(`下班時間格式不正確: ${row.clockOut}`);
  }

  return {
    ...row,
    ...(absentHoliday ? { clockIn: '--:--', clockOut: '--:--' } : {}),
    date: normalizeDateToSlash(row.date)
  };
}

function findRequiredColumnIndex(headers: string[], fieldName: string): number {
  const aliases: Record<string, string> = { '日期': 'Date', '上班時間': 'Clock In', '下班時間': 'Clock Out' };
  const index = headers.findIndex(header => header === fieldName || header === aliases[fieldName]);
  if (index === -1) {
    throw new Error(`CSV檔案格式不正確，缺少必要欄位 (${fieldName})`);
  }
  return index;
}

function parseOvertimeHoursSnapshot(headers: string[], fields: string[]): AttendanceImportRow['overtimeHours'] {
  const ot1Index = headers.indexOf('OT1 hours snapshot');
  const ot2Index = headers.indexOf('OT2 hours snapshot');
  if (ot1Index === -1 && ot2Index === -1) return undefined;
  if (ot1Index === -1 || ot2Index === -1) throw new Error('加班時數快照缺少第一階段或第二階段欄位');
  const ot1 = fields[ot1Index]?.trim() ?? '';
  const ot2 = fields[ot2Index]?.trim() ?? '';
  if (!ot1 && !ot2) return undefined;
  if (!ot1 || !ot2) throw new Error('加班時數快照必須同時提供第一階段與第二階段，無加班請填 0');
  const parseHours = (value: string, stage: string) => {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
      throw new Error(`${stage}加班時數快照必須是 0 至 24 的有限數值`);
    }
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
      throw new Error(`${stage}加班時數快照必須是 0 至 24 的有限數值`);
    }
    return hours;
  };
  return { ot1: parseHours(ot1, '第一階段'), ot2: parseHours(ot2, '第二階段') };
}

export function parseAttendanceImportCsv(csvContent: string): {
  rows: AttendanceImportRow[];
  result: Required<Pick<ImportResult, 'success' | 'totalRecords' | 'successCount' | 'failCount' | 'errors'>>;
} {
  const lines = parseCsvRows(csvContent).filter(row => row.some(cell => cell.trim()));
  if (lines.length < 2) {
    throw new Error('CSV檔案格式不正確或內容為空');
  }

  // Guard against excessively large imports that could block the event loop
  const dataRowCount = lines.length - 1; // subtract header
  if (dataRowCount > MAX_IMPORT_ROWS) {
    throw new Error(`CSV 超過最大匯入行數限制（${dataRowCount} 筆，上限 ${MAX_IMPORT_ROWS} 筆）`);
  }

  const headers = lines[0].map(cell => cell.trim());
  const dateIndex = findRequiredColumnIndex(headers, '日期');
  const clockInIndex = findRequiredColumnIndex(headers, '上班時間');
  const clockOutIndex = findRequiredColumnIndex(headers, '下班時間');
  const isHolidayIndex = headers.findIndex(header => header === '是否假日' || header === 'Holiday');
  const holidayTypeIndex = headers.findIndex(header => header === '假日類別' || header === 'Holiday Type');
  const holidayIdIndex = headers.findIndex(header => header === '假日ID' || header === 'Holiday ID');
  const barcodeIndex = headers.findIndex(header => header === '條碼掃描' || header === 'Barcode Scanned');

  const rows: AttendanceImportRow[] = [];
  const result = {
    success: true,
    totalRecords: 0,
    successCount: 0,
    failCount: 0,
    errors: [] as string[]
  };

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const fields = lines[lineIndex];
    if (fields.length <= Math.max(dateIndex, clockInIndex, clockOutIndex)) {
      result.failCount += 1;
      result.errors.push(`第 ${lineIndex + 1} 行: 欄位數量不足`);
      continue;
    }

    try {
      const overtimeHours = parseOvertimeHoursSnapshot(headers, fields);
      const row = validateAttendanceImportRow({
        date: fields[dateIndex].trim(),
        clockIn: fields[clockInIndex].trim(),
        clockOut: fields[clockOutIndex].trim(),
        isHoliday: isHolidayIndex !== -1 ? parseBooleanCsvValue(fields[isHolidayIndex]) : false,
        ...(holidayTypeIndex !== -1 ? { holidayType: fields[holidayTypeIndex]?.trim() || null } : {}),
        ...(holidayIdIndex !== -1 ? { holidayId: fields[holidayIdIndex]?.trim() ? snapshotNumber(fields[holidayIdIndex], 'Holiday ID') : null } : {}),
        ...(barcodeIndex !== -1 ? { isBarcodeScanned: parseBooleanCsvValue(fields[barcodeIndex]) } : {}),
        ...(overtimeHours !== undefined ? { overtimeHours } : {})
      });

      rows.push(row);
      result.successCount += 1;
    } catch (error) {
      result.failCount += 1;
      result.errors.push(
        `第 ${lineIndex + 1} 行: ${error instanceof Error ? error.message : '未知錯誤'}`
      );
    } finally {
      result.totalRecords += 1;
    }
  }

  return { rows, result };
}

export function parseSalaryImportCsv(csvContent: string): SalaryRecordImportPayload {
  const snapshotRows = parseCsvRows(csvContent);
  if (snapshotRows[0]?.[0] === 'Salary record') return parseSalarySnapshotRows(snapshotRows);
  const lines = splitCsvContent(csvContent);
  if (lines.length < 2) {
    throw new Error('CSV檔案格式不正確或內容為空');
  }

  if (lines.length - 1 > MAX_IMPORT_ROWS) {
    throw new Error(`CSV 超過最大匯入行數限制（上限 ${MAX_IMPORT_ROWS} 筆）`);
  }

  const headers = splitCsvLine(lines[0]);
  const dataRow = splitCsvLine(lines[1]);

  const yearIndex = findRequiredColumnIndex(headers, '薪資年份');
  const monthIndex = findRequiredColumnIndex(headers, '薪資月份');
  const baseSalaryIndex = findRequiredColumnIndex(headers, '基本底薪');

  const year = parseRequiredInteger(dataRow[yearIndex], '薪資年份');
  const month = parseRequiredInteger(dataRow[monthIndex], '薪資月份');

  let attendanceHeaderIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes('考勤詳細記錄')) {
      attendanceHeaderIndex = index + 1;
      break;
    }
  }

  if (attendanceHeaderIndex === -1 || attendanceHeaderIndex >= lines.length) {
    throw new Error('CSV檔案格式不正確，找不到考勤詳細記錄區段');
  }

  const attendanceHeaders = splitCsvLine(lines[attendanceHeaderIndex]);
  const dateIndex = findRequiredColumnIndex(attendanceHeaders, '日期');
  const clockInIndex = findRequiredColumnIndex(attendanceHeaders, '上班時間');
  const clockOutIndex = findRequiredColumnIndex(attendanceHeaders, '下班時間');
  const isHolidayIndex = attendanceHeaders.findIndex(header => header === '是否假日');

  const attendanceData: AttendanceImportRow[] = [];
  for (let lineIndex = attendanceHeaderIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const fields = splitCsvLine(lines[lineIndex]);
    if (fields.length <= Math.max(dateIndex, clockInIndex, clockOutIndex)) {
      continue;
    }

    const date = fields[dateIndex];
    const clockIn = fields[clockInIndex];
    const clockOut = fields[clockOutIndex];

    if (!date || !clockIn || !clockOut) {
      continue;
    }

    const overtimeHours = parseOvertimeHoursSnapshot(attendanceHeaders, fields);
    attendanceData.push(
      validateAttendanceImportRow({
        date,
        clockIn,
        clockOut,
        isHoliday: isHolidayIndex !== -1 ? parseBooleanCsvValue(fields[isHolidayIndex]) : false,
        ...(overtimeHours !== undefined ? { overtimeHours } : {}),
      })
    );
  }

  if (attendanceData.length === 0) {
    throw new Error('沒有有效的考勤記錄可匯入');
  }

  let deductionHeaderIndex = -1;
  for (let index = 2; index < attendanceHeaderIndex; index += 1) {
    if (lines[index].includes('扣除項目')) {
      deductionHeaderIndex = index;
      break;
    }
  }

  const deductions: Array<{ name: string; amount: number }> = [];
  if (deductionHeaderIndex !== -1) {
    for (let lineIndex = deductionHeaderIndex + 1; lineIndex < attendanceHeaderIndex; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line || line.includes('考勤詳細記錄')) {
        break;
      }

      const fields = splitCsvLine(line);
      if (fields.length < 2) {
        continue;
      }

      const name = fields[0];
      const amount = parseOptionalInteger(fields[1]);
      if (name) {
        deductions.push({ name, amount });
      }
    }
  }

  const housingAllowanceIndex = headers.findIndex(header => header === '住宿津貼');
  const welfareAllowanceIndex = headers.findIndex(header => header === '福利津貼');
  const ot1HoursIndex = headers.findIndex(header => header === '加班總時數OT1');
  const ot2HoursIndex = headers.findIndex(header => header === '加班總時數OT2');
  const overtimePayIndex = headers.findIndex(header => header === '加班總費用');
  const holidayDaysIndex = headers.findIndex(header => header === '假日天數');
  const holidayPayIndex = headers.findIndex(header => header === '假日總薪資');
  const grossSalaryIndex = headers.findIndex(header => header === '總薪資');
  const totalDeductionsIndex = headers.findIndex(header => header === '總扣除額');
  const netSalaryIndex = headers.findIndex(header => header === '實領金額');

  const holidayDays =
    holidayDaysIndex !== -1 ? parseOptionalInteger(dataRow[holidayDaysIndex]) : 0;
  const totalHolidayPay =
    holidayPayIndex !== -1 ? parseOptionalInteger(dataRow[holidayPayIndex]) : 0;

  return {
    salaryYear: year,
    salaryMonth: month,
    baseSalary: parseOptionalInteger(dataRow[baseSalaryIndex]),
    housingAllowance:
      housingAllowanceIndex !== -1 ? parseOptionalInteger(dataRow[housingAllowanceIndex]) : 0,
    welfareAllowance:
      welfareAllowanceIndex !== -1 ? parseOptionalInteger(dataRow[welfareAllowanceIndex]) : 0,
    totalOT1Hours: ot1HoursIndex !== -1 ? parseOptionalFloat(dataRow[ot1HoursIndex]) : 0,
    totalOT2Hours: ot2HoursIndex !== -1 ? parseOptionalFloat(dataRow[ot2HoursIndex]) : 0,
    totalOvertimePay:
      overtimePayIndex !== -1 ? parseOptionalInteger(dataRow[overtimePayIndex]) : 0,
    holidayDays,
    holidayDailySalary:
      holidayDays > 0 && totalHolidayPay > 0 ? Math.ceil(totalHolidayPay / holidayDays) : 0,
    totalHolidayPay,
    grossSalary: grossSalaryIndex !== -1 ? parseOptionalInteger(dataRow[grossSalaryIndex]) : 0,
    deductions,
    totalDeductions:
      totalDeductionsIndex !== -1 ? parseOptionalInteger(dataRow[totalDeductionsIndex]) : 0,
    netSalary: netSalaryIndex !== -1 ? parseOptionalInteger(dataRow[netSalaryIndex]) : 0,
    attendanceData
  };
}

export function toImportedHistoryAttendanceData(
  rows: AttendanceImportRow[]
): ImportedHistoryAttendanceRow[] {
  return rows.map((row, index) => ({
    id: index + 1,
    date: row.date,
    clockIn: row.clockIn,
    clockOut: row.clockOut,
    isHoliday: row.isHoliday,
    isBarcodeScanned: row.isBarcodeScanned ?? false,
    ...(row.holidayType !== undefined ? { holidayType: row.holidayType } : {}),
    ...(row.holidayId !== undefined ? { holidayId: row.holidayId } : {}),
    ...(row.overtimeHours !== undefined ? { overtimeHours: { ...row.overtimeHours } } : {})
  }));
}

function snapshotNumber(value: string | undefined, field: string): number {
  if (value === undefined || !value.trim() || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) throw new Error(`Missing or invalid snapshot field: ${field}`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Invalid snapshot amount: ${field}`);
  return number;
}

function parseSalarySnapshotRows(rows: string[][]): SalaryRecordImportPayload {
  if (rows.length > MAX_IMPORT_ROWS) throw new Error('CSV exceeds the import row limit.');
  const sectionIndex = (name: string) => rows.findIndex(row => row[0] === name && row.slice(1).every(cell => !cell));
  const summaryIndex = sectionIndex('Finalized summary');
  const allowancesIndex = sectionIndex('Allowances detail');
  const deductionsIndex = sectionIndex('Deductions detail');
  const leaveIndex = sectionIndex('Special leave snapshot');
  const attendanceIndex = sectionIndex('Finalized attendance snapshot');
  if (summaryIndex < 0 || allowancesIndex < summaryIndex || deductionsIndex < allowancesIndex || attendanceIndex < deductionsIndex) throw new Error('Incomplete salary snapshot sections.');
  const fields = new Map<string, string>();
  for (const row of rows.slice(1, allowancesIndex)) {
    if (row.length === 2) {
      if (fields.has(row[0])) throw new Error('Duplicate salary snapshot field.');
      fields.set(row[0], row[1]);
    }
  }
  const amount = (name: string) => snapshotNumber(fields.get(name), name);
  const optionalAmount = (name: string) => fields.get(name)?.trim() ? amount(name) : null;
  const integer = (name: string) => { const value = amount(name); if (!Number.isSafeInteger(value)) throw new Error(`Invalid integer: ${name}`); return value; };
  const employeeId = fields.get('Employee ID')?.trim() ? integer('Employee ID') : undefined;
  if (employeeId !== undefined && employeeId <= 0) throw new Error('Invalid employee ID.');
  const detailRows = (start: number, end: number) => rows.slice(start + 2, end).filter(row => row.some(cell => cell));
  const allowances = detailRows(allowancesIndex, deductionsIndex).map(row => ({ name: row[0], amount: snapshotNumber(row[1], 'Allowance amount'), ...(row[2] ? { description: row[2] } : {}) }));
  const deductions = detailRows(deductionsIndex, leaveIndex > deductionsIndex ? leaveIndex : attendanceIndex).map(row => ({ name: row[0], amount: snapshotNumber(row[1], 'Deduction amount') }));
  if ([...allowances, ...deductions].some(item => !item.name.trim())) throw new Error('Missing salary detail label.');
  const attendanceHeaders = rows[attendanceIndex + 1];
  if (!attendanceHeaders) throw new Error('Missing attendance snapshot header.');
  const dateIndex = findRequiredColumnIndex(attendanceHeaders, '日期');
  const inIndex = findRequiredColumnIndex(attendanceHeaders, '上班時間');
  const outIndex = findRequiredColumnIndex(attendanceHeaders, '下班時間');
  const holidayIndex = attendanceHeaders.indexOf('Holiday');
  const typeIndex = attendanceHeaders.indexOf('Holiday Type');
  const idIndex = attendanceHeaders.indexOf('Holiday ID');
  const barcodeIndex = attendanceHeaders.indexOf('Barcode Scanned');
  const dates = new Set<string>();
  const attendanceData = rows.slice(attendanceIndex + 2).filter(row => row.some(cell => cell)).map(row => {
    if (row.length !== attendanceHeaders.length) throw new Error('Incomplete attendance snapshot row.');
    const overtimeHours = parseOvertimeHoursSnapshot(attendanceHeaders, row);
    const attendance = validateAttendanceImportRow({ date: row[dateIndex], clockIn: row[inIndex], clockOut: row[outIndex], isHoliday: parseBooleanCsvValue(row[holidayIndex]), holidayType: row[typeIndex] || null, holidayId: row[idIndex]?.trim() ? snapshotNumber(row[idIndex], 'Holiday ID') : null, isBarcodeScanned: parseBooleanCsvValue(row[barcodeIndex]), ...(overtimeHours !== undefined ? { overtimeHours } : {}) });
    if (dates.has(attendance.date)) throw new Error('Duplicate snapshot attendance date.');
    dates.add(attendance.date);
    return attendance;
  });
  let specialLeaveInfo: SalaryRecordImportPayload['specialLeaveInfo'] = null;
  if (leaveIndex !== -1) {
    if (leaveIndex <= deductionsIndex || leaveIndex >= attendanceIndex) throw new Error('Invalid special leave section.');
    const leave = new Map(rows.slice(leaveIndex + 1, attendanceIndex).filter(row => row.length === 2).map(row => [row[0], row[1]]));
    specialLeaveInfo = { usedDays: snapshotNumber(leave.get('Used days'), 'Used days'), usedDates: (leave.get('Used dates') || '').split(',').map(date => date.trim()).filter(Boolean), cashDays: snapshotNumber(leave.get('Cash days'), 'Cash days'), cashAmount: snapshotNumber(leave.get('Cash amount'), 'Cash amount'), ...(leave.get('Cash month') ? { cashMonth: leave.get('Cash month') } : {}), ...(leave.get('Notes') ? { notes: leave.get('Notes') } : {}) };
  }
  return {
    salaryYear: integer('Year'), salaryMonth: integer('Month'),
    snapshotRevision: integer('Revision'),
    ...(employeeId !== undefined ? { employeeId } : {}),
    ...(fields.has('Employee') ? { employeeName: fields.get('Employee')! } : {}),
    baseSalary: amount('Base salary'), housingAllowance: optionalAmount('Housing allowance'), welfareAllowance: optionalAmount('Welfare allowance'), allowances,
    totalOT1Hours: optionalAmount('OT1 hours'), totalOT2Hours: optionalAmount('OT2 hours'), totalOvertimePay: optionalAmount('Overtime pay'),
    holidayDays: optionalAmount('Holiday days'), holidayDailySalary: optionalAmount('Holiday daily salary'), holidayCalculationBaseSalary: optionalAmount('Holiday calculation base salary'), totalHolidayPay: optionalAmount('Holiday pay'),
    grossSalary: amount('Gross salary'), deductions, totalDeductions: optionalAmount('Deductions'), netSalary: amount('Net salary'), specialLeaveInfo, attendanceData,
  };
}
