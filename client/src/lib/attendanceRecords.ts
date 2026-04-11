import type { QueryClient } from "@tanstack/react-query";

export interface AttendanceRecordLike {
  id: number;
  employeeId?: number | null;
  employeeName?: string;
  department?: string | null;
  _employeeName?: string;
  _employeeDepartment?: string;
  date: string;
  clockIn: string;
  clockOut?: string | null;
  isHoliday?: boolean;
  holidayId?: number | null;
  holidayType?: string | null;
  isBarcodeScanned?: boolean;
}

export interface NormalizedAttendanceRecord {
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
  isBarcodeScanned: boolean;
}

export function normalizeAttendanceRecord(
  record: AttendanceRecordLike,
): NormalizedAttendanceRecord {
  return {
    id: record.id,
    employeeId: record.employeeId ?? undefined,
    _employeeName: record._employeeName ?? record.employeeName,
    _employeeDepartment:
      record._employeeDepartment ?? record.department ?? undefined,
    date: record.date,
    clockIn: record.clockIn,
    clockOut: record.clockOut ?? "",
    isHoliday: Boolean(record.isHoliday),
    holidayId: record.holidayId ?? undefined,
    holidayType: record.holidayType ?? undefined,
    isBarcodeScanned: Boolean(record.isBarcodeScanned),
  };
}

export function invalidateAttendanceQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey[0];
      return typeof key === "string" && key.startsWith("/api/attendance");
    },
  });
}
