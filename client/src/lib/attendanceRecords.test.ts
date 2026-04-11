import { describe, expect, it } from "vitest";

import { normalizeAttendanceRecord } from "./attendanceRecords";

describe("normalizeAttendanceRecord", () => {
  it("keeps admin attendance records compatible with the table shape", () => {
    expect(
      normalizeAttendanceRecord({
        id: 7,
        employeeId: 2,
        _employeeName: "測試員工甲",
        _employeeDepartment: "測試部門",
        date: "2026/04/07",
        clockIn: "08:00",
        clockOut: "17:00",
        isHoliday: false,
        holidayId: null,
        holidayType: null,
        isBarcodeScanned: true,
      }),
    ).toEqual({
      id: 7,
      employeeId: 2,
      _employeeName: "測試員工甲",
      _employeeDepartment: "測試部門",
      date: "2026/04/07",
      clockIn: "08:00",
      clockOut: "17:00",
      isHoliday: false,
      holidayId: undefined,
      holidayType: undefined,
      isBarcodeScanned: true,
    });
  });

  it("maps public today attendance payloads into the table shape", () => {
    expect(
      normalizeAttendanceRecord({
        id: 8,
        employeeId: 2,
        employeeName: "測試員工甲",
        department: "測試部門",
        date: "2026/04/07",
        clockIn: "08:05",
        clockOut: "",
        isBarcodeScanned: true,
      }),
    ).toEqual({
      id: 8,
      employeeId: 2,
      _employeeName: "測試員工甲",
      _employeeDepartment: "測試部門",
      date: "2026/04/07",
      clockIn: "08:05",
      clockOut: "",
      isHoliday: false,
      holidayId: undefined,
      holidayType: undefined,
      isBarcodeScanned: true,
    });
  });
});
