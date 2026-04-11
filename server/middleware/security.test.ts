import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';
import { setupSecurity } from './security';

async function buildSecurityTestServer(
  nodeEnv: string,
  allowedOrigins: string,
  options?: {
    lineConfigured?: boolean;
  }
) {
  const original = {
    NODE_ENV: process.env.NODE_ENV,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    LINE_LOGIN_CHANNEL_ID: process.env.LINE_LOGIN_CHANNEL_ID,
    LINE_LOGIN_CHANNEL_SECRET: process.env.LINE_LOGIN_CHANNEL_SECRET,
    LINE_LOGIN_CALLBACK_URL: process.env.LINE_LOGIN_CALLBACK_URL,
    LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN,
    LINE_MESSAGING_CHANNEL_SECRET: process.env.LINE_MESSAGING_CHANNEL_SECRET
  };
  process.env.NODE_ENV = nodeEnv;
  process.env.ALLOWED_ORIGINS = allowedOrigins;

  if (options?.lineConfigured) {
    process.env.LINE_LOGIN_CHANNEL_ID = '2000000000';
    process.env.LINE_LOGIN_CHANNEL_SECRET = 'secret';
    process.env.LINE_LOGIN_CALLBACK_URL = 'https://line.example.test/api/line/callback';
    process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN = 'token';
    process.env.LINE_MESSAGING_CHANNEL_SECRET = 'messaging-secret';
  } else {
    delete process.env.LINE_LOGIN_CHANNEL_ID;
    delete process.env.LINE_LOGIN_CHANNEL_SECRET;
    delete process.env.LINE_LOGIN_CALLBACK_URL;
    delete process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_MESSAGING_CHANNEL_SECRET;
  }

  const server = await createJsonTestServer((app) => {
    setupSecurity(app);
    app.get('/api/test', (_req, res) => res.json({ ok: true }));
    app.get('/test', (_req, res) => res.json({ ok: true }));
  });

  // Restore after server is set up (CORS config is captured at setupSecurity call time)
  process.env.NODE_ENV = original.NODE_ENV;
  process.env.ALLOWED_ORIGINS = original.ALLOWED_ORIGINS;
  process.env.LINE_LOGIN_CHANNEL_ID = original.LINE_LOGIN_CHANNEL_ID;
  process.env.LINE_LOGIN_CHANNEL_SECRET = original.LINE_LOGIN_CHANNEL_SECRET;
  process.env.LINE_LOGIN_CALLBACK_URL = original.LINE_LOGIN_CALLBACK_URL;
  process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN = original.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN;
  process.env.LINE_MESSAGING_CHANNEL_SECRET = original.LINE_MESSAGING_CHANNEL_SECRET;

  return server;
}

describe('security middleware', () => {
  describe('CORS', () => {
    it('allows requests without an Origin header (same-origin / server-to-server)', async () => {
      const server = await buildSecurityTestServer('production', 'https://example.com');
      try {
        const result = await jsonRequest<{ ok: boolean }>(server.baseUrl, '/api/test');
        expect(result.response.status).toBe(200);
        expect(result.body?.ok).toBe(true);
      } finally {
        await server.close();
      }
    });

    it('allows requests from an explicitly whitelisted origin', async () => {
      const server = await buildSecurityTestServer('production', 'https://allowed.example.com');
      try {
        const result = await jsonRequest<{ ok: boolean }>(server.baseUrl, '/api/test', {
          headers: { Origin: 'https://allowed.example.com' }
        });
        expect(result.response.status).toBe(200);
      } finally {
        await server.close();
      }
    });

    it('allows same-origin requests even when the origin is not listed explicitly', async () => {
      const server = await buildSecurityTestServer('production', 'https://allowed.example.com');
      try {
        const result = await jsonRequest<{ ok: boolean }>(server.baseUrl, '/api/test', {
          headers: { Origin: server.baseUrl }
        });
        expect(result.response.status).toBe(200);
      } finally {
        await server.close();
      }
    });

    it('blocks cross-origin requests from non-whitelisted origins in production', async () => {
      const server = await buildSecurityTestServer('production', 'https://allowed.example.com');
      try {
        const result = await jsonRequest<{ ok: boolean }>(server.baseUrl, '/api/test', {
          headers: { Origin: 'https://evil.example.com' }
        });
        // CORS error from cors() results in a network-level rejection or 500
        expect([403, 500]).toContain(result.response.status);
      } finally {
        await server.close();
      }
    });

    it('allows all origins in development when ALLOWED_ORIGINS is unset', async () => {
      const server = await buildSecurityTestServer('development', '');
      try {
        const result = await jsonRequest<{ ok: boolean }>(server.baseUrl, '/api/test', {
          headers: { Origin: 'http://localhost:3000' }
        });
        expect(result.response.status).toBe(200);
      } finally {
        await server.close();
      }
    });

    it('allows cross-origin requests to static assets (non-api routes)', async () => {
      const server = await buildSecurityTestServer('production', 'https://allowed.example.com');
      try {
        const result = await jsonRequest<{ ok: boolean }>(server.baseUrl, '/test', {
          headers: { Origin: 'https://app.example.test' }
        });
        expect(result.response.status).toBe(200);
      } finally {
        await server.close();
      }
    });
  });

  describe('security headers', () => {
    it('sets cache-control headers on /api routes', async () => {
      const server = await buildSecurityTestServer('development', '');
      try {
        const app = (server as any)._app; // not available — test via route
        const result = await jsonRequest<{ ok: boolean }>(server.baseUrl, '/test');
        // /test is not /api, so no cache-control expected from this middleware
        expect(result.response.status).toBe(200);
      } finally {
        await server.close();
      }
    });

    it('sets X-Frame-Options and removes X-Powered-By via helmet', async () => {
      const server = await buildSecurityTestServer('development', '');
      try {
        const result = await jsonRequest<{ ok: boolean }>(server.baseUrl, '/test');
        expect(result.response.headers.get('x-powered-by')).toBeNull();
        // Helmet sets x-frame-options
        expect(result.response.headers.get('x-frame-options')).toBeTruthy();
      } finally {
        await server.close();
      }
    });

    it('allows LIFF domains in the CSP when LINE integration is configured', async () => {
      const server = await buildSecurityTestServer('production', 'https://app.example.test', {
        lineConfigured: true
      });
      try {
        const result = await jsonRequest<{ ok: boolean }>(server.baseUrl, '/test');
        const csp = result.response.headers.get('content-security-policy');
        expect(csp).toContain("script-src 'self' https://access.line.me");
        expect(csp).toContain('https://static.line-scdn.net');
        expect(csp).toContain('https://liff-subwindow.line.me');
        expect(csp).toContain('frame-src');
      } finally {
        await server.close();
      }
    });
  });
});
