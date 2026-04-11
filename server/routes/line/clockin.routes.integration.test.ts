import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupAdminSession } from '../../session';
import { createJsonTestServer, jsonRequest } from '../../test-utils/http-test-server';

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
  getTemporaryAttendanceByEmployeeAndDate: vi.fn(async () => []),
  updateTemporaryAttendance: vi.fn(async () => undefined),
  createTemporaryAttendance: vi.fn(async () => undefined)
}));

vi.mock('../../storage', () => ({
  storage: storageMock
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
