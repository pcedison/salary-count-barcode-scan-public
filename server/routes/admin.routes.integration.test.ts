import crypto from 'crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';
import { setupAdminSession } from '../session';
import { ADMIN_PIN_WORK_LIMITS, hashAdminPin, hashAdminPinAsync, needsRehash, verifyStoredAdminPinAsync } from '../utils/adminPinAuth';

const TEST_PIN = '123456';
const TEST_SUPER_PIN = '654321';
const hashedTestPin = hashAdminPin(TEST_PIN);
const hashedTestSuperPin = hashAdminPin(TEST_SUPER_PIN);

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
  }),
  compareAndSwapAdminPin: vi.fn(async (expectedHash: string, newHash: string) => {
    if (settingsState.settings.adminPin !== expectedHash) return false;
    settingsState.savedSettings = { adminPin: newHash };
    settingsState.settings = { ...settingsState.settings, adminPin: newHash };
    return true;
  }),
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
  process.env.SUPER_ADMIN_PIN = hashedTestSuperPin;
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
  vi.restoreAllMocks();
  process.env.NODE_ENV = 'test';
  delete process.env.SESSION_SECRET;
  delete process.env.SESSION_SECURE;
  delete process.env.PGSSLREJECT_UNAUTHORIZED;
  delete process.env.SUPER_ADMIN_PIN;
});

