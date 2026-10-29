import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));
import { buildLineClockState, parseLineClockCommand, parseLineClockEventId } from './lineClockInRepository';

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
