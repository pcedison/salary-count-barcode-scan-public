import crypto from 'crypto';
import type { Express, Request, Response } from 'express';

import { normalizeDateToSlash } from '@shared/utils/specialLeaveSync';
import type { Employee, Holiday, TemporaryAttendance } from '@shared/schema';

import { PermissionLevel, logOperation, OperationType } from '../admin-auth';
import { deviceScanLimiter, scanLimiter, scanUnlockLimiter } from '../middleware/rateLimiter';
import {
  clearScanAccessSession,
  createScanAccessSession,
  getScanAccessSession,
  hasActiveScanAccessSession,
  hasAdminSession
} from '../session';
import { storage } from '../storage';
import { maskEmployeeIdentityForLog, normalizeEmployeeIdentity } from '../utils/employeeIdentity';
import { createLogger } from '../utils/logger';

import { handleRouteError } from './route-helpers';
import {
  buildEmployeeCacheKey,
  buildScanSuccessResult,
  filterAttendanceByDate,
  getLatestAttendanceRecord,
  getLatestIncompleteAttendanceRecord,
  getTaiwanDateTimeParts,
  type ScanSuccessResult
} from './scan-helpers';

const log = createLogger('scan');

const EMPLOYEE_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const HOLIDAY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEVICE_TOKEN_HEADER = 'x-scan-device-token';
const SCAN_UNLOCK_TOKEN_TTL_MS = 10 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface HolidayCache {
  entries: Holiday[];
  expiresAt: number;
}

type ScanUnlockTokenPayload = {
  scope: 'scan_unlock';
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  kioskChallenge: string;
};

const usedScanUnlockTokenNonces = new Map<string, number>();

function getCachedValue<T>(entry: CacheEntry<T> | null | undefined, now: number): T | undefined {
  if (!entry || entry.expiresAt <= now) {
    return undefined;
  }

  return entry.value;
}

function setCachedValue<T>(value: T, ttlMs: number, now: number): CacheEntry<T> {
  return {
    value,
    expiresAt: now + ttlMs
  };
}

function isBrowserScanUnlockRequired(): boolean {
  return process.env.NODE_ENV === 'production';
}

function isDeviceTokenRequired(): boolean {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.SCAN_DEVICE_TOKEN?.trim());
}

function resolveScanUnlockTokenSecret(): string {
  return (
    process.env.SCAN_UNLOCK_TOKEN_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    'development-scan-unlock-secret-do-not-use'
  );
}

function getConfiguredDeviceToken(): string | null {
  const token = process.env.SCAN_DEVICE_TOKEN?.trim();
  return token ? token : null;
}

function hasUnlockedBrowserScanAccess(req: Pick<Request, 'session'>): boolean {
  return (
    !isBrowserScanUnlockRequired() ||
    hasActiveScanAccessSession(req) ||
    hasAdminSession(req, PermissionLevel.ADMIN)
  );
}

function buildScanSessionPayload(req: Pick<Request, 'session'>) {
  const adminSession = hasAdminSession(req, PermissionLevel.ADMIN);
  const scanSession = getScanAccessSession(req);
  const required = isBrowserScanUnlockRequired();
  const unlocked = !required || Boolean(scanSession) || adminSession;

  return {
    required,
    unlocked,
    expiresAt: scanSession ? new Date(scanSession.expiresAt).toISOString() : null,
    authMode: scanSession ? 'scan_session' : adminSession ? 'admin_session' : 'none'
  } as const;
}

function respondScanUnlockRequired(res: Response) {
  res.setHeader('X-Scan-Session-Required', 'true');
  return res.status(401).json({
    success: false,
    code: 'SCAN_SESSION_REQUIRED',
    message: 'Barcode scan access is locked. Please unlock this kiosk with an admin-issued token.'
  });
}

