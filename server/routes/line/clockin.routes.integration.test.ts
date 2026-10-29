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

const repositoryMock = vi.hoisted(() => ({ getState: vi.fn(), getReceipt: vi.fn(), submit: vi.fn() }));
const notify = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../repositories/lineClockInRepository', () => ({ lineClockInRepository: repositoryMock }));
vi.mock('../../services/line.service', () => ({ isLineConfigured: () => true, sendClockInNotification: notify }));

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

  async function activeServer() {
    lineState.employee = { id: 9, name: '測試員工', department: '測試部', active: true };
    return createJsonTestServer(registerLineClockInRoutes, {
      setupApp: async app => {
        setupAdminSession(app);
        app.use((req, _res, next) => {
          if (req.headers[TEST_LINE_SESSION_HEADER] === 'true') req.session.lineAuth = {
            lineUserId: lineState.lineUserId, lineDisplayName: 'Test', authenticatedAt: Date.now(),
          };
          next();
        });
      },
    });
  }

  const headers = { 'content-type': 'application/json', [TEST_LINE_SESSION_HEADER]: 'true' };

  it('requires a LINE session on state, receipt lookup and submit', async () => {
    const server = await activeServer();
    try {
      for (const [path, method] of [['/state', 'GET'], ['/requests/anything', 'GET'], ['', 'POST']]) {
        const result = await jsonRequest(server.baseUrl, `/api/line/clock-in${path}`, { method });
        expect(result.response.status).toBe(401);
        expect(result.response.headers.get('cache-control')).toBe('no-store');
      }
      expect(repositoryMock.submit).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('checks caller identity on GET as well as POST before any repository access', async () => {
    const server = await activeServer();
    try {
      const get = await jsonRequest(server.baseUrl, '/api/line/clock-in/state?lineUserId=another-user', { headers });
      const post = await jsonRequest(server.baseUrl, '/api/line/clock-in', { headers, method: 'POST', body: JSON.stringify({ lineUserId: 'another-user' }) });
      expect(get.response.status).toBe(403);
      expect(post.response.status).toBe(403);
      expect(repositoryMock.getState).not.toHaveBeenCalled();
      expect(repositoryMock.submit).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('returns uncacheable state and the original receipt without mutating on lookup', async () => {
    const server = await activeServer();
    const state = { success: true, dateKey: '2026/10/29', action: 'clock-in', stateVersion: 'v1.test', serverTimestamp: '2026-10-29T00:00:00.000Z' };
    const receipt = { ...state, eventId: 'original', employeeName: 'Original name' };
    repositoryMock.getState.mockResolvedValue(state);
    repositoryMock.getReceipt.mockResolvedValueOnce(receipt).mockResolvedValueOnce(undefined);
    try {
      const result = await jsonRequest(server.baseUrl, '/api/line/clock-in/state', { headers });
      expect(result.body).toEqual(state);
      expect(new Date((result.body as typeof state).serverTimestamp).toISOString()).toBe(state.serverTimestamp);
      expect(result.response.headers.get('cache-control')).toBe('no-store');
      const found = await jsonRequest(server.baseUrl, '/api/line/clock-in/requests/original', { headers });
      expect(found.body).toEqual(receipt);
      expect(repositoryMock.getReceipt).toHaveBeenCalledWith(9, lineState.lineUserId, 'original');
      const absent = await jsonRequest(server.baseUrl, '/api/line/clock-in/requests/missing', { headers });
      expect(absent.response.status).toBe(404);
      expect(absent.body).toMatchObject({ code: 'LINE_CLOCK_RECEIPT_NOT_FOUND' });
      expect(repositoryMock.submit).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('returns identical replay body and sends notification only after the first commit', async () => {
    const server = await activeServer();
    const receipt = { success: true, eventId: 'same-event', action: 'clock-in', employeeName: 'Test', clockTime: '08:00' };
    repositoryMock.submit.mockResolvedValueOnce({ receipt, replayed: false }).mockResolvedValueOnce({ receipt, replayed: true });
    try {
      const first = await jsonRequest(server.baseUrl, '/api/line/clock-in', { headers, method: 'POST', body: '{}' });
      const replay = await jsonRequest(server.baseUrl, '/api/line/clock-in', { headers, method: 'POST', body: '{}' });
      expect(first.body).toEqual(receipt);
      expect(replay.body).toEqual(receipt);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(storageMock.createTemporaryAttendance).not.toHaveBeenCalled();
      expect(storageMock.updateTemporaryAttendance).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('preserves definite rejection codes and never notifies after a rejected transaction', async () => {
    const server = await activeServer();
    repositoryMock.submit.mockRejectedValue(Object.assign(new Error('State changed'), { status: 409, code: 'LINE_CLOCK_STATE_CONFLICT' }));
    try {
      const result = await jsonRequest(server.baseUrl, '/api/line/clock-in', { headers, method: 'POST', body: '{}' });
      expect(result.response.status).toBe(409);
      expect(result.body).toMatchObject({ code: 'LINE_CLOCK_STATE_CONFLICT' });
      expect(notify).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
});
