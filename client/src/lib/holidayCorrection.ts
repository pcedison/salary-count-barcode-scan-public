export const holidayTypeLabels = {
  national_holiday: '國定假日',
  sick_leave: '病假',
  personal_leave: '事假',
  typhoon_leave: '颱風假',
  temporary_stop_work_and_classes: '臨時停止上班上課',
  worked: '假日出勤',
} as const;

export type CorrectionHolidayType = keyof typeof holidayTypeLabels;
export type PaymentHandling = 'unpaid' | 'paid_adjustment' | 'unknown_adjustment';
export const paymentHandlingLabels: Record<PaymentHandling, string> = {
  unpaid: '尚未發薪：更新應付薪資',
  paid_adjustment: '已發薪：記錄待人工處理的補差額',
  unknown_adjustment: '發薪狀態待核對：只記錄待人工核對差額',
};

export interface CorrectionSalaryRecord {
  id: number;
  revision: number;
  salaryYear: number;
  salaryMonth: number;
  employeeId?: number | null;
  employeeName?: string | null;
  grossSalary: number;
  totalDeductions: number;
  netSalary: number;
  totalHolidayPay: number;
  holidayDays: number;
  attendanceData?: Array<{
    date: string;
    clockIn?: string | null;
    clockOut?: string | null;
    holidayType?: string | null;
    _holidayType?: string | null;
    _holidayName?: string | null;
    isHoliday?: boolean;
  }> | null;
}

export interface HolidayCorrectionInput {
  date: string;
  holidayType: CorrectionHolidayType;
  name: string;
  mode: 'add' | 'replace';
}
export interface HolidayCorrectionRequest {
  revision: number;
  holidays: HolidayCorrectionInput[];
  reason: string;
  paymentHandling: PaymentHandling;
}
export interface CorrectionDelta {
  grossSalary: number;
  totalDeductions: number;
  netSalary: number;
  totalHolidayPay: number;
  holidayDays: number;
}
export interface HolidayCorrectionPreview {
  before: CorrectionSalaryRecord;
  after: CorrectionSalaryRecord;
  delta: CorrectionDelta;
  holidays: HolidayCorrectionInput[];
  reason: string;
  paymentHandling: PaymentHandling;
  calculationNote: string;
  previewToken: string;
}
export interface HolidayCorrectionEntry {
  id: number | string;
  revision: number;
  reason: string;
  paymentHandling: PaymentHandling;
  delta: CorrectionDelta;
  createdAt: string;
  actorRole: string;
  holidays: HolidayCorrectionInput[];
}

// Legacy snapshots may use slash dates, while correction requests always use ISO dates.
export function normalizeSnapshotDate(value: string): string {
  const match = String(value).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:$|T|\s)/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : value;
}

export function correctionMonthBounds(record: Pick<CorrectionSalaryRecord, 'salaryYear' | 'salaryMonth'>) {
  const month = `${record.salaryYear}-${String(record.salaryMonth).padStart(2, '0')}`;
  const lastDay = new Date(Date.UTC(record.salaryYear, record.salaryMonth, 0)).getUTCDate();
  return { min: `${month}-01`, max: `${month}-${lastDay}`, month };
}

export function validateHolidayCorrection(
  record: CorrectionSalaryRecord,
  holidays: HolidayCorrectionInput[],
  reason: string,
  paymentHandling: string,
): string | null {
  if (!Number.isInteger(record.employeeId) || Number(record.employeeId) <= 0) return '此結算紀錄未指定員工，無法進行假日更正。';
  if (!Number.isInteger(record.revision) || record.revision < 0) return '請重新讀取最新結算紀錄。';
  if (!reason.trim()) return '請填寫更正原因。';
  if (reason.trim().length > 1000) return '更正原因不可超過 1000 字。';
  if (!Object.prototype.hasOwnProperty.call(paymentHandlingLabels, paymentHandling)) return '請選擇發薪狀態與差額處理方式。';
  if (!holidays.length || holidays.length > 31) return '請加入 1 至 31 筆日期。';
  const { min, max } = correctionMonthBounds(record);
  const seen = new Set<string>();
  const existing = new Set((record.attendanceData ?? []).map((row) => normalizeSnapshotDate(row.date)));
  for (const holiday of holidays) {
    const date = new Date(`${holiday.date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(holiday.date) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== holiday.date || holiday.date < min || holiday.date > max) {
      return '日期必須是此結算月份內的有效日期。';
    }
    if (seen.has(holiday.date)) return '同一次更正不可重複日期。';
    seen.add(holiday.date);
    if (!Object.prototype.hasOwnProperty.call(holidayTypeLabels, holiday.holidayType)) return '請選擇支援的假日類別。';
    if (!holiday.name.trim() || holiday.name.trim().length > 100) return '請填寫 1 至 100 字的假日名稱。';
    if (holiday.mode === 'add' && existing.has(holiday.date)) return '此日期已有出勤或假日，請明確選擇「更正既有類別」。';
    if (holiday.mode === 'replace' && !existing.has(holiday.date)) return '此日期沒有既有紀錄，請選擇「補登新日期」。';
    if (holiday.mode !== 'add' && holiday.mode !== 'replace') return '請選擇補登或更正既有類別。';
  }
  return null;
}

export function correctionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('409:')) return '紀錄已被其他管理員更動或預覽已失效，請重新讀取後再預覽。';
  if (message.startsWith('401:') || message.startsWith('403:')) return '管理員權限已失效，請重新登入。';
  if (message.startsWith('400:') || message.startsWith('422:')) {
    try {
      const body = JSON.parse(message.slice(message.indexOf(':') + 1));
      if (typeof body.error === 'string') return body.error;
      if (typeof body.message === 'string') return body.message;
    } catch { /* Keep a concise, non-sensitive fallback. */ }
    return '更正內容不符合規則，請檢查日期、假日類別與付款處理。';
  }
  return '無法完成請求，請稍後重試。若保存結果不明，可用同一預覽再次確認，系統會避免重複更正。';
}
