import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';
import { setupAdminSession } from '../session';
import { hashAdminPin } from '../utils/adminPinAuth';

const TEST_PIN = '123456';
const TEST_SUPER_PIN = '654321';
const hashedTestPin = hashAdminPin(TEST_PIN);

const settingsState = vi.hoisted(() => ({
  settings: {
    id: 1,
    baseHourlyRate: 119,
    ot1Multiplier: 1.34,
    ot2Multiplier: 1.67,
    baseMonthSalary: 28590,
    welfareAllowance: 0,
    deductions: [],
    allowances: [],
    adminPin: '',
    updatedAt: new Date('2026-03-12T00:00:00.000Z')
  } as Record<string, any>,
  savedSettings: null as null | Record<string, any>
}));

const storageMock = vi.hoisted(() => ({
  getSettings: vi.fn(async () => settingsState.settings),
  createOrUpdateSettings: vi.fn(async (payload: Record<string, any>) => {
    settingsState.savedSettings = payload;
    settingsState.settings = {
      ...settingsState.settings,
      ...payload
    };
    return settingsState.settings;
  })
}));

vi.mock('../storage', () => ({
  storage: storageMock
}));

vi.mock('../middleware/rateLimiter', () => ({
  loginLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  strictLimiter: (_req: unknown, _res: unknown, next: () => void) => next()
}));

let registerAdminRoutes: typeof import('./admin.routes').registerAdminRoutes;

beforeAll(async () => {
  ({ registerAdminRoutes } = await import('./admin.routes'));
});

beforeEach(() => {
  process.env.SUPER_ADMIN_PIN = TEST_SUPER_PIN;
  settingsState.settings = {
    id: 1,
    baseHourlyRate: 119,
    ot1Multiplier: 1.34,
    ot2Multiplier: 1.67,
    baseMonthSalary: 28590,
    welfareAllowance: 0,
    deductions: [],
    allowances: [],
    adminPin: hashedTestPin,
    updatedAt: new Date('2026-03-12T00:00:00.000Z')
  };
  settingsState.savedSettings = null;
  vi.clearAllMocks();
});

afterEach(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.SESSION_SECRET;
  delete process.env.SESSION_SECURE;
  delete process.env.PGSSLREJECT_UNAUTHORIZED;
  delete process.env.SUPER_ADMIN_PIN;
});