function normalizeKioskChallenge(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function buildScanUnlockTokenPayload(kioskChallenge: string): ScanUnlockTokenPayload {
  const issuedAt = Date.now();
  return {
    scope: 'scan_unlock',
    issuedAt,
    expiresAt: issuedAt + SCAN_UNLOCK_TOKEN_TTL_MS,
    nonce: crypto.randomUUID(),
    kioskChallenge
  };
}

function encodeScanUnlockToken(payload: ScanUnlockTokenPayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', resolveScanUnlockTokenSecret())
    .update(encodedPayload)
    .digest('base64url');

  return `${encodedPayload}.${signature}`;
}

function decodeScanUnlockToken(token: string): ScanUnlockTokenPayload | null {
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = crypto
    .createHmac('sha256', resolveScanUnlockTokenSecret())
    .update(encodedPayload)
    .digest('base64url');

  const signatureBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Partial<ScanUnlockTokenPayload>;

    if (
      decoded?.scope !== 'scan_unlock' ||
      typeof decoded.issuedAt !== 'number' ||
      typeof decoded.expiresAt !== 'number' ||
      typeof decoded.nonce !== 'string' ||
      typeof decoded.kioskChallenge !== 'string'
    ) {
      return null;
    }

    return {
      scope: 'scan_unlock',
      issuedAt: decoded.issuedAt,
      expiresAt: decoded.expiresAt,
      nonce: decoded.nonce,
      kioskChallenge: decoded.kioskChallenge
    };
  } catch {
    return null;
  }
}

function cleanupExpiredScanUnlockTokens(now: number): void {
  for (const [nonce, expiresAt] of Array.from(usedScanUnlockTokenNonces.entries())) {
    if (expiresAt <= now) {
      usedScanUnlockTokenNonces.delete(nonce);
    }
  }
}

function consumeScanUnlockTokenNonce(payload: ScanUnlockTokenPayload): boolean {
  const now = Date.now();
  cleanupExpiredScanUnlockTokens(now);

  if (payload.expiresAt <= now) {
    return false;
  }

  if (usedScanUnlockTokenNonces.has(payload.nonce)) {
    return false;
  }

  usedScanUnlockTokenNonces.set(payload.nonce, payload.expiresAt);
  return true;
}

