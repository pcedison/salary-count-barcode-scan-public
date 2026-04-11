import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { encrypt as encryptAes } from '@shared/utils/encryption';
import { normalizeDateToSlash } from '@shared/utils/specialLeaveSync';
import { buildEmployeeIdentityLookupCandidates, matchesEmployeeIdentity } from '../utils/employeeIdentity';

import { setupTestAdminSession, TEST_ADMIN_HEADER } from '../test-utils/admin-test-session';
import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';

const scanState = vi.hoisted(() => ({
  currentDateKey: '2026/03/12',
  currentTime: '08:30',
  currentTimestamp: '2026-03-12T00:30:00.000Z',
  employees: [] as Array<Record<string, any>>,
  holidays: [] as Array<Record<string, any>>,
  attendanceRecords: [] as Array<Record<string, any>>,
  nextAttendanceId: 1
}));

const storageMock = vi.hoisted(() => ({
  getEmployeeByIdNumber: vi.fn(async (idNumber: string) => {
    const lookupCandidates = buildEmployeeIdentityLookupCandidates(idNumber);
    return (
      scanState.employees.find((employee) => lookupCandidates.includes(employee.idNumber)) ||
      scanState.employees.find((employee) => matchesEmployeeIdentity(employee, idNumber))
    );
  }),
  getAllEmployees: vi.fn(async () => scanState.employees),
  getAllHolidays: vi.fn(async () => scanState.holidays),
  getTemporaryAttendanceByEmployeeAndDate: vi.fn(async (employeeId: number, date: string) =>
    scanState.attendanceRecords.filter(
      (record) =>
        record.employeeId === employeeId &&
        normalizeDateToSlash(record.date) === normalizeDateToSlash(date)
    )
  ),
  updateTemporaryAttendance: vi.fn(async (id: number, updates: Record<string, unknown>) => {
    const index = scanState.attendanceRecords.findIndex((record) => record.id === id);
    if (index === -1) {
      return undefined;
    }

    scanState.attendanceRecords[index] = {
      ...scanState.attendanceRecords[index],
      ...updates
    };

    return scanState.attendanceRecords[index];
  }),
  createTemporaryAttendance: vi.fn(async (payload: Record<string, unknown>) => {
    const record = {
      id: scanState.nextAttendanceId,
      holidayId: null,
      holidayType: null,
      createdAt: new Date(scanState.currentTimestamp),
      ...payload
    };

    scanState.nextAttendanceId += 1;
    scanState.attendanceRecords.push(record);
    return record;
  }),
  getTemporaryAttendance: vi.fn(async () => scanState.attendanceRecords),
  getTemporaryAttendanceByDate: vi.fn(async (_date: string) => scanState.attendanceRecords),
  getEmployeeById: vi.fn(async (id: number) =>
    scanState.employees.find((employee) => employee.id === id)
  ),
  getSettings: vi.fn(async () => null)
}));

vi.mock('../storage', () => ({
  storage: storageMock
}));

vi.mock('./scan-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scan-helpers')>();
  return {
    ...actual,
    getTaiwanDateTimeParts: vi.fn(() => ({
      dateKey: scanState.currentDateKey,
      time: scanState.currentTime,
      timestamp: scanState.currentTimestamp
    }))
  };
});

let registerScanRoutes: typeof import('./scan.routes').registerScanRoutes;

beforeAll(async () => {
  ({ registerScanRoutes } = await import('./scan.routes'));
});

