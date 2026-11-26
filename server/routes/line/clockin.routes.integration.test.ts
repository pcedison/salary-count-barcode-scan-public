import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupAdminSession } from '../../session';
import { createJsonTestServer, jsonRequest } from '../../test-utils/http-test-server';
import { getTaiwanDateTimeParts } from '../scan-helpers';

const TEST_LINE_SESSION_HEADER = 'x-test-line-session';

const lineState = vi.hoisted(() => ({
  lineUserId: 'U1234567890TEST',
  employee: {
    id: 9,
    name: '離職測試員工',
    department: '測試部',
    active: false
  } as Record<string, any>
}));

const storageMock = vi.hoisted(() => ({
  getEmployeeByLineUserId: vi.fn(async (lineUserId: string) =>
    lineUserId === lineState.lineUserId ? lineState.employee : undefined
  ),
  getTemporaryAttendanceByEmployeeAndDate: vi.fn(async (): Promise<Array<Record<string, any>>> => []),
  getAllHolidays: vi.fn(async (): Promise<Array<Record<string, any>>> => []),
  updateTemporaryAttendance: vi.fn(async (id: number, patch: Record<string, any>) => ({ id, ...patch })),
  createTemporaryAttendance: vi.fn(async (attendance: Record<string, any>) => ({ id: 500, ...attendance }))
}));

vi.mock('../../storage', () => ({
  storage: storageMock
}));

vi.mock('../../services/line.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/line.service')>()),
  sendClockInNotification: vi.fn(async () => undefined)
}));

let registerLineClockInRoutes: typeof import('./clockin.routes').registerLineClockInRoutes;

beforeAll(async () => {
  ({ registerLineClockInRoutes } = await import('./clockin.routes'));
});

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.LINE_LOGIN_CHANNEL_ID = 'line-channel-id';
  process.env.LINE_LOGIN_CHANNEL_SECRET = 'line-channel-secret';
  process.env.LINE_LOGIN_CALLBACK_URL = 'https://example.com/api/line/callback';
  process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN = 'line-access-token';
  process.env.LINE_MESSAGING_CHANNEL_SECRET = 'line-messaging-secret';
  lineState.employee = {
    id: 9,
    name: '離職測試員工',
    department: '測試部',
    active: false
  };
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.LINE_LOGIN_CHANNEL_ID;
  delete process.env.LINE_LOGIN_CHANNEL_SECRET;
  delete process.env.LINE_LOGIN_CALLBACK_URL;
  delete process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_MESSAGING_CHANNEL_SECRET;
});

async function startServer() {
  return createJsonTestServer(registerLineClockInRoutes, {
    setupApp: async (app) => {
      setupAdminSession(app);
      app.use((req, _res, next) => {
        if (req.headers[TEST_LINE_SESSION_HEADER] === 'true') {
          req.session.lineAuth = {
            lineUserId: lineState.lineUserId,
            lineDisplayName: 'Line Tester',
            authenticatedAt: Date.now()
          };
        }
        next();
      });
    }
  });
}

async function clockIn(baseUrl: string) {
  return jsonRequest<{ success: boolean; action: string }>(baseUrl, '/api/line/clock-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [TEST_LINE_SESSION_HEADER]: 'true' },
    body: JSON.stringify({ lineUserId: lineState.lineUserId })
  });
}

function todayKey(): string {
  return getTaiwanDateTimeParts().dateKey;
}

describe('line clock-in on a 假日出勤 day', () => {
  beforeEach(() => {
    lineState.employee = { id: 9, name: '加班員工', department: '測試部', active: true };
  });

  it('marks a new clock-in as 假日出勤 when 假日設定 has an entry for that employee and date', async () => {
    storageMock.getAllHolidays.mockResolvedValueOnce([
      { id: 41, employeeId: 9, date: todayKey(), name: '一般休息日加班', holidayType: 'worked' }
    ]);
    const server = await startServer();
    try {
      const result = await clockIn(server.baseUrl);
      expect(result.response.status).toBe(200);
      expect(result.body.action).toBe('clock-in');
      expect(storageMock.createTemporaryAttendance).toHaveBeenCalledWith(
        expect.objectContaining({ employeeId: 9, isHoliday: true, holidayType: 'worked' })
      );
    } finally {
      await server.close();
    }
  });

  it('keeps an ordinary clock-in unmarked when another employee has the entry', async () => {
    storageMock.getAllHolidays.mockResolvedValueOnce([
      { id: 42, employeeId: 10, date: todayKey(), name: '一般休息日加班', holidayType: 'worked' }
    ]);
    const server = await startServer();
    try {
      await clockIn(server.baseUrl);
      const created = storageMock.createTemporaryAttendance.mock.calls[0]?.[0];
      expect(created).toMatchObject({ employeeId: 9, isHoliday: false });
      expect(created).not.toHaveProperty('holidayType');
    } finally {
      await server.close();
    }
  });

  it('turns the 08:00–17:00 placeholder into the real clock-in instead of adding a second row', async () => {
    storageMock.getTemporaryAttendanceByEmployeeAndDate.mockResolvedValueOnce([
      {
        id: 77,
        employeeId: 9,
        date: todayKey(),
        clockIn: '08:00',
        clockOut: '17:00',
        isHoliday: true,
        isBarcodeScanned: false,
        holidayId: 41,
        holidayType: 'worked'
      }
    ]);
    const server = await startServer();
    try {
      const result = await clockIn(server.baseUrl);
      expect(result.body.action).toBe('clock-in');
      expect(storageMock.createTemporaryAttendance).not.toHaveBeenCalled();
      expect(storageMock.updateTemporaryAttendance).toHaveBeenCalledWith(
        77,
        expect.objectContaining({ clockOut: '', isBarcodeScanned: true, holidayId: null, holidayType: 'worked' })
      );
    } finally {
      await server.close();
    }
  });
});

describe('line clock-in routes integration', () => {
  it('rejects inactive employees without writing attendance', async () => {
    const server = await createJsonTestServer(registerLineClockInRoutes, {
      setupApp: async (app) => {
        setupAdminSession(app);
        app.use((req, _res, next) => {
          if (req.headers[TEST_LINE_SESSION_HEADER] === 'true') {
            req.session.lineAuth = {
              lineUserId: lineState.lineUserId,
              lineDisplayName: 'Line Tester',
              authenticatedAt: Date.now()
            };
          }

          next();
        });
      }
    });

    try {
      const result = await jsonRequest<{
        success: boolean;
        code: string;
        error: string;
      }>(server.baseUrl, '/api/line/clock-in', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TEST_LINE_SESSION_HEADER]: 'true'
        },
        body: JSON.stringify({
          lineUserId: lineState.lineUserId
        })
      });

      expect(result.response.status).toBe(403);
      expect(result.body).toMatchObject({
        success: false,
        code: 'EMPLOYEE_INACTIVE',
        error: 'Inactive employees cannot clock in with LINE.'
      });
      expect(storageMock.getTemporaryAttendanceByEmployeeAndDate).not.toHaveBeenCalled();
      expect(storageMock.createTemporaryAttendance).not.toHaveBeenCalled();
      expect(storageMock.updateTemporaryAttendance).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