function hasValidDeviceToken(req: Request): boolean {
  const expected = getConfiguredDeviceToken();
  if (!expected) {
    return !isDeviceTokenRequired();
  }

  const provided = req.header(DEVICE_TOKEN_HEADER)?.trim() ?? '';
  if (!provided) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');

  return (
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function respondDeviceTokenRequired(res: Response, statusCode: 401 | 503 = 401) {
  res.setHeader('X-Scan-Device-Token-Required', 'true');
  return res.status(statusCode).json({
    success: false,
    code: statusCode === 503 ? 'SCAN_DEVICE_TOKEN_MISSING' : 'SCAN_DEVICE_TOKEN_REQUIRED',
    message:
      statusCode === 503
        ? 'Raspberry Pi scan endpoint is disabled until SCAN_DEVICE_TOKEN is configured.'
        : 'A valid device scan token is required.'
  });
}

function respondEmployeeInactive(res: Response) {
  return res.status(403).json({
    success: false,
    code: 'EMPLOYEE_INACTIVE',
    message: 'Inactive employees cannot clock in with barcode scans.'
  });
}

export function registerScanRoutes(app: Express): void {
  // Per-server dedup map: keeps rapid double-scan protection scoped to each server instance
  // (ensures test isolation when registerScanRoutes is called multiple times in tests)
  const recentScans = new Map<string, number>();
  const SCAN_DEDUP_WINDOW_MS = 2000;

  // Guard: return 503 for all scan endpoints when barcodeEnabled is false
  const SCAN_PATHS = ['/api/scan', '/api/barcode-scan', '/api/raspberry-scan', '/api/last-scan-result'];
  app.use(SCAN_PATHS, async (_req, res, next) => {
    const settings = await storage.getSettings();
    if (settings?.barcodeEnabled === false) {
      return res.status(503).json({
        success: false,
        code: 'BARCODE_DISABLED',
        message: '條碼打卡功能已停用'
      });
    }
    return next();
  });

  // ARCHITECTURE NOTE: In-memory caches are not shared across Node.js worker processes.
  // This design assumes single-process deployment (PM2 fork mode, not cluster mode).
  // If horizontal scaling is needed, migrate caches to Redis or a shared store.
  const employeeCache = new Map<string, CacheEntry<Employee>>();
  let holidayCache: HolidayCache | null = null;
  let lastScanResult: ScanSuccessResult | null = null;

  async function findEmployee(rawIdNumber: string): Promise<Employee | undefined> {
    const now = Date.now();
    const normalizedInput = normalizeEmployeeIdentity(rawIdNumber);
    const cacheKey = buildEmployeeCacheKey(normalizedInput);
    const cachedEmployee = getCachedValue(employeeCache.get(cacheKey), now);
    if (cachedEmployee) {
      return cachedEmployee;
    }

    const directEmployee = await storage.getEmployeeByIdNumber(normalizedInput);
    if (directEmployee) {
      employeeCache.set(cacheKey, setCachedValue(directEmployee, EMPLOYEE_CACHE_TTL_MS, now));
      return directEmployee;
    }

    return undefined;
  }

  async function isHoliday(dateKey: string): Promise<boolean> {
    const now = Date.now();
    if (!holidayCache || holidayCache.expiresAt <= now) {
      const holidays = await storage.getAllHolidays();
      holidayCache = {
        entries: holidays,
        expiresAt: now + HOLIDAY_CACHE_TTL_MS
      };
    }

    const normalizedDateKey = normalizeDateToSlash(dateKey);
    return holidayCache.entries.some(
      holiday => normalizeDateToSlash(holiday.date) === normalizedDateKey
    );
  }

  async function getPersistedLastScanResult(dateKey: string): Promise<ScanSuccessResult | undefined> {
    const records = await storage.getTemporaryAttendanceByDate(dateKey);
    const latestRecord = getLatestAttendanceRecord(records);

    if (!latestRecord?.employeeId) {
      return undefined;
    }

    const employee = await storage.getEmployeeById(latestRecord.employeeId);
    if (!employee) {
      return undefined;
    }

    return buildScanSuccessResult(employee, latestRecord, new Date().toISOString());
  }

  // NOTE: rapid double-scan protection missing — advisory lock should be added here.
  // The upsert below (check existing → create/update) is not atomic across concurrent
  // requests for the same employee.  To prevent duplicate records from a fast double-scan
  // each call should acquire a per-employee advisory lock before the read-then-write:
  //   await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${employee.id}::text))`);
  // This requires wrapping the body in a db.transaction() call.
  /** Look up the pending scan action without performing the scan. Used to key the dedup check. */
  async function getPendingAction(employeeId: number): Promise<{ action: 'clockIn' | 'clockOut'; latestIncompleteRecord: TemporaryAttendance | undefined }> {
    const { dateKey } = getTaiwanDateTimeParts();
    const existingRecords = filterAttendanceByDate(
      await storage.getTemporaryAttendanceByEmployeeAndDate(employeeId, dateKey),
      dateKey
    );
    const latestIncompleteRecord = getLatestIncompleteAttendanceRecord(existingRecords);
    return { action: latestIncompleteRecord ? 'clockOut' : 'clockIn', latestIncompleteRecord };
  }

  async function upsertAttendanceScan(
    employee: Employee,
    prefetched?: { latestIncompleteRecord: TemporaryAttendance | undefined }
  ): Promise<ScanSuccessResult> {
    const { dateKey, time, timestamp } = getTaiwanDateTimeParts();
    const isHolidayRecord = await isHoliday(dateKey);

    let latestIncompleteRecord: TemporaryAttendance | undefined;
    if (prefetched !== undefined) {
      latestIncompleteRecord = prefetched.latestIncompleteRecord;
    } else {
      const existingRecords = filterAttendanceByDate(
        await storage.getTemporaryAttendanceByEmployeeAndDate(employee.id, dateKey),
        dateKey
      );
      latestIncompleteRecord = getLatestIncompleteAttendanceRecord(existingRecords);
    }

    let attendanceRecord: TemporaryAttendance | undefined;

    if (latestIncompleteRecord) {
      attendanceRecord = await storage.updateTemporaryAttendance(latestIncompleteRecord.id, {
        clockOut: time
      });
    } else {
      attendanceRecord = await storage.createTemporaryAttendance({
        employeeId: employee.id,
        date: dateKey,
        clockIn: time,
        clockOut: '',
        isHoliday: isHolidayRecord,
        isBarcodeScanned: true
      });
    }

    if (!attendanceRecord) {
      throw new Error('Unable to persist scan attendance record');
    }

    const result = buildScanSuccessResult(employee, attendanceRecord, timestamp);
    lastScanResult = result;
    return result;
  }

  app.get('/api/scan/session', (req, res) => {
    res.json(buildScanSessionPayload(req));
  });

  app.post('/api/scan/session/token', scanUnlockLimiter, async (req, res) => {
    try {
      if (!hasAdminSession(req, PermissionLevel.ADMIN)) {
        logOperation(OperationType.AUTHORIZATION, 'Scan unlock token issuance rejected: admin session missing', {
          ip: req.ip,
          success: false,
          errorMessage: 'missing_admin_session'
        });
        return res.status(401).json({
          success: false,
          code: 'ADMIN_SESSION_REQUIRED',
          message: 'An admin session is required to issue a scan unlock token.'
        });
      }

      const kioskChallenge = normalizeKioskChallenge(req.body?.kioskChallenge);
      if (kioskChallenge.length < 8) {
        return res.status(400).json({
          success: false,
          code: 'KIOSK_CHALLENGE_REQUIRED',
          message: 'A kiosk challenge is required to issue an unlock token.'
        });
      }

      const payload = buildScanUnlockTokenPayload(kioskChallenge);
      logOperation(OperationType.AUTHORIZATION, `Issued scan unlock token for kiosk ${kioskChallenge}`, {
        ip: req.ip,
        success: true
      });
      return res.json({
        success: true,
        token: encodeScanUnlockToken(payload),
        expiresAt: new Date(payload.expiresAt).toISOString()
      });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.post('/api/scan/session/unlock', scanUnlockLimiter, async (req, res) => {
    try {
      if (!hasUnlockedBrowserScanAccess(req)) {
        const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
        const kioskChallenge = normalizeKioskChallenge(req.body?.kioskChallenge);
        if (!token) {
          return res.status(400).json({
            success: false,
            code: 'TOKEN_REQUIRED',
            message: 'An admin-issued unlock token is required.'
          });
        }

        const tokenPayload = decodeScanUnlockToken(token);
        if (
          !tokenPayload ||
          kioskChallenge.length < 8 ||
          tokenPayload.kioskChallenge !== kioskChallenge ||
          !consumeScanUnlockTokenNonce(tokenPayload)
        ) {
          logOperation(OperationType.AUTHORIZATION, `Scan unlock failed for kiosk ${kioskChallenge || '[missing]'}`, {
            ip: req.ip,
            success: false,
            errorMessage: 'invalid_scan_unlock_token'
          });
          return res.status(401).json({
            success: false,
            code: 'INVALID_SCAN_UNLOCK_TOKEN',
            message: 'The unlock token is invalid or expired.'
          });
        }

        await createScanAccessSession(req);
        logOperation(OperationType.AUTHORIZATION, `Unlocked scan kiosk ${kioskChallenge}`, {
          ip: req.ip,
          success: true
        });
      }

      return res.json({
        success: true,
        ...buildScanSessionPayload(req)
      });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.post('/api/scan/session/lock', async (req, res) => {
    try {
      const hadScanAccess = Boolean(getScanAccessSession(req));
      await clearScanAccessSession(req);
      if (hadScanAccess) {
        logOperation(OperationType.AUTHORIZATION, 'Locked barcode scan kiosk session', {
          ip: req.ip,
          success: true
        });
      }
      return res.json({
        success: true,
        ...buildScanSessionPayload(req)
      });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.get('/api/last-scan-result', async (req, res) => {
    try {
      if (!hasUnlockedBrowserScanAccess(req)) {
        return respondScanUnlockRequired(res);
      }

      const { dateKey } = getTaiwanDateTimeParts();
      if (
        lastScanResult &&
        normalizeDateToSlash(lastScanResult.attendance.date) === normalizeDateToSlash(dateKey)
      ) {
        return res.json(lastScanResult);
      }

      const persistedResult = await getPersistedLastScanResult(dateKey);
      if (!persistedResult) {
        return res.status(404).json({ error: '今日尚無打卡紀錄' });
      }

      lastScanResult = persistedResult;
      return res.json(persistedResult);
    } catch (err) {
      log.error('Failed to read last scan result', err);
      return handleRouteError(err, res);
    }
  });

  app.post('/api/barcode-scan', scanLimiter, async (req, res) => {
    try {
      if (!hasUnlockedBrowserScanAccess(req)) {
        return respondScanUnlockRequired(res);
      }

      const idNumber = typeof req.body?.idNumber === 'string' ? req.body.idNumber.trim() : '';
      if (!idNumber) {
        return res.status(400).json({
          success: false,
          message: 'A barcode or employee identifier is required.'
        });
      }

      const employee = await findEmployee(idNumber);
      if (!employee) {
        return res.status(404).json({
          success: false,
          message: 'Employee not found',
          code: 'EMPLOYEE_NOT_FOUND'
        });
      }
      if (!employee.active) {
        return respondEmployeeInactive(res);
      }

      // Determine pending action (clockIn/clockOut) to key the dedup check correctly.
      // This ensures clock-in → clock-out transitions are not blocked by the dedup window.
      const { action: pendingAction, latestIncompleteRecord } = await getPendingAction(employee.id);
      const scanKey = `${employee.id}-${pendingAction}`;
      const lastScan = recentScans.get(scanKey);
      if (lastScan && Date.now() - lastScan < SCAN_DEDUP_WINDOW_MS) {
        return res.status(429).json({ error: 'duplicate_scan', message: 'Too soon after last scan' });
      }
      recentScans.set(scanKey, Date.now());
      // Clean up entries older than the dedup window to prevent unbounded growth
      for (const [key, ts] of Array.from(recentScans.entries())) {
        if (Date.now() - ts >= SCAN_DEDUP_WINDOW_MS) {
          recentScans.delete(key);
        }
      }

      const result = await upsertAttendanceScan(employee, { latestIncompleteRecord });
      return res.json(result);
    } catch (err) {
      log.error('Barcode scan request failed:', err);
      return handleRouteError(err, res);
    }
  });

  app.post('/api/raspberry-scan', deviceScanLimiter, async (req, res) => {
    try {
      if (isDeviceTokenRequired() && !getConfiguredDeviceToken()) {
        return respondDeviceTokenRequired(res, 503);
      }

      if (!hasValidDeviceToken(req)) {
        return respondDeviceTokenRequired(res);
      }

      const idNumber = typeof req.body?.idNumber === 'string' ? req.body.idNumber.trim() : '';
      const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId : 'unknown';

      if (!idNumber) {
        return res.status(400).json({
          success: false,
          message: 'A barcode or employee identifier is required.',
          code: 'MISSING_ID'
        });
      }

      log.info(
        `Received scan from device ${deviceId}, identity=${maskEmployeeIdentityForLog(idNumber)}`
      );

      const employee = await findEmployee(idNumber);
      if (!employee) {
        return res.status(404).json({
          success: false,
          message: 'Employee not found',
          code: 'EMPLOYEE_NOT_FOUND'
        });
      }
      if (!employee.active) {
        return respondEmployeeInactive(res);
      }

      const { action: pendingActionRpi, latestIncompleteRecord: latestRpi } = await getPendingAction(employee.id);
      const scanKeyRpi = `${employee.id}-${pendingActionRpi}`;
      const lastScanRpi = recentScans.get(scanKeyRpi);
      if (lastScanRpi && Date.now() - lastScanRpi < SCAN_DEDUP_WINDOW_MS) {
        return res.status(429).json({ error: 'duplicate_scan', message: 'Too soon after last scan' });
      }
      recentScans.set(scanKeyRpi, Date.now());
      // Clean up entries older than the dedup window to prevent unbounded growth
      for (const [key, ts] of Array.from(recentScans.entries())) {
        if (Date.now() - ts >= SCAN_DEDUP_WINDOW_MS) {
          recentScans.delete(key);
        }
      }

      const result = await upsertAttendanceScan(employee, { latestIncompleteRecord: latestRpi });
      return res.json({
        success: true,
        code: 'SUCCESS',
        action: result.action,
        name: result.employeeName,
        department: result.department,
        time: result.clockTime,
        isHoliday: result.attendance.isHoliday ?? false
      });
    } catch (err) {
      log.error('Raspberry Pi scan request failed:', err);
      return handleRouteError(err, res);
    }
  });
}
