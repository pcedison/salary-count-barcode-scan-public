import { normalizeDateToSlash } from '@shared/utils/specialLeaveSync';

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
}

export interface SalaryRecordImportPayload {
  salaryYear: number;
  salaryMonth: number;
  baseSalary: number;
  housingAllowance: number;
  welfareAllowance: number;
  totalOT1Hours: number;
  totalOT2Hours: number;
  totalOvertimePay: number;
  holidayDays: number;
  holidayDailySalary: number;
  totalHolidayPay: number;
  grossSalary: number;
  deductions: Array<{ name: string; amount: number }>;
  totalDeductions: number;
  netSalary: number;
  attendanceData: AttendanceImportRow[];
}

export interface ImportedHistoryAttendanceRow {
  id: number;
  date: string;
  clockIn: string;
  clockOut: string;
  isHoliday: boolean;
  isBarcodeScanned: boolean;
  employeeId?: number;
  holidayId?: number;
  holidayType?: string;
  createdAt?: Date;
}

const DATE_PATTERN = /^\d{4}[-/](0?[1-9]|1[012])[-/](0?[1-9]|[12][0-9]|3[01])$/;
const TIME_PATTERN = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
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
  if (!DATE_PATTERN.test(row.date)) {
    throw new Error(`日期格式不正確: ${row.date}`);
  }

  if (!TIME_PATTERN.test(row.clockIn)) {
    throw new Error(`上班時間格式不正確: ${row.clockIn}`);
  }

  if (!TIME_PATTERN.test(row.clockOut)) {
    throw new Error(`下班時間格式不正確: ${row.clockOut}`);
  }

  return {
    ...row,
    date: normalizeDateToSlash(row.date)
  };
}

function findRequiredColumnIndex(headers: string[], fieldName: string): number {
  const index = headers.findIndex(header => header === fieldName);
  if (index === -1) {
    throw new Error(`CSV檔案格式不正確，缺少必要欄位 (${fieldName})`);
  }
  return index;
}

export function parseAttendanceImportCsv(csvContent: string): {
  rows: AttendanceImportRow[];
  result: Required<Pick<ImportResult, 'success' | 'totalRecords' | 'successCount' | 'failCount' | 'errors'>>;
} {
  const lines = splitCsvContent(csvContent);
  if (lines.length < 2) {
    throw new Error('CSV檔案格式不正確或內容為空');
  }

  // Guard against excessively large imports that could block the event loop
  const dataRowCount = lines.length - 1; // subtract header
  if (dataRowCount > MAX_IMPORT_ROWS) {
    throw new Error(`CSV 超過最大匯入行數限制（${dataRowCount} 筆，上限 ${MAX_IMPORT_ROWS} 筆）`);
  }

  const headers = splitCsvLine(lines[0]);
  const dateIndex = findRequiredColumnIndex(headers, '日期');
  const clockInIndex = findRequiredColumnIndex(headers, '上班時間');
  const clockOutIndex = findRequiredColumnIndex(headers, '下班時間');
  const isHolidayIndex = headers.findIndex(header => header === '是否假日');

  const rows: AttendanceImportRow[] = [];
  const result = {
    success: true,
    totalRecords: 0,
    successCount: 0,
    failCount: 0,
    errors: [] as string[]
  };

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const fields = splitCsvLine(lines[lineIndex]);
    if (fields.length <= Math.max(dateIndex, clockInIndex, clockOutIndex)) {
      result.failCount += 1;
      result.errors.push(`第 ${lineIndex + 1} 行: 欄位數量不足`);
      continue;
    }

    try {
      const row = validateAttendanceImportRow({
        date: fields[dateIndex],
        clockIn: fields[clockInIndex],
        clockOut: fields[clockOutIndex],
        isHoliday: isHolidayIndex !== -1 ? parseBooleanCsvValue(fields[isHolidayIndex]) : false
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

    attendanceData.push(
      validateAttendanceImportRow({
        date,
        clockIn,
        clockOut,
        isHoliday: isHolidayIndex !== -1 ? parseBooleanCsvValue(fields[isHolidayIndex]) : false
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
    isBarcodeScanned: false
  }));
}
