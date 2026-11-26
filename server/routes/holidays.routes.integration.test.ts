import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeDateToSlash } from '@shared/utils/specialLeaveSync';

import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';

const state = vi.hoisted(() => ({
  holidays: [] as Array<Record<string, any>>,
  attendance: [] as Array<Record<string, any>>,
  nextHolidayId: 1,
  nextAttendanceId: 1000
}));

const storageMock = vi.hoisted(() => ({
  getAllHolidays: vi.fn(async () => state.holidays),
  getHolidayById: vi.fn(async (id: number) => state.holidays.find((holiday) => holiday.id === id)),
  createHoliday: vi.fn(async (holiday: Record<string, any>) => {
    const created = { id: state.nextHolidayId++, ...holiday };
    state.holidays.push(created);
    return created;
  }),
  deleteHoliday: vi.fn(async (id: number) => {
    const before = state.holidays.length;
    state.holidays = state.holidays.filter((holiday) => holiday.id !== id);
    return state.holidays.length < before;
  }),
  deleteAllHolidays: vi.fn(async () => true),
  getTemporaryAttendanceByEmployeeAndDate: vi.fn(async (employeeId: number, date: string) =>
    state.attendance.filter(
      (row) => row.employeeId === employeeId && normalizeDateToSlash(row.date) === normalizeDateToSlash(date)
    )
  ),
  createTemporaryAttendance: vi.fn(async (row: Record<string, any>) => {
    const created = { id: state.nextAttendanceId++, ...row };
    state.attendance.push(created);
    return created;
  }),
  updateTemporaryAttendance: vi.fn(async (id: number, patch: Record<string, any>) => {
    const target = state.attendance.find((row) => row.id === id);
    if (target) Object.assign(target, patch);
    return target;
  }),
  deleteTemporaryAttendanceByHolidayId: vi.fn(async (holidayId: number) => {
    state.attendance = state.attendance.filter((row) => row.holidayId !== holidayId);
    return true;
  }),
  getEmployeeById: vi.fn(async (id: number) => ({ id, name: '陳員工', specialLeaveUsedDates: [] })),
  updateEmployee: vi.fn(async () => undefined)
}));

vi.mock('../storage', () => ({ storage: storageMock }));

vi.mock('../middleware/requireAdmin', () => ({
  requireAdmin: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));

let registerHolidayRoutes: typeof import('./holidays.routes').registerHolidayRoutes;

beforeAll(async () => {
  ({ registerHolidayRoutes } = await import('./holidays.routes'));
});

beforeEach(() => {
  state.holidays = [];
  state.attendance = [];
  state.nextHolidayId = 1;
  state.nextAttendanceId = 1000;
  vi.clearAllMocks();
});

function scannedRow(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    employeeId: 7,
    date: '2026/11/14',
    clockIn: '07:56',
    clockOut: '19:03',
    isHoliday: false,
    isBarcodeScanned: true,
    holidayId: null,
    holidayType: null,
    ...overrides
  };
}

async function addHoliday(baseUrl: string, body: Record<string, any>) {
  return jsonRequest<Record<string, any>>(baseUrl, '/api/holidays', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const workedEntry = { employeeId: 7, date: '2026/11/14', name: '一般休息日加班', holidayType: 'worked' };

describe('holiday routes keep 考勤 in step with 假日出勤', () => {
  it('marks an existing scanned row as 假日出勤 when the entry is added', async () => {
    state.attendance = [scannedRow()];
    const server = await createJsonTestServer(registerHolidayRoutes);
    try {
      const result = await addHoliday(server.baseUrl, workedEntry);
      expect(result.response.status).toBe(201);
      expect(state.attendance).toHaveLength(1);
      expect(state.attendance[0]).toMatchObject({
        clockIn: '07:56',
        clockOut: '19:03',
        isHoliday: true,
        holidayType: 'worked',
        holidayId: null
      });
    } finally {
      await server.close();
    }
  });

  it('still creates the 08:00–17:00 row when nobody has clocked in yet', async () => {
    const server = await createJsonTestServer(registerHolidayRoutes);
    try {
      await addHoliday(server.baseUrl, workedEntry);
      expect(state.attendance).toEqual([
        expect.objectContaining({ clockIn: '08:00', clockOut: '17:00', holidayType: 'worked', holidayId: 1 })
      ]);
    } finally {
      await server.close();
    }
  });

  it('leaves existing rows alone for other holiday types', async () => {
    state.attendance = [scannedRow()];
    const server = await createJsonTestServer(registerHolidayRoutes);
    try {
      await addHoliday(server.baseUrl, { ...workedEntry, name: '病假', holidayType: 'sick_leave' });
      expect(state.attendance[0]).toMatchObject({ holidayType: null, isHoliday: false });
    } finally {
      await server.close();
    }
  });

  it('takes the mark off and keeps the clock times when the entry is deleted', async () => {
    state.attendance = [scannedRow()];
    const server = await createJsonTestServer(registerHolidayRoutes);
    try {
      const created = await addHoliday(server.baseUrl, workedEntry);
      const removed = await jsonRequest(server.baseUrl, `/api/holidays/${created.body.id}`, { method: 'DELETE' });
      expect(removed.response.status).toBe(204);
      expect(state.attendance).toHaveLength(1);
      expect(state.attendance[0]).toMatchObject({
        clockIn: '07:56',
        clockOut: '19:03',
        holidayType: null,
        isHoliday: false
      });
    } finally {
      await server.close();
    }
  });

  it('removes only the placeholder row when the entry had created one', async () => {
    const server = await createJsonTestServer(registerHolidayRoutes);
    try {
      const created = await addHoliday(server.baseUrl, workedEntry);
      await jsonRequest(server.baseUrl, `/api/holidays/${created.body.id}`, { method: 'DELETE' });
      expect(state.attendance).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
