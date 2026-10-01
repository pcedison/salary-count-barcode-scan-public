import type { Express, Request, Response } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';

import {
  createAdminSessionPolicy,
  parseAdminSessionTimeoutMinutes
} from '@shared/utils/adminSessionPolicy';
import { PermissionLevel } from './admin-auth';
import { createLogger } from './utils/logger';

const log = createLogger('session');

const DEFAULT_SESSION_SECRET = 'development-session-secret-do-not-use';

export const ADMIN_SESSION_COOKIE_NAME = 'employee_salary_admin.sid';

export interface AdminSessionState {
  isAdmin: true;
  permissionLevel: PermissionLevel;
  authenticatedAt: number;
  lastVerifiedAt: number;
  restoreEpoch?: string;
}

export interface ScanAccessSessionState {
  unlockedAt: number;
  expiresAt: number;
}

export interface LineAuthSessionState {
  lineUserId: string;
  lineDisplayName: string;
  linePictureUrl?: string;
  authenticatedAt: number;
}

declare module 'express-session' {
  interface SessionData {
    adminAuth?: AdminSessionState;
    scanAccess?: ScanAccessSessionState;
    lineAuth?: LineAuthSessionState;
    lineOAuthState?: string;
    // LINE OAuth 暫存資料（callback 後存入，ClockInPage 一次性取出即清除）
    lineTemp?: {
      lineUserId: string;
      lineDisplayName: string;
      linePictureUrl?: string;
    };
  }
}

function resolveSessionSecret(): string {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) {
    return process.env.SESSION_SECRET;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set to enable secure admin sessions in production');
  }

  if (process.env.NODE_ENV !== 'test') {
    log.warn('SESSION_SECRET 未設定，使用開發用暫時 session secret');
  }

  return DEFAULT_SESSION_SECRET;
}

export function getAdminSessionPolicy() {
  return createAdminSessionPolicy(
    parseAdminSessionTimeoutMinutes(process.env.SESSION_TIMEOUT)
  );
}

function getCookieSameSite(): 'lax' | 'strict' | 'none' {
  const sameSite = process.env.SESSION_SAME_SITE?.toLowerCase();

  if (sameSite === 'strict' || sameSite === 'lax' || sameSite === 'none') {
    return sameSite;
  }

  // Default to strict for stronger CSRF protection.
  // If LINE OAuth is enabled, set SESSION_SAME_SITE=lax in .env because the
  // redirect from access.line.me back to /api/line/callback is a cross-site
  // navigation and SameSite=Strict would block the session cookie on that request.
  return 'strict';
}

function isSecureCookieEnabled(): boolean {
  if (process.env.SESSION_SECURE === 'true') {
    return true;
  }

  if (process.env.SESSION_SECURE === 'false') {
    return false;
  }

  return process.env.NODE_ENV === 'production';
}

function isHttpOnlyEnabled(): boolean {
  return process.env.SESSION_HTTP_ONLY !== 'false';
}

function buildPoolSslConfig(
  url?: string
): boolean | { rejectUnauthorized: boolean } | undefined {
  if (!url) return undefined;
  try {
    const { hostname } = new URL(url);
    const isLocal =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1';
    if (isLocal) return false;

    const rejectUnauthorized =
      process.env.PGSSLREJECT_UNAUTHORIZED !== 'false';

    if (!rejectUnauthorized) {
      log.warn(
        'PGSSLREJECT_UNAUTHORIZED=false: SSL certificate validation is disabled for the session pool. ' +
        'This is insecure — only use this setting when your hosted pooler presents ' +
        'an untrusted certificate chain that cannot be resolved another way.'
      );
    }

    return { rejectUnauthorized };
  } catch {
    return undefined;
  }
}

export const PAYROLL_RESTORE_EPOCH_SID = '__payroll_restore_epoch__';
const requestRestoreEpochs = new WeakMap<Request, string>();

function createSessionStore() {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
    return { store: undefined, readRestoreEpoch: async () => '0' };
  }

  const PgStore = connectPgSimple(session);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: buildPoolSslConfig(process.env.DATABASE_URL)
  });

  const store = new PgStore({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  });
  return { store, readRestoreEpoch: async () => {
    // A fresh deployment may not yet have a session table; the store creates it
    // when the first session is saved. No existing login can survive its absence.
    const exists = await pool.query<{ present: boolean }>("SELECT to_regclass('public.user_sessions') IS NOT NULL AS present");
    if (!exists.rows[0]?.present) return '0';
    const result = await pool.query<{ epoch: string | null }>(
      "SELECT sess ->> 'payrollRestoreEpoch' AS epoch FROM user_sessions WHERE sid = $1",
      [PAYROLL_RESTORE_EPOCH_SID]
    );
    if (result.rows.length === 0) return '0';
    const epoch = result.rows[0]?.epoch;
    if (!epoch || !/^[a-f0-9-]{36}$/.test(epoch)) throw new Error('Invalid administrator session restore epoch.');
    return epoch;
  } };
}

function getBaseCookieOptions() {
  return {
    httpOnly: isHttpOnlyEnabled(),
    sameSite: getCookieSameSite() as 'lax' | 'strict' | 'none',
    secure: isSecureCookieEnabled(),
    path: '/'
  };
}

