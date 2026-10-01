interface ScopedAttendance { date: string; employeeId?: number; }
export function filterPayrollAttendance<T extends ScopedAttendance>(rows: readonly T[], year: number, month: number, employeeId?: number): T[] {
  return rows.filter((row) => {
    const date = String(row.date).match(/^(\d{4})[/-](\d{1,2})(?:[/-]|$)/);
    return Boolean(date && Number(date[1]) === year && Number(date[2]) === month && (employeeId === undefined || row.employeeId === employeeId));
  });
}
export function finalizationSnapshotRows<T extends ScopedAttendance>(snapshot: { salaryYear: number; salaryMonth: number; attendanceData: readonly T[] }): T[] {
  const rows = snapshot.attendanceData;
  if (!rows.length || filterPayrollAttendance(rows, snapshot.salaryYear, snapshot.salaryMonth).length !== rows.length || rows.some((row) => !Number.isInteger(row.employeeId) || Number(row.employeeId) <= 0)) {
    throw new Error('結算快照必須只有指定月份與已識別員工的紀錄，請重新計算。');
  }
  return rows.map((row) => ({ ...row }));
}
export function clearableAttendanceIds(rows: readonly { id: number }[]): number[] {
  return Array.from(new Set(rows.map((row) => row.id).filter((id) => Number.isSafeInteger(id) && id > 0)));
}
