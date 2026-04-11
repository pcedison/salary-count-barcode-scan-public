import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupAdminSession } from '../../session';
import { createJsonTestServer, jsonRequest } from '../../test-utils/http-test-server';

const TEST_LINE_SESSION_HEADER = 'x-test-line-session';

const lineState = vi.hoisted(() => ({
  lineUserId: 'U1234567890TEST',
  boundEmployee: undefined as Record<string, any> | undefined,
  lookupEmployee: {
    id: 9,
    name: 'LINE 綁定測試員工',
    active: true
  } as Record<string, any> | undefined,
  pendingBinding: undefined as Record<string, any> | undefined
}));

const storageMock = vi.hoisted(() => ({
  getEmployeeByLineUserId: vi.fn(async () => lineState.boundEmployee),
  getEmployeeByIdNumber: vi.fn(async () => lineState.lookupEmployee),
  getPendingBindingByLineUserId: vi.fn(async () => lineState.pendingBinding),
  createPendingBinding: vi.fn(async (binding: Record<string, any>) => ({
    id: 1,
    ...binding
  }))
}));

vi.mock('../../storage', () => ({
  storage: storageMock
}));

vi.mock('../../middleware/requireAdmin', () => ({
  requireAdmin: () => (_req: any, _res: any, next: () => void) => next()
}));

vi.mock('../../services/line.service', async () => {
  const actual = await vi.importActual<typeof import('../../services/line.service')>('../../services/line.service');
  return {
    ...actual,
    isLineConfigured: vi.fn(() => true),
    pushMessage: vi.fn(async () => undefined)
  };
});

let registerLineBindRoutes: typeof import('./bind.routes').registerLineBindRoutes;

beforeAll(async () => {
  ({ registerLineBindRoutes } = await import('./bind.routes'));
});

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.LINE_LOGIN_CHANNEL_ID = 'line-channel-id';
  process.env.LINE_LOGIN_CHANNEL_SECRET = 'line-channel-secret';
  process.env.LINE_LOGIN_CALLBACK_URL = 'https://example.com/api/line/callback';
  process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN = 'line-access-token';
  process.env.LINE_MESSAGING_CHANNEL_SECRET = 'line-messaging-secret';

  lineState.boundEmployee = undefined;
  lineState.lookupEmployee = {
    id: 9,
    name: 'LINE 綁定測試員工',
    active: true
  };
  lineState.pendingBinding = undefined;

  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.LINE_LOGIN_CHANNEL_ID;
  delete process.env.LINE_LOGIN_CHANNEL_SECRET;
  delete process.env.LINE_LOGIN_CALLBACK_URL;
  delete process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_MESSAGING_CHANNEL_SECRET;
});

describe('line bind routes integration', () => {
  it('creates a pending binding request for an active unbound employee', async () => {
    const server = await createJsonTestServer(registerLineBindRoutes, {
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
        status: string;
        employeeName: string;
      }>(server.baseUrl, '/api/line/bind', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TEST_LINE_SESSION_HEADER]: 'true'
        },
        body: JSON.stringify({
          lineUserId: lineState.lineUserId,
          idNumber: 'A123456789'
        })
      });

      expect(result.response.status).toBe(200);
      expect(result.body).toMatchObject({
        success: true,
        status: 'pending',
        employeeName: 'LINE 綁定測試員工'
      });
      expect(storageMock.createPendingBinding).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it('returns unbound when only approved binding history remains after an employee is recycled', async () => {
    lineState.pendingBinding = {
      id: 1,
      employeeId: 9,
      lineUserId: lineState.lineUserId,
      status: 'approved'
    };

    const server = await createJsonTestServer(registerLineBindRoutes, {
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
      const result = await jsonRequest<{ status: string }>(
        server.baseUrl,
        `/api/line/binding-status/${encodeURIComponent(lineState.lineUserId)}`,
        {
          headers: {
            [TEST_LINE_SESSION_HEADER]: 'true'
          }
        }
      );

      expect(result.response.status).toBe(200);
      expect(result.body).toEqual({ status: 'unbound' });
    } finally {
      await server.close();
    }
  });

  it('does not create a binding request when recycled employees are filtered out of identifier lookup', async () => {
    lineState.lookupEmployee = undefined;

    const server = await createJsonTestServer(registerLineBindRoutes, {
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
      }>(server.baseUrl, '/api/line/bind', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TEST_LINE_SESSION_HEADER]: 'true'
        },
        body: JSON.stringify({
          lineUserId: lineState.lineUserId,
          idNumber: 'A123456789'
        })
      });

      expect(result.response.status).toBe(404);
      expect(result.body).toMatchObject({
        success: false,
        code: 'EMPLOYEE_NOT_FOUND'
      });
      expect(storageMock.createPendingBinding).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
