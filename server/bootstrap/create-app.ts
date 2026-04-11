import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import { loadEnvironment } from '../config/loadEnv';
import { validateEnv } from '../config/envValidator';
import { publicApiLimiter } from '../middleware/rateLimiter';
import { setupSecurity, setupTrustProxy } from '../middleware/security';
import { setupAdminSession } from '../session';
import { buildApiRequestLog, getApiRequestLogLevel } from '../utils/httpLogging';
import { createLogger } from '../utils/logger';

const requestLog = createLogger('http');

function installApiRequestLogging(app: Express): void {
  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;
    let capturedJsonResponse: Record<string, unknown> | undefined;

    const originalResJson = res.json;
    res.json = function patchedJson(bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };

    res.on('finish', () => {
      const duration = Date.now() - start;

      if (!path.startsWith('/api')) {
        return;
      }

      const logLine = buildApiRequestLog(
        req.method,
        path,
        res.statusCode,
        duration,
        capturedJsonResponse
      );
      const level = getApiRequestLogLevel(res.statusCode);
      requestLog[level](logLine);
    });

    next();
  });
}

export function createConfiguredApp(): Express {
  loadEnvironment();
  validateEnv();

  const app = express();

  setupTrustProxy(app);
  setupSecurity(app);
  setupAdminSession(app);

  app.use('/api', publicApiLimiter);

  // LINE webhook must keep the raw body for HMAC validation.
  app.use('/api/line/webhook', express.raw({ type: 'application/json' }));

  // CSV imports send full file content as a JSON string and need a larger limit.
  app.use('/api/admin/import', express.json({ limit: '5mb' }));
  app.use(express.json({ limit: '512kb' }));
  app.use(express.urlencoded({ extended: false, limit: '512kb' }));

  installApiRequestLogging(app);

  return app;
}

export function attachApiFallbackHandlers(
  app: Express,
  logger = createLogger('server')
): void {
  app.use('/api', (_req, res) => {
    res.status(404).json({ message: 'Not Found', code: 'NOT_FOUND' });
  });

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || 'Internal Server Error';

    logger.error('Unhandled request error', {
      status,
      method: req.method,
      path: req.path,
      message,
    });

    const isProduction = process.env.NODE_ENV === 'production';
    const clientMessage = isProduction && status >= 500 ? 'Internal Server Error' : message;
    res.status(status).json({ message: clientMessage });
  });
}