afterEach(() => {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.USE_AES_ENCRYPTION;
  delete process.env.SCAN_DEVICE_TOKEN;
  delete process.env.SESSION_SECRET;
  delete process.env.SESSION_SECURE;
  delete process.env.SCAN_UNLOCK_TOKEN_SECRET;
});

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  scanState.currentDateKey = '2026/03/12';
  scanState.currentTime = '08:30';
  scanState.currentTimestamp = '2026-03-12T00:30:00.000Z';
  scanState.holidays = [];
  scanState.attendanceRecords = [];
  scanState.nextAttendanceId = 1;
  scanState.employees = [
    {
      id: 5,
      name: '測試員工',
      idNumber: 'A123456789',
      isEncrypted: false,
      department: '生產部',
      position: null,
      email: null,
      phone: null,
      active: true,
      specialLeaveDays: 0,
      specialLeaveWorkDateRange: null,
      specialLeaveUsedDates: [],
      specialLeaveCashDays: 0,
      specialLeaveCashMonth: null,
      specialLeaveNotes: null,
      createdAt: new Date('2026-03-01T00:00:00.000Z')
    }
  ];
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('scan routes integration', () => {
  it('creates a clock-in then clock-out flow for a basic employee scan', async () => {
    const server = await createJsonTestServer(registerScanRoutes);

    try {
      const firstScan = await jsonRequest<{
        success: boolean;
        isClockIn: boolean;
        action: string;
        employeeName: string;
        clockTime: string;
      }>(server.baseUrl, '/api/barcode-scan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          idNumber: 'A123456789'
        })
      });

      expect(firstScan.response.status).toBe(200);
      expect(firstScan.body).toMatchObject({
        success: true,
        isClockIn: true,
        action: 'clock-in',
        employeeName: '測試員工',
        clockTime: '08:30'
      });
      expect(storageMock.getAllEmployees).not.toHaveBeenCalled();
      expect(scanState.attendanceRecords).toHaveLength(1);
      expect(scanState.attendanceRecords[0]).toMatchObject({
        employeeId: 5,
        date: '2026/03/12',
        clockIn: '08:30',
        clockOut: ''
      });

      scanState.currentTime = '17:45';
      scanState.currentTimestamp = '2026-03-12T09:45:00.000Z';

      const secondScan = await jsonRequest<{
        success: boolean;
        isClockIn: boolean;
        action: string;
        clockTime: string;
      }>(server.baseUrl, '/api/barcode-scan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          idNumber: 'A123456789'
        })
      });

      expect(secondScan.response.status).toBe(200);
      expect(secondScan.body).toMatchObject({
        success: true,
        isClockIn: false,
        action: 'clock-out',
        clockTime: '17:45'
      });
      expect(scanState.attendanceRecords[0]).toMatchObject({
        employeeId: 5,
        clockIn: '08:30',
        clockOut: '17:45'
      });
    } finally {
      await server.close();
    }
  });

  it('issues an admin-signed unlock token and unlocks browser barcode scans in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'test-session-secret-1234567890123456';
    process.env.SESSION_SECURE = 'false';
    process.env.SCAN_UNLOCK_TOKEN_SECRET = 'test-scan-unlock-token-secret-1234567890';
    const kioskChallenge = 'browser-kiosk-challenge';

    const server = await createJsonTestServer(registerScanRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const locked = await jsonRequest<{ code: string }>(server.baseUrl, '/api/barcode-scan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          idNumber: 'A123456789'
        })
      });

      expect(locked.response.status).toBe(401);
      expect(locked.response.headers.get('x-scan-session-required')).toBe('true');
      expect(locked.body?.code).toBe('SCAN_SESSION_REQUIRED');

      const tokenResult = await jsonRequest<{ success: boolean; token: string; expiresAt: string }>(
        server.baseUrl,
        '/api/scan/session/token',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [TEST_ADMIN_HEADER]: 'true'
          }
          ,
          body: JSON.stringify({
            kioskChallenge
          })
        }
      );

      expect(tokenResult.response.status).toBe(200);
      expect(tokenResult.body?.success).toBe(true);
      expect(tokenResult.body?.token).toEqual(expect.any(String));

      const unlockResult = await jsonRequest<{
        success: boolean;
        required: boolean;
        unlocked: boolean;
        authMode: string;
      }>(server.baseUrl, '/api/scan/session/unlock', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          token: tokenResult.body!.token,
          kioskChallenge
        })
      });

      expect(unlockResult.response.status).toBe(200);
      expect(unlockResult.body).toMatchObject({
        success: true,
        required: true,
        unlocked: true,
        authMode: 'scan_session'
      });

      const setCookie = unlockResult.response.headers.get('set-cookie') || '';
      const sessionCookie = setCookie.split(';')[0];

      const unlocked = await jsonRequest<{ success: boolean }>(server.baseUrl, '/api/barcode-scan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: sessionCookie
        },
        body: JSON.stringify({
          idNumber: 'A123456789'
        })
      });

      expect(unlocked.response.status).toBe(200);
      expect(unlocked.body?.success).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('rejects scan unlock attempts when the kiosk challenge does not match the signed token', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'test-session-secret-1234567890123456';
    process.env.SESSION_SECURE = 'false';
    process.env.SCAN_UNLOCK_TOKEN_SECRET = 'test-scan-unlock-token-secret-1234567890';

    const server = await createJsonTestServer(registerScanRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const tokenResult = await jsonRequest<{ success: boolean; token: string }>(
        server.baseUrl,
        '/api/scan/session/token',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [TEST_ADMIN_HEADER]: 'true'
          },
          body: JSON.stringify({
            kioskChallenge: 'browser-kiosk-challenge'
          })
        }
      );

      expect(tokenResult.response.status).toBe(200);

      const unlockResult = await jsonRequest<{ success: boolean; code: string }>(
        server.baseUrl,
        '/api/scan/session/unlock',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            token: tokenResult.body!.token,
            kioskChallenge: 'different-kiosk-challenge'
          })
        }
      );

      expect(unlockResult.response.status).toBe(401);
      expect(unlockResult.body).toMatchObject({
        success: false,
        code: 'INVALID_SCAN_UNLOCK_TOKEN'
      });
    } finally {
      await server.close();
    }
  });

  it('treats an authenticated admin session as sufficient browser scan access in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'test-session-secret-1234567890123456';
    process.env.SESSION_SECURE = 'false';

    const server = await createJsonTestServer(registerScanRoutes, {
      setupApp: async (app) => {
        setupTestAdminSession(app);
      }
    });

    try {
      const sessionResult = await jsonRequest<{
        required: boolean;
        unlocked: boolean;
        authMode: string;
      }>(server.baseUrl, '/api/scan/session', {
        headers: {
          [TEST_ADMIN_HEADER]: 'true'
        }
      });

      expect(sessionResult.response.status).toBe(200);
      expect(sessionResult.body).toMatchObject({
        required: true,
        unlocked: true,
        authMode: 'admin_session'
      });

      const scanResult = await jsonRequest<{ success: boolean }>(server.baseUrl, '/api/barcode-scan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TEST_ADMIN_HEADER]: 'true'
        },
        body: JSON.stringify({
          idNumber: 'A123456789'
        })
      });

      expect(scanResult.response.status).toBe(200);
      expect(scanResult.body).toMatchObject({
        success: true
      });
    } finally {
      await server.close();
    }
  });

  it('rebuilds the last scan result from persisted attendance after in-memory cache is lost', async () => {
    scanState.attendanceRecords = [
      {
        id: 10,
        employeeId: 5,
        date: '2026-03-12',
        clockIn: '08:30',
        clockOut: '17:30',
        isHoliday: false,
        isBarcodeScanned: true,
        holidayId: null,
        holidayType: null,
        createdAt: new Date('2026-03-12T00:30:00.000Z')
      }
    ];

    const server = await createJsonTestServer(registerScanRoutes);

    try {
      const result = await jsonRequest<{
        employeeName: string;
        action: string;
        isClockIn: boolean;
        clockTime: string;
      }>(server.baseUrl, '/api/last-scan-result');

      expect(result.response.status).toBe(200);
      expect(result.body).toMatchObject({
        employeeName: '測試員工',
        action: 'clock-out',
        isClockIn: false,
        clockTime: '17:30'
      });
    } finally {
      await server.close();
    }
  });

  it('rejects inactive employees on browser barcode scans without writing attendance', async () => {
    scanState.employees = [
      {
        ...scanState.employees[0],
        active: false
      }
    ];

    const server = await createJsonTestServer(registerScanRoutes);

    try {
      const result = await jsonRequest<{
        success: boolean;
        code: string;
        message: string;
      }>(server.baseUrl, '/api/barcode-scan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          idNumber: 'A123456789'
        })
      });

      expect(result.response.status).toBe(403);
      expect(result.body).toMatchObject({
        success: false,
        code: 'EMPLOYEE_INACTIVE',
        message: 'Inactive employees cannot clock in with barcode scans.'
      });
      expect(scanState.attendanceRecords).toHaveLength(0);
      expect(storageMock.createTemporaryAttendance).not.toHaveBeenCalled();
      expect(storageMock.updateTemporaryAttendance).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('returns a compact raspberry payload while reusing the same scan pipeline', async () => {
    const server = await createJsonTestServer(registerScanRoutes);

    try {
      const result = await jsonRequest<{
        success: boolean;
        code: string;
        action: string;
        name: string;
        time: string;
      }>(server.baseUrl, '/api/raspberry-scan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          idNumber: 'A123456789',
          deviceId: 'raspi-01'
        })
      });

      expect(result.response.status).toBe(200);
      expect(result.body).toMatchObject({
        success: true,
        code: 'SUCCESS',
        action: 'clock-in',
        name: '測試員工',
        time: '08:30'
      });
    } finally {
      await server.close();
    }
  });

  it('rejects inactive employees on Raspberry Pi scans without writing attendance', async () => {
    scanState.employees = [
      {
        ...scanState.employees[0],
        active: false
      }
    ];

    const server = await createJsonTestServer(registerScanRoutes);

    try {
      const result = await jsonRequest<{
        success: boolean;
        code: string;
        message: string;
      }>(server.baseUrl, '/api/raspberry-scan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          idNumber: 'A123456789',
          deviceId: 'raspi-01'
        })
      });

      expect(result.response.status).toBe(403);
      expect(result.body).toMatchObject({
        success: false,
        code: 'EMPLOYEE_INACTIVE',
        message: 'Inactive employees cannot clock in with barcode scans.'
      });
      expect(scanState.attendanceRecords).toHaveLength(0);
      expect(storageMock.createTemporaryAttendance).not.toHaveBeenCalled();
      expect(storageMock.updateTemporaryAttendance).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it('requires a device token for Raspberry Pi scans in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SCAN_DEVICE_TOKEN = 'scan-device-token-12345678901234567890';

    const server = await createJsonTestServer(registerScanRoutes);

    try {
      const unauthorized = await jsonRequest<{ code: string }>(server.baseUrl, '/api/raspberry-scan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          idNumber: 'A123456789',
          deviceId: 'raspi-01'
        })
      });

      expect(unauthorized.response.status).toBe(401);
      expect(unauthorized.response.headers.get('x-scan-device-token-required')).toBe('true');
      expect(unauthorized.body?.code).toBe('SCAN_DEVICE_TOKEN_REQUIRED');

      const authorized = await jsonRequest<{ success: boolean }>(server.baseUrl, '/api/raspberry-scan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-scan-device-token': process.env.SCAN_DEVICE_TOKEN
        },
        body: JSON.stringify({
          idNumber: 'A123456789',
          deviceId: 'raspi-01'
        })
      });

      expect(authorized.response.status).toBe(200);
      expect(authorized.body?.success).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('supports plaintext scans for AES-encrypted employee ids without route-level full scans', async () => {
    process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';
    scanState.employees = [
      {
        ...scanState.employees[0],
        idNumber: encryptAes('A123456789'),
        isEncrypted: true
      }
    ];

    const server = await createJsonTestServer(registerScanRoutes);

    try {
      const result = await jsonRequest<{
        success: boolean;
        employeeName: string;
        action: string;
      }>(server.baseUrl, '/api/barcode-scan', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          idNumber: 'A123456789'
        })
      });

      expect(result.response.status).toBe(200);
      expect(result.body).toMatchObject({
        success: true,
        employeeName: '測試員工',
        action: 'clock-in'
      });
      expect(storageMock.getAllEmployees).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
