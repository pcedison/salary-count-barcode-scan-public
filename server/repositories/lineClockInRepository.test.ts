import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));
import { buildLineClockState, parseLineClockCommand, parseLineClockEventId, planLineClockWrite } from './lineClockInRepository';

const stateVersion = buildLineClockState(1, '2026/10/29', [], 'U-one').stateVersion;

describe('LINE command validation and state fingerprints', () => {
  it('fails closed for old clients, invalid identifiers and invalid state versions', () => {
    for (const value of [undefined, null, {}, { eventId: 'not-uuid', stateVersion }, { eventId: randomUUID() }, { eventId: randomUUID(), stateVersion: 'old' }]) {
      expect(() => parseLineClockCommand(value)).toThrow(expect.objectContaining({ status: 400, code: 'LINE_CLOCK_REQUEST_INVALID' }));
    }
    expect(() => parseLineClockEventId([])).toThrow();
  });

  it('normalizes UUID case and equivalent ISO offsets without inventing timestamps', () => {
    const eventId = randomUUID();
    expect(parseLineClockCommand({ eventId: eventId.toUpperCase(), stateVersion })).toEqual({ eventId, stateVersion });
    expect(parseLineClockCommand({ eventId, stateVersion, clientTimestamp: '2026-10-29T08:00:00+08:00' }).clientTimestamp).toBe('2026-10-29T00:00:00.000Z');
    for (const clientTimestamp of ['', null, 0, '2026/10/29 08:00', '2026-02-31T00:00:00Z', 'bad']) {
      expect(() => parseLineClockCommand({ eventId, stateVersion, clientTimestamp })).toThrow(expect.objectContaining({ code: 'LINE_CLOCK_TIMESTAMP_INVALID' }));
    }
  });

  it('binds empty state to date, employee and LINE identity', () => {
    expect(buildLineClockState(1, '2026-10-29', [], 'U-one').stateVersion).toBe(stateVersion);
    expect(buildLineClockState(2, '2026/10/29', [], 'U-one').stateVersion).not.toBe(stateVersion);
    expect(buildLineClockState(1, '2026/10/30', [], 'U-one').stateVersion).not.toBe(stateVersion);
    expect(buildLineClockState(1, '2026/10/29', [], 'U-two').stateVersion).not.toBe(stateVersion);
  });

  it('includes every record and MVCC revision, independent of database row ordering', () => {
    const row = { id: 1, employeeId: 1, date: '2026/10/29', clockIn: '08:00', clockOut: '', isHoliday: false, isBarcodeScanned: true, holidayId: null, holidayType: null, createdAt: new Date('2026-10-29T00:00Z'), revision: '5' };
    const closed = { ...row, id: 2, clockIn: '06:00', clockOut: '07:00' };
    const base = buildLineClockState(1, row.date, [row, closed], 'U-one');
    expect(base.action).toBe('clock-out');
    expect(buildLineClockState(1, row.date, [closed, row], 'U-one')).toEqual(base);
    for (const changed of [{ ...closed, isHoliday: true }, { ...closed, revision: '6' }, { ...closed, clockOut: '07:01' }]) {
      expect(buildLineClockState(1, row.date, [row, changed], 'U-one').stateVersion).not.toBe(base.stateVersion);
    }
    expect(buildLineClockState(1, row.date, [closed], 'U-one').action).toBe('clock-in');
  });
});

describe('LINE clock writes on 假日出勤 days', () => {
  const base = { employeeId: 9, date: '2026/11/28', isBarcodeScanned: true, holidayId: null, holidayType: null, isHoliday: false, createdAt: null };

  it('marks a new clock-in as 假日出勤 when asked', () => {
    expect(planLineClockWrite(9, '2026/11/28', '07:58', [], true)).toEqual({
      kind: 'insert',
      values: { employeeId: 9, date: '2026/11/28', clockIn: '07:58', clockOut: '', isHoliday: true, isBarcodeScanned: true, holidayType: 'worked' },
    });
  });

  it('keeps an ordinary clock-in unmarked', () => {
    const write = planLineClockWrite(9, '2026/11/26', '07:58', [], false);
    expect(write).toMatchObject({ kind: 'insert', values: { isHoliday: false } });
    expect(write.kind === 'insert' && 'holidayType' in write.values).toBe(false);
  });

  it('turns the untouched 08:00–17:00 placeholder into the real clock-in', () => {
    const placeholder = { ...base, id: 77, clockIn: '08:00', clockOut: '17:00', isBarcodeScanned: false, holidayId: 41, holidayType: 'worked', isHoliday: true };
    expect(planLineClockWrite(9, '2026/11/28', '07:58', [placeholder], true)).toEqual({
      kind: 'update', id: 77,
      set: { clockIn: '07:58', clockOut: '', isBarcodeScanned: true, holidayId: null, isHoliday: true, holidayType: 'worked' },
    });
  });

  it('only sets clockOut on clock-out, leaving the category an admin chose', () => {
    const open = { ...base, id: 5, clockIn: '07:58', clockOut: '', holidayType: null };
    expect(planLineClockWrite(9, '2026/11/28', '17:10', [open], true)).toEqual({ kind: 'update', id: 5, set: { clockOut: '17:10' } });
  });
});
