import { describe, expect, it } from 'vitest';
import { captureSettlementOvertime, reconcileArchivedOvertime } from './archivedOvertime';

const row = (date: string, clockOut = '18:00') => ({ date, clockIn: '08:00', clockOut, isHoliday: false });
const record = { salaryYear: 2026, salaryMonth: 9, totalOT1Hours: 3, totalOT2Hours: 0.5,
  attendanceData: [row('2026/09/01', '17:00'), row('2026-09-02', '18:20'), row('2026-09-03', '16:08'),
    { date: '2026-09-25', clockIn: '--:--', clockOut: '--:--', isHoliday: true, holidayType: 'national_holiday' }],
};

describe('historical daily overtime hours', () => {
  it('reconstructs legacy clocks only when both stages reconcile, with genuine zero hours', () => {
    const original = JSON.stringify(record);
    expect(reconcileArchivedOvertime(record)).toMatchObject({ reconciled: true, source: 'clocks',
      rows: [{ ot1: 1, ot2: 0 }, { ot1: 2, ot2: 0.5 }, { ot1: 0, ot2: 0 }, { ot1: 0, ot2: 0 }] });
    expect(JSON.stringify(record)).toBe(original);
  });
  it('keeps an independently generated 36/1 month consistent by stage', () => {
    const attendanceData = Array.from({ length: 20 }, (_, index) => row(`2026-09-${String(index + 1).padStart(2, '0')}`,
      index < 2 ? '18:20' : index < 18 ? '18:00' : '16:00'));
    const resolved = reconcileArchivedOvertime({ ...record, attendanceData, totalOT1Hours: 36, totalOT2Hours: 1 });
    expect(resolved.reconciled).toBe(true);
    expect(resolved.rows[0]).toEqual({ ot1: 2, ot2: 0.5 });
    expect(resolved.rows[19]).toEqual({ ot1: 0, ot2: 0 });
  });
  it.each([
    { totalOT1Hours: 0 }, { totalOT2Hours: 0 }, { totalOT1Hours: null }, { totalOT2Hours: undefined },
    { totalOT1Hours: NaN }, { totalOT1Hours: -1 },
    { attendanceData: [row('2026-10-01')] },
    { attendanceData: [row('2026-09-01'), row('2026/09/01')] },
    { attendanceData: [row('2026-09-31')] },
    { attendanceData: [row('2026-09-01', '25:00')] },
    { attendanceData: [row('2026-09-01', '--:--')] },
  ])('does not fabricate daily allocation when totals or clocks are unverifiable', patch => {
    const resolved = reconcileArchivedOvertime({ ...record, ...patch });
    expect(resolved.reconciled).toBe(false);
    expect(resolved.rows.every(row => row === null)).toBe(true);
  });
  it('uses saved daily hours across different clock rules and preserves corrected holiday classifications', () => {
    const attendanceData = [{ ...row('2026-09-01', '16:00'), isHoliday: true, holidayType: 'worked', overtimeHours: { ot1: 3, ot2: 0.5 } }, record.attendanceData[3]];
    expect(reconcileArchivedOvertime({ ...record, attendanceData })).toMatchObject({ reconciled: true, source: 'snapshot', rows: [{ ot1: 3, ot2: 0.5 }, { ot1: 0, ot2: 0 }] });
  });
  it.each([{ ot1: -1, ot2: 0.5 }, { ot1: 3, ot2: NaN }, { ot1: 3, ot2: 25 }, { ot1: '3', ot2: 0.5 }])('refuses corrupt saved hours', overtimeHours => {
    const input = { ...record, attendanceData: [{ ...row('2026-09-01'), overtimeHours }] };
    expect(reconcileArchivedOvertime(input as typeof record).reconciled).toBe(false);
  });
  it('requires complete workday snapshots rather than mixing missing evidence with clocks', () => {
    const attendanceData = [{ ...record.attendanceData[0], overtimeHours: { ot1: 1, ot2: 0 } }, ...record.attendanceData.slice(1)];
    expect(reconcileArchivedOvertime({ ...record, attendanceData }).reconciled).toBe(false);
  });
  it('captures new server-derived hours, discards client hours, and preserves the input', () => {
    const input = { ...record, attendanceData: record.attendanceData.map(row => ({ ...row, overtimeHours: { ot1: 24, ot2: 24 } })) };
    const original = JSON.stringify(input);
    const captured = captureSettlementOvertime(input);
    expect(captured?.map(row => row.overtimeHours)).toEqual([{ ot1: 1, ot2: 0 }, { ot1: 2, ot2: 0.5 }, { ot1: 0, ot2: 0 }, { ot1: 0, ot2: 0 }]);
    expect(JSON.stringify(input)).toBe(original);
    expect(reconcileArchivedOvertime({ ...record, attendanceData: captured })).toMatchObject({ reconciled: true, source: 'snapshot' });
  });
  it('does not stamp evidence onto an inconsistent new settlement or fabricate missing rows', () => {
    expect(captureSettlementOvertime({ ...record, totalOT1Hours: 99 })?.every(row => !('overtimeHours' in row))).toBe(true);
    expect(captureSettlementOvertime({ ...record, attendanceData: null })).toBeNull();
    expect(captureSettlementOvertime({ ...record, attendanceData: undefined })).toBeUndefined();
  });
});
