import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PermissionLevel } from '../../admin-auth';
import { setupAdminSession } from '../../session';
import { createJsonTestServer, jsonRequest } from '../../test-utils/http-test-server';

const authState = vi.hoisted(() => ({
  oauthStates: new Map<string, { state: string; expiresAt: Date }>(),
}));

const storageMock = vi.hoisted(() => ({
  createOAuthState: vi.fn(async ({ state, expiresAt }: { state: string; expiresAt: Date }) => {
    const record = { state, expiresAt };
    authState.oauthStates.set(state, record);
    return { id: 1, state, expiresAt, createdAt: new Date() };
  }),
  consumeOAuthState: vi.fn(async (stateValue: string) => {
    const record = authState.oauthStates.get(stateValue);
    if (!record || record.expiresAt.getTime() <= Date.now()) return undefined;
    authState.oauthStates.delete(stateValue);
    return record;
  }),
  getEmployeeByLineUserId: vi.fn(async () => undefined),
  getPendingBindingByLineUserId: vi.fn(async () => undefined),
}));

const serviceMock = vi.hoisted(() => ({
  exchangeCodeForToken: vi.fn(),
  getLineProfile: vi.fn(),
  verifyLiffAccessToken: vi.fn(),
  isLineConfigured: vi.fn(() => true),
}));

vi.mock('../../storage', () => ({ storage: storageMock }));
vi.mock('../../middleware/rateLimiter', () => ({
  lineSessionLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  liffClockInLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../services/line.service', async () => {
  const actual = await vi.importActual<typeof import('../../services/line.service')>('../../services/line.service');
  return { ...actual, ...serviceMock };
});

const testProfile = {
  userId: 'U1234567890TEST',
  displayName: 'Line Tester',
  pictureUrl: 'https://example.com/pic.png',
};
let registerLineAuthRoutes: typeof import('./auth.routes').registerLineAuthRoutes;

beforeAll(async () => {
  ({ registerLineAuthRoutes } = await import('./auth.routes'));
});
beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.LINE_LOGIN_CHANNEL_ID = 'line-channel-id';
  process.env.LINE_LOGIN_CHANNEL_SECRET = 'line-channel-secret';
  process.env.LINE_LOGIN_CALLBACK_URL = 'https://example.com/api/line/callback';
  process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN = 'line-access-token';
  process.env.LINE_MESSAGING_CHANNEL_SECRET = 'line-messaging-secret';
  authState.oauthStates.clear();
  vi.clearAllMocks();
  serviceMock.exchangeCodeForToken.mockResolvedValue({ access_token: 'access-token' });
  serviceMock.getLineProfile.mockResolvedValue(testProfile);
  serviceMock.verifyLiffAccessToken.mockResolvedValue(testProfile);
});
afterEach(() => {
  delete process.env.LINE_LOGIN_CHANNEL_ID;
  delete process.env.LINE_LOGIN_CHANNEL_SECRET;
  delete process.env.LINE_LOGIN_CALLBACK_URL;
  delete process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_MESSAGING_CHANNEL_SECRET;
  vi.restoreAllMocks();
});

