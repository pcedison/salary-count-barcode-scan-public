import { calculateOvertime, parseClockTimeMinutes } from './salaryMath';

export interface OvertimeHoursSnapshot { ot1: number; ot2: number }

interface AttendanceHoursSource {
  date: string;
  clockIn?: string | null;
  clockOut?: string | null;
  isHoliday?: boolean | null;
  holidayType?: string | null;
  overtimeHours?: OvertimeHoursSnapshot;
}

interface ArchivedHoursSource {
  salaryYear: number;
  salaryMonth: number;
  totalOT1Hours?: number | null;
  totalOT2Hours?: number | null;
  attendanceData?: readonly AttendanceHoursSource[] | null;
}

function validHours(value: unknown): value is OvertimeHoursSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hours = value as OvertimeHoursSnapshot;
  return [hours.ot1, hours.ot2].every(hour => typeof hour === 'number' && Number.isFinite(hour) && hour >= 0 && hour <= 24);
}

function clockHours(row: AttendanceHoursSource): OvertimeHoursSnapshot | null {
  if (row.isHoliday || row.holidayType === 'special_leave_cash') return { ot1: 0, ot2: 0 };
  if (parseClockTimeMinutes(row.clockIn) === null || parseClockTimeMinutes(row.clockOut) === null) return null;
  const { ot1, ot2 } = calculateOvertime(row.clockIn!, row.clockOut!);
  return { ot1, ot2 };
}

/** Read-only reconciliation. A legacy clock reconstruction must match both saved
 * stages before it can be displayed; it never changes hours or payroll totals. */
export function reconcileArchivedOvertime(record: ArchivedHoursSource) {
  const attendance = record.attendanceData ?? [];
  const hasSnapshots = attendance.some(row => row.overtimeHours !== undefined);
  const dates = new Set<string>();
  let validDates = true;
  const rows = attendance.map(row => {
    const parts = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(row.date);
    if (!parts) validDates = false;
    else {
      const [year, month, day] = parts.slice(1).map(Number);
      const date = new Date(Date.UTC(year, month - 1, day));
      const key = `${year}-${month}-${day}`;
      if (year !== record.salaryYear || month !== record.salaryMonth ||
          date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || dates.has(key)) validDates = false;
      dates.add(key);
    }
    if (row.overtimeHours !== undefined) return validHours(row.overtimeHours) ? { ...row.overtimeHours } : null;
    // A newly added unworked holiday need not invent a historical OT snapshot.
    if (hasSnapshots && !row.isHoliday && row.holidayType !== 'special_leave_cash') return null;
    return clockHours(row);
  });
  const knownTotals = [record.totalOT1Hours, record.totalOT2Hours].every(value =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const reconciled = validDates && knownTotals && rows.every(row => row !== null) &&
    Math.abs(rows.reduce((sum, row) => sum + (row?.ot1 ?? 0), 0) - record.totalOT1Hours!) < 0.000001 &&
    Math.abs(rows.reduce((sum, row) => sum + (row?.ot2 ?? 0), 0) - record.totalOT2Hours!) < 0.000001;
  return { reconciled, source: reconciled ? hasSnapshots ? 'snapshot' : 'clocks' : 'unverified',
    rows: reconciled ? rows : rows.map(() => null) };
}

/** New settlements capture server-derived daily hours only when their saved
 * scope reconciles. Client-supplied daily values are never accepted as evidence. */
export function captureSettlementOvertime<T extends AttendanceHoursSource>(record: Omit<ArchivedHoursSource, 'attendanceData'> & { attendanceData?: readonly T[] | null }) {
  if (record.attendanceData == null) return record.attendanceData;
  const attendance = record.attendanceData.map(({ overtimeHours: _untrusted, ...row }) => row);
  const resolved = reconcileArchivedOvertime({ ...record, attendanceData: attendance });
  return attendance.map((row, index) => ({ ...row,
    ...(resolved.reconciled ? { overtimeHours: resolved.rows[index]! } : {}),
  }));
}
