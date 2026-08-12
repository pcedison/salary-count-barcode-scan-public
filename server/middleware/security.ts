import cors, { type CorsOptionsDelegate } from 'cors';
import type { Express, Request } from 'express';
import helmet from 'helmet';

import { createLogger } from '../utils/logger';

const log = createLogger('security');
const LINE_CSP_ORIGINS = [
  'https://access.line.me',
  'https://api.line.me',
  'https://liff.line.me',
  'https://liff-subwindow.line.me',
  'https://liffsdk.line-scdn.net',
  'https://static.line-scdn.net',
  'https://uts-front.line-apps.com'
];

function normalizeOrigin(origin: string): string {
  const trimmedOrigin = origin.trim();

  try {
    return new URL(trimmedOrigin).origin;
  } catch {
    let end = trimmedOrigin.length;
    while (end > 0 && trimmedOrigin.charCodeAt(end - 1) === 47) {
      end -= 1;
    }
    return trimmedOrigin.slice(0, end);
  }
}

function getAllowedOrigins(): string[] {
  return process.env.ALLOWED_ORIGINS?.split(',')
    .map(origin => normalizeOrigin(origin))
    .filter(Boolean) || [];
}

function getLineCspOrigins(): string[] {
  const hasLineIntegration =
    Boolean(process.env.LINE_LOGIN_CHANNEL_ID) &&
    Boolean(process.env.LINE_LOGIN_CHANNEL_SECRET) &&
    Boolean(process.env.LINE_LOGIN_CALLBACK_URL) &&
    Boolean(process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN) &&
    Boolean(process.env.LINE_MESSAGING_CHANNEL_SECRET);

  return hasLineIntegration ? LINE_CSP_ORIGINS : [];
}

function isSameOriginRequest(req: Request, origin: string): boolean {
  const host = req.get('host');

  if (!host) {
    return false;
  }

  return normalizeOrigin(origin) === normalizeOrigin(`${req.protocol}://${host}`);
}

export function setupSecurity(app: Express): void {
  const allowedOrigins = getAllowedOrigins();
  const isProduction = process.env.NODE_ENV === 'production';
  const lineCspOrigins = getLineCspOrigins();
  const corsOptions = {
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'X-Force-Update',
      'X-Scan-Device-Token'
    ]
  };
  const apiCorsOptions: CorsOptionsDelegate<Request> = (req, callback) => {
    const origin = req.get('origin');
    const originAllowed =
      !origin ||
      isSameOriginRequest(req, origin) ||
      (!isProduction && allowedOrigins.length === 0) ||
      allowedOrigins.includes(normalizeOrigin(origin));

    if (!originAllowed) {
      callback(new Error('Origin is not allowed'));
      return;
    }

    callback(null, {
      ...corsOptions,
      origin: true
    });
  };

  if (isProduction && allowedOrigins.length === 0) {
    log.warn(
      'ALLOWED_ORIGINS is not set in production; cross-origin requests will be blocked. ' +
      'Set ALLOWED_ORIGINS to a comma-separated list of allowed origins.'
    );
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", ...lineCspOrigins],
          // 字型全數自架(@fontsource,由 Vite 打包),不再允許任何外部字型/樣式來源
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", ...lineCspOrigins],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          frameSrc: ["'self'", ...lineCspOrigins],
          manifestSrc: ["'self'"],
          mediaSrc: ["'self'", 'data:'],
          workerSrc: ["'self'", 'blob:'],
          upgradeInsecureRequests: isProduction ? [] : null
        }
      },
      // HSTS: 1 year, include subdomains, eligible for browser preload list.
      // Only enable in production (HTTPS). Helmet default is 180 days without preload.
      hsts: isProduction
        ? { maxAge: 31536000, includeSubDomains: true, preload: true }
        : false,
      crossOriginEmbedderPolicy: false
    })
  );

  app.use('/api', cors(apiCorsOptions));

  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    }

    // Permissions-Policy: restrict access to sensitive browser APIs.
    // Helmet 8 does not yet expose a permissionsPolicy option, so we set it manually.
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
    );

    res.removeHeader('X-Powered-By');
    next();
  });
}

export function setupTrustProxy(app: Express): void {
  if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }
}