function getScanAccessTimeoutMs(): number {
  return 12 * 60 * 60 * 1000;
}

export function setupAdminSession(app: Express, options: { readRestoreEpoch?: () => Promise<string> } = {}): void {
  const sessionPolicy = getAdminSessionPolicy();
  const sessionStore = createSessionStore();
  const readRestoreEpoch = options.readRestoreEpoch ?? sessionStore.readRestoreEpoch;
  app.locals.readAdminRestoreEpoch = readRestoreEpoch;

  app.use(
    session({
      name: ADMIN_SESSION_COOKIE_NAME,
      secret: resolveSessionSecret(),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      proxy: process.env.TRUST_PROXY === 'true',
      store: sessionStore.store,
      cookie: {
        ...getBaseCookieOptions(),
        maxAge: sessionPolicy.timeoutMs
      }
    })
  );
  app.use(async (req, res, next) => {
    const routePath = req.path.toLowerCase().replace(/\/+$/, '');
    if (!req.session?.adminAuth && routePath !== '/api/verify-admin') return next();
    try {
      const currentEpoch = await readRestoreEpoch();
      requestRestoreEpochs.set(req, currentEpoch);
      if (req.session?.adminAuth && (req.session.adminAuth.restoreEpoch ?? '0') !== currentEpoch) {
        await clearAdminSession(req, res);
        return res.status(401).json({ code: 'AUTH_RESTORE_CHANGED', message: '資料已還原，請重新登入。' });
      }
      next();
    } catch (error) {
      // An unavailable epoch must never silently reinstate an old login.
      next(error);
    }
  });
}

export function hasAdminSession(
  req: { session?: Request['session'] },
  requiredLevel: PermissionLevel = PermissionLevel.ADMIN
): boolean {
  const adminAuth = req.session?.adminAuth;
  return Boolean(
    adminAuth?.isAdmin &&
      adminAuth.permissionLevel >= requiredLevel
  );
}

export function getScanAccessSession(
  req: { session?: Request['session'] }
): ScanAccessSessionState | null {
  const scanAccess = req.session?.scanAccess;
  if (!scanAccess) {
    return null;
  }

  if (scanAccess.expiresAt <= Date.now()) {
    return null;
  }

  return scanAccess;
}

export function hasActiveScanAccessSession(req: { session?: Request['session'] }): boolean {
  return getScanAccessSession(req) !== null;
}

export function touchAdminSession(req: { session?: Request['session'] }): void {
  if (!req.session?.adminAuth) {
    return;
  }

  req.session.adminAuth.lastVerifiedAt = Date.now();
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function createAdminSession(
  req: Request,
  permissionLevel: PermissionLevel = PermissionLevel.ADMIN
): Promise<void> {
  if (!req.session) {
    throw new Error('Admin session middleware is not initialized');
  }

  const readRestoreEpoch = req.app.locals.readAdminRestoreEpoch as (() => Promise<string>) | undefined;
  const restoreEpoch = readRestoreEpoch ? await readRestoreEpoch() : '0';
  if (requestRestoreEpochs.has(req) && requestRestoreEpochs.get(req) !== restoreEpoch) {
    throw Object.assign(new Error('資料已還原，請重新登入。'), { status: 409, code: 'AUTH_RESTORE_CHANGED' });
  }
  await regenerateSession(req);
  req.session.adminAuth = {
    isAdmin: true,
    permissionLevel,
    authenticatedAt: Date.now(),
    lastVerifiedAt: Date.now(),
    restoreEpoch,
  };
  await saveSession(req);
}

export async function promoteAdminSession(
  req: Request,
  permissionLevel: PermissionLevel = PermissionLevel.SUPER
): Promise<void> {
  if (!req.session?.adminAuth) {
    throw new Error('Admin session middleware is not initialized');
  }
  const readRestoreEpoch = req.app.locals.readAdminRestoreEpoch as (() => Promise<string>) | undefined;
  if (readRestoreEpoch && (req.session.adminAuth.restoreEpoch ?? '0') !== await readRestoreEpoch()) {
    throw Object.assign(new Error('資料已還原，請重新登入。'), { status: 409, code: 'AUTH_RESTORE_CHANGED' });
  }

  req.session.adminAuth = {
    ...req.session.adminAuth,
    isAdmin: true,
    permissionLevel,
    lastVerifiedAt: Date.now()
  };
  await saveSession(req);
}

export async function createScanAccessSession(req: Request): Promise<ScanAccessSessionState> {
  if (!req.session) {
    throw new Error('Scan session middleware is not initialized');
  }

  const now = Date.now();
  const scanAccess: ScanAccessSessionState = {
    unlockedAt: now,
    expiresAt: now + getScanAccessTimeoutMs()
  };

  req.session.scanAccess = scanAccess;
  await saveSession(req);
  return scanAccess;
}

export async function clearScanAccessSession(req: Request): Promise<void> {
  if (!req.session?.scanAccess) {
    return;
  }

  delete req.session.scanAccess;
  await saveSession(req);
}

export async function clearAdminSession(req: Request, res?: Response): Promise<void> {
  if (req.session) {
    await destroySession(req);
  }

  if (res) {
    res.clearCookie(ADMIN_SESSION_COOKIE_NAME, getBaseCookieOptions());
  }
}