describe('admin routes integration', () => {
  it('creates, restores, and destroys an admin session via cookie auth', async () => {
    const server = await createJsonTestServer(registerAdminRoutes, {
      setupApp: async (app) => {
        setupAdminSession(app);
      }
    });

    try {
      const loginResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/verify-admin', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          pin: '123456'
        })
      });

      expect(loginResult.response.status).toBe(200);
      expect(loginResult.body).toMatchObject({
        success: true,
        authMode: 'session',
        permissionLevel: 3,
        sessionTimeoutMinutes: 60,
        sessionTimeoutMs: 60 * 60 * 1000,
        sessionRefreshIntervalMs: 5 * 60 * 1000
      });

      const sessionCookie = loginResult.response.headers.get('set-cookie');
      expect(sessionCookie).toContain('employee_salary_admin.sid=');
      const cookieHeader = sessionCookie?.split(';')[0];

      const sessionResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/admin/session', {
        headers: {
          cookie: cookieHeader || ''
        }
      });
      expect(sessionResult.response.status).toBe(200);
      expect(sessionResult.body).toMatchObject({
        success: true,
        isAdmin: true,
        authMode: 'session',
        permissionLevel: 3,
        sessionTimeoutMinutes: 60,
        sessionTimeoutMs: 60 * 60 * 1000,
        sessionRefreshIntervalMs: 5 * 60 * 1000
      });

      const logoutResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/admin/logout', {
        method: 'POST',
        headers: {
          cookie: cookieHeader || ''
        }
      });
      expect(logoutResult.response.status).toBe(200);
      expect(logoutResult.body).toEqual({ success: true });

      const postLogoutSession = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/admin/session', {
        headers: {
          cookie: cookieHeader || ''
        }
      });
      expect(postLogoutSession.response.status).toBe(200);
      expect(postLogoutSession.body).toMatchObject({
        success: true,
        isAdmin: false
      });
    } finally {
      await server.close();
    }
  });

  it('elevates an authenticated admin session to SUPER only through the explicit elevation route', async () => {
    const server = await createJsonTestServer(registerAdminRoutes, {
      setupApp: async (app) => {
        setupAdminSession(app);
      }
    });

    try {
      const loginResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/verify-admin', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          pin: '123456'
        })
      });

      expect(loginResult.body).toMatchObject({
        success: true,
        permissionLevel: 3
      });

      const loginCookie = loginResult.response.headers.get('set-cookie');
      const loginCookieHeader = loginCookie?.split(';')[0];

      const elevateResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/admin/elevate-super', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: loginCookieHeader || ''
        },
        body: JSON.stringify({
          pin: TEST_SUPER_PIN
        })
      });

      expect(elevateResult.response.status).toBe(200);
      expect(elevateResult.body).toMatchObject({
        success: true,
        authMode: 'session',
        permissionLevel: 4
      });

      const elevatedCookie = elevateResult.response.headers.get('set-cookie');
      const elevatedCookieHeader = elevatedCookie?.split(';')[0];

      const sessionResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/admin/session', {
        headers: {
          cookie: elevatedCookieHeader || loginCookieHeader || ''
        }
      });

      expect(sessionResult.response.status).toBe(200);
      expect(sessionResult.body).toMatchObject({
        success: true,
        isAdmin: true,
        permissionLevel: 4
      });
    } finally {
      await server.close();
    }
  });

  it('updates admin pin through an authenticated session without legacy header auth', async () => {
    const server = await createJsonTestServer(registerAdminRoutes, {
      setupApp: async (app) => {
        setupAdminSession(app);
      }
    });

    try {
      const loginResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/verify-admin', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          pin: '123456'
        })
      });

      const sessionCookie = loginResult.response.headers.get('set-cookie');
      const cookieHeader = sessionCookie?.split(';')[0];

      const elevateResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/admin/elevate-super', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader || ''
        },
        body: JSON.stringify({
          pin: TEST_SUPER_PIN
        })
      });

      expect(elevateResult.response.status).toBe(200);
      const elevatedCookie = elevateResult.response.headers.get('set-cookie');
      const elevatedCookieHeader = elevatedCookie?.split(';')[0] || cookieHeader || '';

      const updateResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/update-admin-pin', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: elevatedCookieHeader
        },
        body: JSON.stringify({
          oldPin: '123456',
          newPin: '602947'
        })
      });

      expect(updateResult.response.status).toBe(200);
      expect(updateResult.body).toMatchObject({
        success: true
      });
      expect(settingsState.savedSettings?.adminPin).toContain(':');
    } finally {
      await server.close();
    }
  });

  it('rejects admin pin updates from a non-elevated admin session', async () => {
    const server = await createJsonTestServer(registerAdminRoutes, {
      setupApp: async (app) => {
        setupAdminSession(app);
      }
    });

    try {
      const loginResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/verify-admin', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          pin: TEST_PIN
        })
      });

      const sessionCookie = loginResult.response.headers.get('set-cookie');
      const cookieHeader = sessionCookie?.split(';')[0];

      const updateResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/update-admin-pin', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader || ''
        },
        body: JSON.stringify({
          oldPin: TEST_PIN,
          newPin: '602947'
        })
      });

      expect(updateResult.response.status).toBe(403);
      expect(settingsState.savedSettings).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('rejects super elevation in production when SUPER_ADMIN_PIN is not configured', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'admin-session-secret-1234567890123456';
    process.env.SESSION_SECURE = 'false';
    delete process.env.SUPER_ADMIN_PIN;

    const server = await createJsonTestServer(registerAdminRoutes, {
      setupApp: async (app) => {
        setupAdminSession(app);
      }
    });

    try {
      const loginResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/verify-admin', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          pin: TEST_PIN
        })
      });

      const sessionCookie = loginResult.response.headers.get('set-cookie');
      const cookieHeader = sessionCookie?.split(';')[0];

      const elevateResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/admin/elevate-super', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader || ''
        },
        body: JSON.stringify({
          pin: TEST_PIN
        })
      });

      expect(elevateResult.response.status).toBe(503);
      expect(elevateResult.body).toMatchObject({
        success: false,
        message: 'SUPER_ADMIN_PIN is not configured for this deployment.'
      });
    } finally {
      await server.close();
    }
  });

  it('rejects plaintext SUPER_ADMIN_PIN values in production even when the route is reachable', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'admin-session-secret-1234567890123456';
    process.env.SESSION_SECURE = 'false';
    process.env.SUPER_ADMIN_PIN = TEST_SUPER_PIN;

    const server = await createJsonTestServer(registerAdminRoutes, {
      setupApp: async (app) => {
        setupAdminSession(app);
      }
    });

    try {
      const loginResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/verify-admin', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          pin: TEST_PIN
        })
      });

      const sessionCookie = loginResult.response.headers.get('set-cookie');
      const cookieHeader = sessionCookie?.split(';')[0];

      const elevateResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/admin/elevate-super', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader || ''
        },
        body: JSON.stringify({
          pin: TEST_SUPER_PIN
        })
      });

      expect(elevateResult.response.status).toBe(401);
      expect(elevateResult.body).toMatchObject({
        success: false,
        message: 'Super-admin credential is incorrect'
      });
    } finally {
      await server.close();
    }
  });

  it('exposes the configured admin session timeout policy to the client', async () => {
    const previousSessionTimeout = process.env.SESSION_TIMEOUT;
    process.env.SESSION_TIMEOUT = '15';

    const server = await createJsonTestServer(registerAdminRoutes, {
      setupApp: async (app) => {
        setupAdminSession(app);
      }
    });

    try {
      const loginResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/verify-admin', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          pin: '123456'
        })
      });

      expect(loginResult.body).toMatchObject({
        success: true,
        permissionLevel: 3,
        sessionTimeoutMinutes: 15,
        sessionTimeoutMs: 15 * 60 * 1000,
        sessionRefreshIntervalMs: 225 * 1000
      });
    } finally {
      if (previousSessionTimeout === undefined) {
        delete process.env.SESSION_TIMEOUT;
      } else {
        process.env.SESSION_TIMEOUT = previousSessionTimeout;
      }

      await server.close();
    }
  });

  it('rejects admin pin updates when the current pin is incorrect', async () => {
    const server = await createJsonTestServer(registerAdminRoutes, {
      setupApp: async (app) => {
        setupAdminSession(app);
      }
    });

    try {
      const loginResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/verify-admin', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          pin: TEST_PIN
        })
      });

      const sessionCookie = loginResult.response.headers.get('set-cookie');
      const cookieHeader = sessionCookie?.split(';')[0];

      const elevateResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/admin/elevate-super', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader || ''
        },
        body: JSON.stringify({
          pin: TEST_SUPER_PIN
        })
      });

      expect(elevateResult.response.status).toBe(200);
      const elevatedCookie = elevateResult.response.headers.get('set-cookie');
      const elevatedCookieHeader = elevatedCookie?.split(';')[0] || cookieHeader || '';

      const updateResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/update-admin-pin', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: elevatedCookieHeader
        },
        body: JSON.stringify({
          oldPin: '000001',
          newPin: '602947'
        })
      });

      expect(updateResult.response.status).toBe(401);
      expect(updateResult.body).toMatchObject({
        success: false,
        message: 'Current PIN is incorrect'
      });
      expect(settingsState.savedSettings).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('rejects weak admin pin updates before writing settings', async () => {
    const server = await createJsonTestServer(registerAdminRoutes, {
      setupApp: async (app) => {
        setupAdminSession(app);
      }
    });

    try {
      const loginResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/verify-admin', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          pin: TEST_PIN
        })
      });

      const sessionCookie = loginResult.response.headers.get('set-cookie');
      const cookieHeader = sessionCookie?.split(';')[0];

      const elevateResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/admin/elevate-super', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader || ''
        },
        body: JSON.stringify({
          pin: TEST_SUPER_PIN
        })
      });

      expect(elevateResult.response.status).toBe(200);
      const elevatedCookie = elevateResult.response.headers.get('set-cookie');
      const elevatedCookieHeader = elevatedCookie?.split(';')[0] || cookieHeader || '';

      const updateResult = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/update-admin-pin', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: elevatedCookieHeader
        },
        body: JSON.stringify({
          oldPin: TEST_PIN,
          newPin: '111111'
        })
      });

      expect(updateResult.response.status).toBe(400);
      expect(updateResult.body).toMatchObject({
        success: false,
        message: 'New PIN does not meet security requirements'
      });
      expect(updateResult.body?.errors).toEqual(
        expect.arrayContaining(['此 PIN 碼過於簡單或常見', 'PIN 不能為重複數字'])
      );
      expect(settingsState.savedSettings).toBeNull();
    } finally {
      await server.close();
    }
  });
});
