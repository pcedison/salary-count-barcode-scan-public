import {
  formatYearMonthKey,
  matchesYearMonth,
  parseYearMonthKey
} from '@shared/utils/specialLeaveSync';

/**
 * 出勤資料增強的純函式層,自 useAttendanceData 抽出:
 * 已結算月份過濾、員工/假別標籤標注、特休折現虛擬列、排序。
 * 全部無副作用,可在 node 環境直接測試。
 */

export interface AttendanceRecord {
  id: number;
  employeeId?: number;
  _employeeName?: string;
  _employeeDepartment?: string;
  date: string;
  clockIn: string;
  clockOut: string;
  isHoliday: boolean;
  holidayId?: number;
  holidayType?: string;
  isBarcodeScanned?: boolean;
  _isLeaveRecord?: boolean;
  _isNoClockType?: boolean;
  _displayDate?: string;
  _holidayType?: string;
  _holidayName?: string;
  _isSpecialLeaveCashRecord?: boolean;
  _specialLeaveCashDays?: number;
  _specialLeaveCashAmount?: number;
  _specialLeaveCashNotes?: string | null;
}

export interface EmployeeLike {
  id: number;
  name: string;
  department?: string | null;
  specialLeaveUsedDates?: string[] | null;
  specialLeaveCashDays?: number | null;
  specialLeaveCashMonth?: string | null;
  specialLeaveNotes?: string | null;
}

export interface FinalizedSalaryRecordLike {
  employeeId?: number | null;
  salaryYear: number;
  salaryMonth: number;
}

export interface SpecialLeaveMonthInfo {
  usedDays: number;
  usedDates: string[];
  cashDays: number;
  cashAmount: number;
  cashMonth?: string;
  notes: string;
}

const HOLIDAY_TYPE_LABELS: Record<string, string> = {
  'national_holiday': '國定假日',
  'special_leave': '特別休假',
  'sick_leave': '病假',
  'personal_leave': '事假',
  'typhoon_leave': '颱風假',
  'temporary_stop_work_and_classes': '臨時停止上班上課',
  'special_leave_cash': '特休折現',
  'worked': '假日出勤'
};

const NO_CLOCK_HOLIDAY_TYPES = [
  'national_holiday',
  'typhoon_leave',
  'temporary_stop_work_and_classes',
  'special_leave'
];

/** 將 YYYY/MM/DD 或 YYYY-MM-DD 轉為 YYYY-MM 月鍵;無法解析回傳 null。 */
export function toMonthKey(dateValue: string): string | null {
  if (!dateValue) return null;

  const [yearValue, monthValue] = dateValue.replace(/-/g, "/").split("/");
  const year = Number(yearValue);
  const month = Number(monthValue);

  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return null;
  }

  return `${year}-${String(month).padStart(2, "0")}`;
}

export function parseAttendanceDateParts(
  date: string | null | undefined
): { year: number; month: number; day: number } | null {
  const match = String(date || '').match(/^(\d{4})[/-](\d{1,2})(?:[/-](\d{1,2}))?/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3] || '0', 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  return { year, month, day };
}

export function getEmployeeMonthKey(employeeId: number, year: number, month: number): string {
  return `${employeeId}:${formatYearMonthKey(year, month)}`;
}

export function getAttendanceSortValue(record: Pick<AttendanceRecord, 'date'>): number {
  const parts = parseAttendanceDateParts(record.date);
  if (!parts) {
    return 0;
  }

  return parts.year * 10000 + parts.month * 100 + parts.day;
}

/** 已有正式薪資紀錄的 (員工,月份) 集合 —— 這些月份的出勤不再顯示於登記表。 */
export function buildFinalizedSalaryMonthKeys(
  records: FinalizedSalaryRecordLike[]
): Set<string> {
  return new Set(
    records
      .filter((record) => record.employeeId && record.salaryYear && record.salaryMonth)
      .map((record) =>
        getEmployeeMonthKey(record.employeeId as number, record.salaryYear, record.salaryMonth)
      )
  );
}

/** 濾掉已結算月份的出勤;無員工或無法解析日期的紀錄一律保留。 */
export function filterFinalizedAttendance<T extends AttendanceRecord>(
  records: T[],
  finalizedMonthKeys: Set<string>
): T[] {
  return records.filter((record) => {
    if (!record.employeeId) {
      return true;
    }

    const dateParts = parseAttendanceDateParts(record.date);
    if (!dateParts) {
      return true;
    }

    return !finalizedMonthKeys.has(
      getEmployeeMonthKey(record.employeeId, dateParts.year, dateParts.month)
    );
  });
}

