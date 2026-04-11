import { describe, expect, it } from 'vitest';

import { filterAttendanceRecordsByDate } from './attendance-helpers';

describe('attendance.routes helpers', () => {
  it('matches attendance records across slash and dash date formats', () => {
    const records = [
      { id: 1, date: '2026/03/12' },
      { id: 2, date: '2026-03-12' },
      { id: 3, date: '2026/03/11' }
    ];

    expect(filterAttendanceRecordsByDate(records, '2026-03-12')).toEqual([
      { id: 1, date: '2026/03/12' },
      { id: 2, date: '2026-03-12' }
    ]);
  });
});
