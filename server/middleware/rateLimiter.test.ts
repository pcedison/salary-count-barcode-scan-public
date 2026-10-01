import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';

describe('rate limiter compatibility', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the login limit shared within an IPv6 /56 and independent across client networks', async () => {
    const { loginLimiter } = await import('./rateLimiter');
    const server = await createJsonTestServer((app) => {
      // Only this loopback test server accepts a single trusted proxy hop.
      app.set('trust proxy', 1);
      app.use('/api/login', loginLimiter);
      app.get('/api/login', (_req, res) => res.json({ ok: true }));
    });

    const requestFrom = (address: string) =>
      jsonRequest<{ code?: string; error?: string }>(server.baseUrl, '/api/login', {
        headers: { 'X-Forwarded-For': address }
      });

    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const address = attempt % 2 === 0
          ? '2001:db8:1234:5600::1'
          : '2001:db8:1234:567f::2';
        expect((await requestFrom(address)).response.status).toBe(200);
      }

      const limited = await requestFrom('2001:db8:1234:56ff::3');
      expect(limited.response.status).toBe(429);
      expect(limited.body).toEqual({
        success: false,
        code: 'LOGIN_RATE_LIMITED',
        error: 'Too many login attempts. Please wait before retrying.'
      });
      expect(limited.response.headers.get('ratelimit-limit')).toBe('5');
      expect(limited.response.headers.get('ratelimit-remaining')).toBe('0');
      expect(limited.response.headers.get('retry-after')).toBeTruthy();
      expect(limited.response.headers.get('x-ratelimit-limit')).toBeNull();

      expect((await requestFrom('2001:db8:1234:5700::1')).response.status).toBe(200);
      expect((await requestFrom('192.0.2.1')).response.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('exempts health probes while enforcing the production public API limit', async () => {
    const { publicApiLimiter } = await import('./rateLimiter');
    const server = await createJsonTestServer((app) => {
      app.use('/api', publicApiLimiter);
      app.get('/api/health', (_req, res) => res.json({ ok: true }));
      app.get('/api/test', (_req, res) => res.json({ ok: true }));
    });

    try {
      for (let probe = 0; probe < 61; probe += 1) {
        expect((await jsonRequest(server.baseUrl, '/api/health')).response.status).toBe(200);
      }

      for (let request = 0; request < 60; request += 1) {
        expect((await jsonRequest(server.baseUrl, '/api/test')).response.status).toBe(200);
      }

      const limited = await jsonRequest(server.baseUrl, '/api/test');
      expect(limited.response.status).toBe(429);
      expect(limited.body).toEqual({
        success: false,
        code: 'PUBLIC_API_RATE_LIMITED',
        message: 'Too many requests. Please try again later.'
      });
      expect((await jsonRequest(server.baseUrl, '/api/health')).response.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
