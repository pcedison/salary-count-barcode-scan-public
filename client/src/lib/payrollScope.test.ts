import { describe, expect, it } from 'vitest';
import { clearableAttendanceIds, filterPayrollAttendance, finalizationSnapshotRows } from './payrollScope';
const allRows = [
  { id: 11, employeeId: 1, date: '2026/09/25', _employeeName: 'Same Synthetic Name' },
  { id: 12, employeeId: 1, date: '2026-09-28', _employeeName: 'Same Synthetic Name' },
  { id: 13, employeeId: 1, date: '2026/10/01', _employeeName: 'Same Synthetic Name' },
  { id: 14, employeeId: 2, date: '2026/09/25', _employeeName: 'Same Synthetic Name' },
  { id: 15, employeeId: 2, date: '2026/10/01', _employeeName: 'Same Synthetic Name' },
  { id: -1, employeeId: 1, date: '2026/09/00', _employeeName: 'Same Synthetic Name' },
];
describe('payroll month and employee scope', () => {
  it('filters September for exactly one employee even when two employees share a name', () => expect(filterPayrollAttendance(allRows, 2026, 9, 1).map((row) => row.id)).toEqual([11, 12, -1]));
  it('keeps an all-employees view limited to the selected month', () => expect(filterPayrollAttendance(allRows, 2026, 9).map((row) => row.id)).toEqual([11, 12, 14, -1]));
  it('finalizes only the selected snapshot instead of discovering other live employees/months', () => {
    const selected = filterPayrollAttendance(allRows, 2026, 9, 1).filter((row) => row.id > 0);
    const snapshot = { salaryYear: 2026, salaryMonth: 9, attendanceData: selected };
    expect(finalizationSnapshotRows(snapshot).map((row) => row.id)).toEqual([11, 12]);
    expect(finalizationSnapshotRows(snapshot)[0]).not.toBe(selected[0]);
    expect(allRows).toHaveLength(6);
  });
  it('preserves a deliberately selected multi-employee snapshot without October rows', () => expect(finalizationSnapshotRows({ salaryYear: 2026, salaryMonth: 9, attendanceData: allRows.filter((row) => [11, 12, 14].includes(row.id)) }).map((row) => row.id)).toEqual([11, 12, 14]));
  it('rejects mixed-month or unidentified snapshots before any save', () => {
    expect(() => finalizationSnapshotRows({ salaryYear: 2026, salaryMonth: 9, attendanceData: allRows })).toThrow('指定月份');
    expect(() => finalizationSnapshotRows({ salaryYear: 2026, salaryMonth: 9, attendanceData: [{ date: '2026/09/25' }] })).toThrow('已識別員工');
  });
  it('explicit clearing returns only positive persisted IDs visible in the chosen scope', () => {
    expect(clearableAttendanceIds(filterPayrollAttendance(allRows, 2026, 9, 1))).toEqual([11, 12]);
    expect(clearableAttendanceIds([{ id: -1 }, { id: 0 }, { id: 11 }, { id: 11 }, { id: NaN }])).toEqual([11]);
    expect(clearableAttendanceIds([])).toEqual([]);
  });
});