describe('bounded admin authentication integration', () => {
  async function serverWithSession() {
    return createJsonTestServer(registerAdminRoutes, { setupApp: async app => setupAdminSession(app) });
  }

  async function postPin(baseUrl: string, path: string, body: unknown, cookie = '') {
    return jsonRequest<Record<string, any>>(baseUrl, path, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
    });
  }

  function legacyPin(pin: string) {
    const salt = 'ab'.repeat(16);
    return `${salt}:${crypto.pbkdf2Sync(pin, salt, 1_000, 64, 'sha512').toString('hex')}`;
  }

  it.each(['development', 'test'])('refuses ordinary PIN elevation without a SUPER credential in %s', async nodeEnv => {
    process.env.NODE_ENV = nodeEnv;
    delete process.env.SUPER_ADMIN_PIN;
    const server = await serverWithSession();
    try {
      const login = await postPin(server.baseUrl, '/api/verify-admin', { pin: TEST_PIN });
      expect(login.response.status).toBe(200);
      expect(login.body.superAdminConfigured).toBe(false);
      const cookie = login.response.headers.get('set-cookie')!.split(';')[0];
      storageMock.getSettings.mockClear();

      const elevation = await postPin(server.baseUrl, '/api/admin/elevate-super', { pin: TEST_PIN }, cookie);
      expect(elevation.response.status).toBe(401);
      expect(elevation.body).toMatchObject({ success: false });
      expect(storageMock.getSettings).not.toHaveBeenCalled();
      const session = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/admin/session', { headers: { cookie } });
      expect(session.body).toMatchObject({ isAdmin: true, permissionLevel: 3, superAdminConfigured: false });
    } finally {
      await server.close();
    }
  });

  it('rejects ordinary PIN elevation while the independently configured SUPER hash can elevate', async () => {
    const server = await serverWithSession();
    try {
      const login = await postPin(server.baseUrl, '/api/verify-admin', { pin: TEST_PIN });
      expect(login.response.status).toBe(200);
      expect(login.body.superAdminConfigured).toBe(true);
      const cookie = login.response.headers.get('set-cookie')!.split(';')[0];
      expect((await postPin(server.baseUrl, '/api/admin/elevate-super', { pin: TEST_PIN }, cookie)).response.status).toBe(401);
      const ordinarySession = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/admin/session', { headers: { cookie } });
      expect(ordinarySession.body.permissionLevel).toBe(3);
      const elevation = await postPin(server.baseUrl, '/api/admin/elevate-super', { pin: TEST_SUPER_PIN }, cookie);
      expect(elevation.response.status).toBe(200);
      expect(elevation.body.permissionLevel).toBe(4);
    } finally {
      await server.close();
    }
  });

  it('rejects non-string and oversized login input before credential work and does not create a session', async () => {
    const server = await serverWithSession();
    const pbkdf2 = vi.spyOn(crypto, 'pbkdf2');
    try {
      for (const pin of [123456, {}, [], 'a'.repeat(129)]) {
        const result = await postPin(server.baseUrl, '/api/verify-admin', { pin });
        expect(result.response.status).toBe(400);
        expect(result.body.success).toBe(false);
        expect(result.response.headers.get('set-cookie')).toBeNull();
      }
      expect(storageMock.getSettings).not.toHaveBeenCalled();
      expect(pbkdf2).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('returns bounded busy responses for login and super elevation while session requests remain responsive', async () => {
    const server = await serverWithSession();
    const callbacks: Array<(error: Error | null, key: Buffer) => void> = [];
    const jobs: Array<Promise<string>> = [];
    try {
      const login = await postPin(server.baseUrl, '/api/verify-admin', { pin: TEST_PIN });
      const cookie = login.response.headers.get('set-cookie')!.split(';')[0];
      process.env.SUPER_ADMIN_PIN = hashedTestPin;
      vi.spyOn(crypto, 'pbkdf2').mockImplementation((...args: any[]) => callbacks.push(args[5]));
      const count = ADMIN_PIN_WORK_LIMITS.concurrency + ADMIN_PIN_WORK_LIMITS.queued;
      jobs.push(...Array.from({ length: count }, () => hashAdminPinAsync('495827')));

      for (const [path, sessionCookie] of [['/api/verify-admin', ''], ['/api/admin/elevate-super', cookie]]) {
        const busy = await postPin(server.baseUrl, path, { pin: TEST_PIN }, sessionCookie);
        expect(busy.response.status).toBe(503);
        expect(busy.response.headers.get('retry-after')).toBe('1');
        expect(busy.body).toMatchObject({ success: false, code: 'AUTH_BUSY' });
        if (!sessionCookie) expect(busy.response.headers.get('set-cookie')).toBeNull();
      }
      // All native jobs remain held: this request must finish without crypto completion.
      const session = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/admin/session', { headers: { cookie } });
      expect(session.response.status).toBe(200);
      expect(session.body).toMatchObject({ isAdmin: true, permissionLevel: 3 });
      expect(callbacks).toHaveLength(ADMIN_PIN_WORK_LIMITS.concurrency);
    } finally {
      while (callbacks.length) callbacks.shift()!(null, Buffer.alloc(64));
      await Promise.all(jobs);
      await server.close();
    }
  });

  it('upgrades the original verified legacy hash with CAS and leaves other settings untouched', async () => {
    const original = legacyPin(TEST_PIN);
    settingsState.settings.adminPin = original;
    const initialSettings = { ...settingsState.settings };
    const server = await serverWithSession();
    try {
      const result = await postPin(server.baseUrl, '/api/verify-admin', { pin: TEST_PIN });
      expect(result.response.status).toBe(200);
      expect(result.body.success).toBe(true);
      expect(storageMock.compareAndSwapAdminPin).toHaveBeenCalledWith(original, settingsState.settings.adminPin);
      expect(needsRehash(settingsState.settings.adminPin)).toBe(false);
      expect(await verifyStoredAdminPinAsync(settingsState.settings.adminPin, TEST_PIN)).toBe(true);
      expect(settingsState.settings).toEqual({ ...initialSettings, adminPin: settingsState.settings.adminPin });
      expect(storageMock.createOrUpdateSettings).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('does not overwrite a newly changed PIN or issue a session when a legacy upgrade loses its CAS', async () => {
    const original = legacyPin(TEST_PIN);
    const replacement = legacyPin('602947');
    settingsState.settings.adminPin = original;
    storageMock.compareAndSwapAdminPin.mockImplementationOnce(async () => {
      settingsState.settings = { ...settingsState.settings, adminPin: replacement };
      return false;
    });
    const server = await serverWithSession();
    try {
      const result = await postPin(server.baseUrl, '/api/verify-admin', { pin: TEST_PIN });
      expect(result.response.status).toBe(409);
      expect(result.body).toMatchObject({ success: false, code: 'AUTH_CREDENTIAL_CHANGED' });
      expect(result.response.headers.get('set-cookie')).toBeNull();
      expect(settingsState.settings.adminPin).toBe(replacement);
      expect(storageMock.compareAndSwapAdminPin.mock.calls[0][0]).toBe(original);
      expect(storageMock.createOrUpdateSettings).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('prevents an explicit PIN update from overwriting a concurrent credential change', async () => {
    const replacement = legacyPin('495827');
    const server = await serverWithSession();
    try {
      const login = await postPin(server.baseUrl, '/api/verify-admin', { pin: TEST_PIN });
      const cookie = login.response.headers.get('set-cookie')!.split(';')[0];
      const elevation = await postPin(server.baseUrl, '/api/admin/elevate-super', { pin: TEST_SUPER_PIN }, cookie);
      const elevatedCookie = elevation.response.headers.get('set-cookie')!.split(';')[0];
      storageMock.compareAndSwapAdminPin.mockImplementationOnce(async () => {
        settingsState.settings = { ...settingsState.settings, adminPin: replacement };
        return false;
      });
      const result = await postPin(server.baseUrl, '/api/update-admin-pin', { oldPin: TEST_PIN, newPin: '602947' }, elevatedCookie);
      expect(result.response.status).toBe(409);
      expect(result.body).toMatchObject({ success: false, code: 'AUTH_CREDENTIAL_CHANGED' });
      expect(settingsState.settings.adminPin).toBe(replacement);
      expect(storageMock.compareAndSwapAdminPin.mock.calls[0][0]).toBe(hashedTestPin);
      expect(storageMock.createOrUpdateSettings).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('supports hashed SUPER credentials in production and rejects invalid elevation/update input before crypto', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'synthetic-production-test-session-secret-1234567890';
    process.env.SESSION_SECURE = 'false';
    process.env.SUPER_ADMIN_PIN = hashedTestPin;
    const server = await serverWithSession();
    try {
      const login = await postPin(server.baseUrl, '/api/verify-admin', { pin: TEST_PIN });
      const cookie = login.response.headers.get('set-cookie')!.split(';')[0];
      const pbkdf2 = vi.spyOn(crypto, 'pbkdf2');
      const invalidElevation = await postPin(server.baseUrl, '/api/admin/elevate-super', { pin: {} }, cookie);
      expect(invalidElevation.response.status).toBe(400);
      expect(pbkdf2).not.toHaveBeenCalled();
      const session = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/admin/session', { headers: { cookie } });
      expect(session.body.permissionLevel).toBe(3);
      const elevation = await postPin(server.baseUrl, '/api/admin/elevate-super', { pin: TEST_PIN }, cookie);
      expect(elevation.response.status).toBe(200);
      expect(elevation.body.permissionLevel).toBe(4);
      const elevatedCookie = elevation.response.headers.get('set-cookie')!.split(';')[0];
      pbkdf2.mockClear();
      const invalidUpdate = await postPin(server.baseUrl, '/api/update-admin-pin', { oldPin: TEST_PIN, newPin: [] }, elevatedCookie);
      expect(invalidUpdate.response.status).toBe(400);
      expect(pbkdf2).not.toHaveBeenCalled();
      expect(storageMock.compareAndSwapAdminPin).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
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

  it.each(['development', 'test', 'production'].flatMap(nodeEnv => [
    { nodeEnv, caseName: 'plaintext', configured: TEST_SUPER_PIN },
    { nodeEnv, caseName: 'malformed hash', configured: 'invalid:hash' },
  ]))('treats unsupported SUPER $caseName as unconfigured in $nodeEnv even when startup validation is bypassed', async ({ nodeEnv, configured }) => {
    process.env.NODE_ENV = nodeEnv;
    process.env.SESSION_SECRET = 'admin-session-secret-1234567890123456';
    process.env.SESSION_SECURE = 'false';
    process.env.SUPER_ADMIN_PIN = configured;

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

      expect(loginResult.body.superAdminConfigured).toBe(false);
      expect(elevateResult.response.status).toBe(nodeEnv === 'production' ? 503 : 401);
      expect(elevateResult.body).toMatchObject({
        success: false,
        message: nodeEnv === 'production' ? 'SUPER_ADMIN_PIN is not configured for this deployment.' : 'Super-admin credential is incorrect'
      });
      const session = await jsonRequest<Record<string, any>>(server.baseUrl, '/api/admin/session', {
        headers: { cookie: cookieHeader || '' }
      });
      expect(session.body).toMatchObject({ isAdmin: true, permissionLevel: 3, superAdminConfigured: false });
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
