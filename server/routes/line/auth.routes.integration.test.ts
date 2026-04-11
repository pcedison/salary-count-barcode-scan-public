import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  getOAuthState: vi.fn(async (stateValue: string) => authState.oauthStates.get(stateValue)),
  deleteOAuthState: vi.fn(async (stateValue: string) => authState.oauthStates.delete(stateValue)),
}));

const serviceMock = vi.hoisted(() => ({
  exchangeCodeForToken: vi.fn(),
  getLineProfile: vi.fn(),
  verifyLiffAccessToken: vi.fn(),
  isLineConfigured: vi.fn(() => true),
}));

vi.mock('../../storage', () => ({
  storage: storageMock
}));

vi.mock('../../services/line.service', async () => {
  const actual = await vi.importActual<typeof import('../../services/line.service')>('../../services/line.service');
  return {
    ...actual,
    exchangeCodeForToken: serviceMock.exchangeCodeForToken,
    getLineProfile: serviceMock.getLineProfile,
    verifyLiffAccessToken: serviceMock.verifyLiffAccessToken,
    isLineConfigured: serviceMock.isLineConfigured
  };
});

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
  serviceMock.getLineProfile.mockResolvedValue({
    userId: 'U1234567890TEST',
    displayName: 'Line Tester',
    pictureUrl: 'https://example.com/pic.png'
  });
});

afterEach(() => {
  delete process.env.LINE_LOGIN_CHANNEL_ID;
  delete process.env.LINE_LOGIN_CHANNEL_SECRET;
  delete process.env.LINE_LOGIN_CALLBACK_URL;
  delete process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_MESSAGING_CHANNEL_SECRET;
});

describe('line auth routes integration', () => {
  it('creates an OAuth state and redirects to LINE login', async () => {
    const server = await createJsonTestServer(registerLineAuthRoutes, {
      setupApp: async (app) => {
        setupAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest(server.baseUrl, '/api/line/login', {
        redirect: 'manual'
      });

      expect(result.response.status).toBe(302);
      const location = result.response.headers.get('location');
      expect(location).toContain('https://access.line.me/oauth2/v2.1/authorize');
      expect(location).toContain('state=');

      const state = new URL(location!).searchParams.get('state');
      expect(state).toMatch(/^[a-f0-9]{64}$/);
      expect(authState.oauthStates.has(state!)).toBe(true);
      expect(storageMock.createOAuthState).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it('rejects callback requests with an invalid OAuth state', async () => {
    const server = await createJsonTestServer(registerLineAuthRoutes, {
      setupApp: async (app) => {
        setupAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest(server.baseUrl, '/api/line/callback?code=test-code&state=missing', {
        redirect: 'manual'
      });

      expect(result.response.status).toBe(302);
      expect(result.response.headers.get('location')).toBe('/clock-in?error=invalid_state');
      expect(serviceMock.exchangeCodeForToken).not.toHaveBeenCalled();
      expect(serviceMock.getLineProfile).not.toHaveBeenCalled();
      expect(storageMock.deleteOAuthState).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('expires stale OAuth states before exchanging the callback code', async () => {
    const staleState = 'stale-oauth-state';
    authState.oauthStates.set(staleState, {
      state: staleState,
      expiresAt: new Date(Date.now() - 60_000)
    });

    const server = await createJsonTestServer(registerLineAuthRoutes, {
      setupApp: async (app) => {
        setupAdminSession(app);
      }
    });

    try {
      const result = await jsonRequest(server.baseUrl, `/api/line/callback?code=test-code&state=${staleState}`, {
        redirect: 'manual'
      });

      expect(result.response.status).toBe(302);
      expect(result.response.headers.get('location')).toBe('/clock-in?error=state_expired');
      expect(storageMock.deleteOAuthState).toHaveBeenCalledWith(staleState);
      expect(serviceMock.exchangeCodeForToken).not.toHaveBeenCalled();
      expect(serviceMock.getLineProfile).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('stores LINE session data after a successful callback', async () => {
    const validState = 'valid-oauth-state';
    authState.oauthStates.set(validState, {
      state: validState,
      expiresAt: new Date(Date.now() + 60_000)
    });

    const server = await createJsonTestServer(registerLineAuthRoutes, {
      setupApp: async (app) => {
        setupAdminSession(app);
      }
    });

    try {
      const callbackResult = await jsonRequest(server.baseUrl, `/api/line/callback?code=test-code&state=${validState}`, {
        redirect: 'manual'
      });

      expect(callbackResult.response.status).toBe(302);
      expect(callbackResult.response.headers.get('location')).toBe('/clock-in');
      expect(serviceMock.exchangeCodeForToken).toHaveBeenCalledWith('test-code');
      expect(serviceMock.getLineProfile).toHaveBeenCalledWith('access-token');
      expect(storageMock.deleteOAuthState).toHaveBeenCalledWith(validState);

      const cookie = callbackResult.response.headers.get('set-cookie');
      expect(cookie).toBeTruthy();
      const sessionCookie = cookie!.split(';')[0];

      const sessionResult = await jsonRequest<{
        success: boolean;
        lineUserId: string;
        lineDisplayName: string;
        linePictureUrl?: string;
      }>(server.baseUrl, '/api/line/temp-data', {
        headers: {
          cookie: sessionCookie
        }
      });

      expect(sessionResult.response.status).toBe(200);
      expect(sessionResult.body).toMatchObject({
        lineUserId: 'U1234567890TEST',
        lineDisplayName: 'Line Tester',
        linePictureUrl: 'https://example.com/pic.png'
      });
    } finally {
      await server.close();
    }
  });
});