/** 標注員工姓名/部門與假別標籤。 */
export function enhanceAttendanceRecords(
  records: AttendanceRecord[],
  employees: EmployeeLike[] | undefined
): AttendanceRecord[] {
  return records.map((record) => {
    const enhanced: AttendanceRecord = { ...record };

    if (record.employeeId && employees && employees.length > 0) {
      const employee = employees.find((emp) => emp.id === record.employeeId);
      if (employee) {
        enhanced._employeeName = employee.name;
        enhanced._employeeDepartment = employee.department ?? undefined;
      }
    }

    if (record.holidayType) {
      enhanced._isLeaveRecord = true;
      enhanced._isNoClockType = NO_CLOCK_HOLIDAY_TYPES.includes(record.holidayType);
      enhanced._holidayType = record.holidayType;
      enhanced._holidayName = HOLIDAY_TYPE_LABELS[record.holidayType] || '假日';
    }

    return enhanced;
  });
}

/** 為設定了特休折現的員工產生虛擬顯示列(已結算月份跳過)。 */
export function buildSpecialLeaveCashRecords(
  employees: EmployeeLike[] | undefined,
  finalizedMonthKeys: Set<string>,
  baseMonthSalary: number
): AttendanceRecord[] {
  const dailySalary = Math.round(baseMonthSalary / 30);

  return (employees || []).flatMap((employee) => {
    const cashDays = employee.specialLeaveCashDays || 0;
    if (cashDays <= 0) {
      return [];
    }

    const cashMonthKey = parseYearMonthKey(employee.specialLeaveCashMonth);
    if (!cashMonthKey) {
      return [];
    }

    const [yearText, monthText] = cashMonthKey.split('-');
    const year = Number.parseInt(yearText, 10);
    const month = Number.parseInt(monthText, 10);
    if (finalizedMonthKeys.has(getEmployeeMonthKey(employee.id, year, month))) {
      return [];
    }

    const cashAmount = cashDays * dailySalary;
    const paddedMonth = String(month).padStart(2, '0');

    return [{
      id: -(1_000_000 + employee.id * 10_000 + year * 100 + month),
      employeeId: employee.id,
      _employeeName: employee.name,
      _employeeDepartment: employee.department || undefined,
      date: `${year}/${paddedMonth}/00`,
      _displayDate: `${year}/${paddedMonth}`,
      clockIn: '--:--',
      clockOut: '--:--',
      isHoliday: true,
      holidayType: 'special_leave_cash',
      isBarcodeScanned: false,
      _isLeaveRecord: true,
      _isNoClockType: true,
      _holidayType: 'special_leave_cash',
      _holidayName: `特休折現 ${cashDays}天 / $${cashAmount.toLocaleString()}`,
      _isSpecialLeaveCashRecord: true,
      _specialLeaveCashDays: cashDays,
      _specialLeaveCashAmount: cashAmount,
      _specialLeaveCashNotes: employee.specialLeaveNotes || null
    } satisfies AttendanceRecord];
  });
}

/** 指定員工在某月的特休使用/折現摘要;該月無活動時回傳 null。 */
export function getSpecialLeaveInfoForMonth(
  employee: EmployeeLike | undefined,
  year: number,
  month: number,
  baseMonthSalary: number
): SpecialLeaveMonthInfo | null {
  if (!employee) return null;

  const usedDates = employee.specialLeaveUsedDates || [];
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

  const monthlyUsedDates = usedDates
    .map((date) => date.replace(/\//g, '-'))
    .filter((date) => date.startsWith(monthPrefix));

  const cashMonth = employee.specialLeaveCashMonth || '';
  const isCashMonth = matchesYearMonth(cashMonth, year, month);
  const cashDays = isCashMonth ? (employee.specialLeaveCashDays || 0) : 0;
  const dailySalary = Math.round(baseMonthSalary / 30);
  const cashAmount = cashDays * dailySalary;

  if (monthlyUsedDates.length === 0 && cashDays === 0) {
    return null;
  }

  return {
    usedDays: monthlyUsedDates.length,
    usedDates: monthlyUsedDates,
    cashDays,
    cashAmount,
    cashMonth: isCashMonth && cashDays > 0 ? cashMonth : undefined,
    notes: employee.specialLeaveNotes || ''
  };
}

/** 登記表以最新日期在前;同日以 id 大者在前。 */
export function sortAttendanceNewestFirst<T extends AttendanceRecord>(records: T[]): T[] {
  if (records.length === 0) return [];

  return [...records].sort((a, b) => {
    const dateDiff = getAttendanceSortValue(b) - getAttendanceSortValue(a);
    if (dateDiff !== 0) {
      return dateDiff;
    }

    return b.id - a.id;
  });
}
