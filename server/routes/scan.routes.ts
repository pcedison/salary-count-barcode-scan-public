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
import { storage, type AttendanceScanAction } from '../storage';
import { maskEmployeeIdentityForLog, normalizeEmployeeIdentity } from '../utils/employeeIdentity';
import { createLogger } from '../utils/logger';

import {
  ScanDedupGuard,
  buildScanUnlockTokenPayload,
  consumeScanUnlockTokenNonce,
  decodeScanUnlockToken,
  encodeScanUnlockToken,
  hasValidDeviceTokenValue
} from '../services/scanSecurity.service';

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

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface HolidayCache {
  entries: Holiday[];
  expiresAt: number;
}

class DuplicateScanStateError extends Error {
  constructor() {
    super('Scan state changed while another scan was being persisted.');
    this.name = 'DuplicateScanStateError';
  }
}

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

function hasValidDeviceToken(req: Request): boolean {
  const expected = getConfiguredDeviceToken();
  if (!expected) {
    return !isDeviceTokenRequired();
  }

  const provided = req.header(DEVICE_TOKEN_HEADER)?.trim() ?? '';
  return hasValidDeviceTokenValue(expected, provided);
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

function respondDuplicateScan(res: Response) {
  return res.status(429).json({
    error: 'duplicate_scan',
    code: 'DUPLICATE_SCAN',
    message: 'Too soon after last scan'
  });
}

export function registerScanRoutes(app: Express): void {
  // Per-server dedup guard: keeps rapid double-scan protection scoped to each server instance
  // (ensures test isolation when registerScanRoutes is called multiple times in tests)
  const scanDedupGuard = new ScanDedupGuard(2000);

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

  /** Look up the pending scan action without performing the scan. Used to key the dedup check. */
  async function getPendingAction(employeeId: number): Promise<{ action: AttendanceScanAction; latestIncompleteRecord: TemporaryAttendance | undefined }> {
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
    expectedAction: AttendanceScanAction
  ): Promise<ScanSuccessResult> {
    const { dateKey, time, timestamp } = getTaiwanDateTimeParts();
    const isHolidayRecord = await isHoliday(dateKey);

    const upsertResult = await storage.upsertTemporaryAttendanceScan({
      employeeId: employee.id,
      dateKey,
      time,
      isHoliday: isHolidayRecord,
      expectedAction
    });

    if (upsertResult.duplicate) {
      throw new DuplicateScanStateError();
    }

    const attendanceRecord = upsertResult.attendance;

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
      const { action: pendingAction } = await getPendingAction(employee.id);
      if (!scanDedupGuard.tryAcquire(employee.id, pendingAction)) {
        return respondDuplicateScan(res);
      }

      const result = await upsertAttendanceScan(employee, pendingAction);
      return res.json(result);
    } catch (err) {
      if (err instanceof DuplicateScanStateError) {
        return respondDuplicateScan(res);
      }
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

      const { action: pendingActionRpi } = await getPendingAction(employee.id);
      if (!scanDedupGuard.tryAcquire(employee.id, pendingActionRpi)) {
        return respondDuplicateScan(res);
      }

      const result = await upsertAttendanceScan(employee, pendingActionRpi);
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
      if (err instanceof DuplicateScanStateError) {
        return respondDuplicateScan(res);
      }
      log.error('Raspberry Pi scan request failed:', err);
      return handleRouteError(err, res);
    }
  });
}