async function createAuthTestServer() {
  return createJsonTestServer(registerLineAuthRoutes, {
    setupApp: (app) => {
      setupAdminSession(app);
      app.use((req, _res, next) => {
        if (req.get('x-test-existing-privileges') === 'true') {
          req.session.adminAuth = {
            isAdmin: true,
            permissionLevel: PermissionLevel.ADMIN,
            authenticatedAt: 1000,
            lastVerifiedAt: 1000,
          };
          req.session.scanAccess = { unlockedAt: 2000, expiresAt: Date.now() + 60000 };
        }
        next();
      });
      app.get('/test/session-state', (req, res) => {
        res.json({
          lineOAuthState: req.session.lineOAuthState,
          adminAuth: req.session.adminAuth,
          scanAccess: req.session.scanAccess,
        });
      });
    },
  });
}
function cookieFrom(response: Response): string {
  const cookie = response.headers.get('set-cookie');
  expect(cookie).toBeTruthy();
  return cookie!.split(';')[0];
}
async function startLogin(baseUrl: string, headers: Record<string, string> = {}) {
  const result = await jsonRequest(baseUrl, '/api/line/login', { redirect: 'manual', headers });
  expect(result.response.status).toBe(302);
  const location = result.response.headers.get('location');
  expect(location).toContain('https://access.line.me/oauth2/v2.1/authorize');
  const state = new URL(location!).searchParams.get('state')!;
  expect(state).toMatch(/^[a-f0-9]{64}$/);
  return { state, cookie: cookieFrom(result.response) };
}
async function callback(baseUrl: string, state: string, cookie?: string) {
  return jsonRequest(baseUrl, `/api/line/callback?code=test-code&state=${state}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });
}

describe('line auth routes integration', () => {
  it('saves the initiating session state before redirecting to LINE', async () => {
    const server = await createAuthTestServer();
    try {
      const login = await startLogin(server.baseUrl);
      expect(authState.oauthStates.has(login.state)).toBe(true);
      expect(storageMock.createOAuthState).toHaveBeenCalledOnce();
      const session = await jsonRequest<Record<string, unknown>>(server.baseUrl, '/test/session-state', {
        headers: { cookie: login.cookie },
      });
      expect(session.body?.lineOAuthState).toBe(login.state);
    } finally { await server.close(); }
  });

  it('rejects a callback with no initiating session without consuming a valid state', async () => {
    const server = await createAuthTestServer();
    try {
      const login = await startLogin(server.baseUrl);
      const result = await callback(server.baseUrl, login.state);
      expect(result.response.headers.get('location')).toBe('/clock-in?error=invalid_state');
      expect(storageMock.consumeOAuthState).not.toHaveBeenCalled();
      expect(serviceMock.exchangeCodeForToken).not.toHaveBeenCalled();
      expect(authState.oauthStates.has(login.state)).toBe(true);
    } finally { await server.close(); }
  });

  it('rejects another browser session and still accepts the initiating browser', async () => {
    const server = await createAuthTestServer();
    try {
      const initiating = await startLogin(server.baseUrl);
      const other = await startLogin(server.baseUrl);
      const rejected = await callback(server.baseUrl, initiating.state, other.cookie);
      expect(rejected.response.headers.get('location')).toBe('/clock-in?error=invalid_state');
      expect(storageMock.consumeOAuthState).not.toHaveBeenCalled();
      const accepted = await callback(server.baseUrl, initiating.state, initiating.cookie);
      expect(accepted.response.headers.get('location')).toBe('/clock-in');
      expect(serviceMock.exchangeCodeForToken).toHaveBeenCalledOnce();
    } finally { await server.close(); }
  });

  it('rejects mismatched and malformed state/code query values before exchanging tokens', async () => {
    const server = await createAuthTestServer();
    try {
      const login = await startLogin(server.baseUrl);
      const mismatched = await callback(server.baseUrl, 'missing', login.cookie);
      expect(mismatched.response.headers.get('location')).toBe('/clock-in?error=invalid_state');
      const malformed = await jsonRequest(server.baseUrl, `/api/line/callback?code=a&code=b&state=${login.state}`, {
        redirect: 'manual', headers: { cookie: login.cookie },
      });
      expect(malformed.response.headers.get('location')).toBe('/clock-in?error=missing_params');
      expect(storageMock.consumeOAuthState).not.toHaveBeenCalled();
      expect(serviceMock.exchangeCodeForToken).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('rejects expired initiating states before exchanging the callback code', async () => {
    const server = await createAuthTestServer();
    try {
      const login = await startLogin(server.baseUrl);
      authState.oauthStates.get(login.state)!.expiresAt = new Date(Date.now() - 60000);
      const result = await callback(server.baseUrl, login.state, login.cookie);
      expect(result.response.headers.get('location')).toBe('/clock-in?error=invalid_state');
      expect(storageMock.consumeOAuthState).toHaveBeenCalledWith(login.state);
      expect(serviceMock.exchangeCodeForToken).not.toHaveBeenCalled();
      expect(serviceMock.getLineProfile).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('rotates the session after successful login and rejects replay with the old cookie', async () => {
    const server = await createAuthTestServer();
    try {
      const login = await startLogin(server.baseUrl);
      const result = await callback(server.baseUrl, login.state, login.cookie);
      expect(result.response.headers.get('location')).toBe('/clock-in');
      expect(serviceMock.exchangeCodeForToken).toHaveBeenCalledWith('test-code');
      expect(serviceMock.getLineProfile).toHaveBeenCalledWith('access-token');
      expect(authState.oauthStates.has(login.state)).toBe(false);
      const newCookie = cookieFrom(result.response);
      expect(newCookie).not.toBe(login.cookie);
      const session = await jsonRequest<Record<string, unknown>>(server.baseUrl, '/api/line/temp-data', {
        headers: { cookie: newCookie },
      });
      expect(session.body).toMatchObject({ lineUserId: testProfile.userId, lineDisplayName: testProfile.displayName });
      const oldSession = await jsonRequest(server.baseUrl, '/api/line/temp-data', { headers: { cookie: login.cookie } });
      expect(oldSession.response.status).toBe(401);
      const replay = await callback(server.baseUrl, login.state, newCookie);
      expect(replay.response.headers.get('location')).toBe('/clock-in?error=invalid_state');
      expect(serviceMock.exchangeCodeForToken).toHaveBeenCalledOnce();
    } finally { await server.close(); }
  });

  it('allows only one concurrent callback to exchange a one-time state', async () => {
    const server = await createAuthTestServer();
    try {
      const login = await startLogin(server.baseUrl);
      const results = await Promise.all([
        callback(server.baseUrl, login.state, login.cookie),
        callback(server.baseUrl, login.state, login.cookie),
      ]);
      expect(results.map((result) => result.response.headers.get('location')).sort()).toEqual([
        '/clock-in', '/clock-in?error=invalid_state',
      ]);
      expect(serviceMock.exchangeCodeForToken).toHaveBeenCalledOnce();
      expect(serviceMock.getLineProfile).toHaveBeenCalledOnce();
    } finally { await server.close(); }
  });

  it('preserves the existing administrator and kiosk privileges when rotating the session', async () => {
    const server = await createAuthTestServer();
    try {
      const login = await startLogin(server.baseUrl, { 'x-test-existing-privileges': 'true' });
      const before = await jsonRequest<Record<string, unknown>>(server.baseUrl, '/test/session-state', {
        headers: { cookie: login.cookie },
      });
      const result = await callback(server.baseUrl, login.state, login.cookie);
      const after = await jsonRequest<Record<string, unknown>>(server.baseUrl, '/test/session-state', {
        headers: { cookie: cookieFrom(result.response) },
      });
      expect(after.body?.adminAuth).toEqual(before.body?.adminAuth);
      expect(after.body?.scanAccess).toEqual(before.body?.scanAccess);
      expect(after.body?.lineOAuthState).toBeUndefined();
    } finally { await server.close(); }
  });

  it('fails closed and does not log or return a token exchange error containing credentials', async () => {
    const server = await createAuthTestServer();
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const login = await startLogin(server.baseUrl);
      serviceMock.exchangeCodeForToken.mockRejectedValueOnce(new Error('synthetic-secret-code-and-token'));
      const result = await callback(server.baseUrl, login.state, login.cookie);
      expect(result.response.headers.get('location')).toBe('/clock-in?error=callback_failed');
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain('synthetic-secret-code-and-token');
      expect(serviceMock.getLineProfile).not.toHaveBeenCalled();
      expect(authState.oauthStates.has(login.state)).toBe(false);
    } finally { await server.close(); }
  });

  it('rotates a successful LIFF login session and preserves existing privileges', async () => {
    const server = await createAuthTestServer();
    try {
      const login = await startLogin(server.baseUrl, { 'x-test-existing-privileges': 'true' });
      const before = await jsonRequest<Record<string, unknown>>(server.baseUrl, '/test/session-state', {
        headers: { cookie: login.cookie },
      });
      const result = await jsonRequest<Record<string, unknown>>(server.baseUrl, '/api/line/liff-auth', {
        method: 'POST', headers: { cookie: login.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: 'synthetic-liff-token' }),
      });
      expect(result.response.status).toBe(200);
      const newCookie = cookieFrom(result.response);
      expect(newCookie).not.toBe(login.cookie);
      const after = await jsonRequest<Record<string, unknown>>(server.baseUrl, '/test/session-state', {
        headers: { cookie: newCookie },
      });
      expect(after.body?.adminAuth).toEqual(before.body?.adminAuth);
      expect(after.body?.scanAccess).toEqual(before.body?.scanAccess);
      expect(after.body?.lineOAuthState).toBeUndefined();
      expect(result.body?.bindingStatus).toBe('unbound');
    } finally { await server.close(); }
  });
});
