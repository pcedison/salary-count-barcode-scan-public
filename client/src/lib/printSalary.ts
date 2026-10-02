import type { ExportSalaryRecord } from '@/lib/historyExport';

export function toPrintableSalarySnapshot(record: ExportSalaryRecord) {
  return {
    archived: true, recordId: record.id, revision: record.revision ?? 0,
    employeeId: record.employeeId ?? undefined, employeeName: record.employeeName ?? undefined,
    salaryYear: record.salaryYear, salaryMonth: record.salaryMonth,
    baseSalary: record.baseSalary, grossSalary: record.grossSalary, netSalary: record.netSalary,
    housingAllowance: record.housingAllowance ?? undefined, welfareAllowance: record.welfareAllowance ?? undefined,
    allowances: record.allowances ? [...record.allowances] : undefined,
    totalOT1Hours: record.totalOT1Hours, totalOT2Hours: record.totalOT2Hours,
    totalOvertimePay: record.totalOvertimePay ?? 0, holidayDays: record.holidayDays ?? 0,
    totalHolidayPay: record.totalHolidayPay ?? 0,
    deductions: [...(record.deductions ?? [])], totalDeductions: record.totalDeductions ?? undefined,
    specialLeaveInfo: record.specialLeaveInfo ?? undefined,
    attendanceData: (record.attendanceData ?? []).map(row => ({
      date: row.date, clockIn: row.clockIn ?? '--:--', clockOut: row.clockOut ?? '--:--',
      isHoliday: row.isHoliday ?? false, holidayType: row.holidayType ?? undefined,
      overtimeHours: row.overtimeHours,
    })),
  };
}

export function parseSalaryRecordId(search: string): number | null {
  const rawId = new URLSearchParams(search).get('id');

  if (!rawId || !/^\d+$/.test(rawId)) {
    return null;
  }

  const recordId = Number.parseInt(rawId, 10);
  return Number.isInteger(recordId) && recordId > 0 ? recordId : null;
}

export function parseSalaryRecordIds(search: string): number[] {
  const rawIds = new URLSearchParams(search).get('ids');

  if (!rawIds) {
    return [];
  }

  const ids = rawIds.split(',').map((rawId) => rawId.trim());
  if (ids.length === 0 || ids.some((rawId) => !/^\d+$/.test(rawId))) {
    return [];
  }

  return Array.from(
    new Set(
      ids
        .map((rawId) => Number.parseInt(rawId, 10))
        .filter((recordId) => Number.isInteger(recordId) && recordId > 0)
    )
  );
}
