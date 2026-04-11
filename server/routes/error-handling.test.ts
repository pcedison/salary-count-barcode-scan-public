import type { Express, NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';

/**
 * Registers the production-style error handler used in server/index.ts.
 * Mirrors the logic there so we can unit-test it in isolation.
 */
function registerErrorHandler(app: Express, nodeEnv: string) {
  // Route that throws a 500 with an internal detail
  app.get('/throw-500', (_req, _res, next) => {
    const err: any = new Error('secret db connection string leaked');
    err.status = 500;
    next(err);
  });

  // Route that throws a 422 (client error — should always be forwarded)
  app.get('/throw-422', (_req, _res, next) => {
    const err: any = new Error('Validation failed: field x is required');
    err.status = 422;
    next(err);
  });

  // 404 for unknown routes
  app.use((_req, res) => {
    res.status(404).json({ message: 'Not Found' });
  });

  // Error handler matching server/index.ts behaviour
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || 'Internal Server Error';
    const isProduction = nodeEnv === 'production';
    const clientMessage = isProduction && status >= 500 ? 'Internal Server Error' : message;
    res.status(status).json({ message: clientMessage });
  });
}

describe('error handler', () => {
  it('hides internal error details in production for 5xx errors', async () => {
    const server = await createJsonTestServer((app) => {
      registerErrorHandler(app, 'production');
    });

    try {
      const result = await jsonRequest<{ message: string }>(server.baseUrl, '/throw-500');
      expect(result.response.status).toBe(500);
      expect(result.body?.message).toBe('Internal Server Error');
      expect(result.body?.message).not.toContain('secret');
    } finally {
      await server.close();
    }
  });

  it('exposes error details in development for 5xx errors', async () => {
    const server = await createJsonTestServer((app) => {
      registerErrorHandler(app, 'development');
    });

    try {
      const result = await jsonRequest<{ message: string }>(server.baseUrl, '/throw-500');
      expect(result.response.status).toBe(500);
      expect(result.body?.message).toContain('secret');
    } finally {
      await server.close();
    }
  });

  it('always forwards client error (4xx) message regardless of environment', async () => {
    const server = await createJsonTestServer((app) => {
      registerErrorHandler(app, 'production');
    });

    try {
      const result = await jsonRequest<{ message: string }>(server.baseUrl, '/throw-422');
      expect(result.response.status).toBe(422);
      expect(result.body?.message).toContain('Validation failed');
    } finally {
      await server.close();
    }
  });

  it('returns 404 for unknown routes', async () => {
    const server = await createJsonTestServer((app) => {
      registerErrorHandler(app, 'production');
    });

    try {
      const result = await jsonRequest<{ message: string }>(server.baseUrl, '/no-such-route');
      expect(result.response.status).toBe(404);
      expect(result.body?.message).toBe('Not Found');
    } finally {
      await server.close();
    }
  });
});
