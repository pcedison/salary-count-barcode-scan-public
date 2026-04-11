/**
 * Real database integration tests — connects to the actual PostgreSQL instance.
 *
 * Covers:
 *   1. PostgreSQL connection verification (SELECT 1 + health endpoint)
 *   2. Employee CRUD against real DB
 *   3. Barcode scan clock-in / clock-out full HTTP flow
 *   4. Raspberry Pi scan endpoint
 *   5. Attendance lifecycle
 *   6. Holiday CRUD
 *   7. Settings read
 *   8. Salary records read
 *
 * Run:  npm run test:real-db
 *
 * Test data uses unique prefixes and is cleaned up in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';

import type { Employee, TemporaryAttendance } from '@shared/schema';
import { decrypt as decryptAes, isAESEncrypted } from '@shared/utils/encryption';

import { storage } from './storage';
import { db } from './db';
import { registerScanRoutes } from './routes/scan.routes';
import { getTaiwanDateTimeParts } from './routes/scan-helpers';
import { registerHealthRoutes } from './routes/health.routes';
import { registerSettingsRoutes } from './routes/settings.routes';
import { registerEmployeeRoutes } from './routes/employees.routes';
import { TEST_ADMIN_HEADER, setupTestAdminSession } from './test-utils/admin-test-session';

// ── helpers ──────────────────────────────────────────────

const TEST_PREFIX = `__test_${Date.now()}`;
const TEST_AES_KEY = '12345678901234567890123456789012';
const TEST_ID_SEED = Number(String(Date.now()).slice(-8));

const trackedEmployeeIds: number[] = [];
const trackedAttendanceIds: number[] = [];
const trackedHolidayIds: number[] = [];

function buildTestTaiwanStyleId(offset: number): string {
  return `A${String(TEST_ID_SEED + offset).padStart(9, '0').slice(-9)}`;
}

function enableAesWriteEnv(): () => void {
  const previousKey = process.env.ENCRYPTION_KEY;
  const previousFlag = process.env.USE_AES_ENCRYPTION;

  process.env.ENCRYPTION_KEY = TEST_AES_KEY;
  process.env.USE_AES_ENCRYPTION = 'true';

  return () => {
    if (previousKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = previousKey;
    }

    if (previousFlag === undefined) {
      delete process.env.USE_AES_ENCRYPTION;
    } else {
      process.env.USE_AES_ENCRYPTION = previousFlag;
    }
  };
}

async function cleanup() {
  // Delete attendance records first (FK → employees)
  for (const id of trackedAttendanceIds) {
    try { await storage.deleteTemporaryAttendance(id); } catch { /* ignore */ }
  }
  for (const id of trackedHolidayIds) {
    try { await storage.deleteHoliday(id); } catch { /* ignore */ }
  }
  // Clean up any attendance records left by scan tests
  for (const empId of trackedEmployeeIds) {
    try { await storage.deleteTemporaryAttendanceByEmployeeId(empId); } catch { /* ignore */ }
  }
  for (const id of trackedEmployeeIds) {
    try { await storage.deleteEmployee(id); } catch { /* ignore */ }
  }
}

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function createRealDbTestServer(): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  setupTestAdminSession(app);
  registerHealthRoutes(app);
  registerScanRoutes(app);
  registerSettingsRoutes(app);
  registerEmployeeRoutes(app);

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Unable to get server address');

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    })
  };
}

// ── setup / teardown ─────────────────────────────────────

beforeAll(() => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for real DB tests — set it in .env');
  }
});

afterAll(async () => {
  await cleanup();
});

// ══════════════════════════════════════════════════════════
// 1. PostgreSQL connection verification
// ══════════════════════════════════════════════════════════

describe('real database — PostgreSQL connection', () => {
  it('executes SELECT 1 on the PostgreSQL connection pool', async () => {
    const result = await db.execute('SELECT 1 AS ok');
    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns healthy status from /api/health against the real DB', async () => {
    const server = await createRealDbTestServer();
    try {
      const res = await fetch(`${server.baseUrl}/api/health`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe('healthy');
      expect(body.checks.database.status).toBe('pass');
      expect(body.checks.database.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(body.checks.memory.status).toBe('pass');
    } finally {
      await server.close();
    }
  });

  it('returns ready from /ready', async () => {
    const server = await createRealDbTestServer();
    try {
      const res = await fetch(`${server.baseUrl}/ready`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ready).toBe(true);
      expect(body.checks.database.status).toBe('pass');
    } finally {
      await server.close();
    }
  });

  it('returns alive from /live', async () => {
    const server = await createRealDbTestServer();
    try {
      const res = await fetch(`${server.baseUrl}/live`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.alive).toBe(true);
    } finally {
      await server.close();
    }
  });
});

// ══════════════════════════════════════════════════════════
// 2. Employee CRUD
// ══════════════════════════════════════════════════════════

describe('real database — employee CRUD', () => {
  let testEmployee: Employee;

  it('creates an employee', async () => {
    testEmployee = await storage.createEmployee({
      name: `${TEST_PREFIX}_員工`,
      idNumber: `${TEST_PREFIX}_ID`,
      position: '測試職位',
      department: '測試部門',
      email: `${TEST_PREFIX}@test.local`,
      phone: '0900000000',
      active: true
    });
    trackedEmployeeIds.push(testEmployee.id);

    expect(testEmployee.id).toBeGreaterThan(0);
    expect(testEmployee.name).toBe(`${TEST_PREFIX}_員工`);
    expect(testEmployee.department).toBe('測試部門');
  });

  it('retrieves employee by id', async () => {
    const found = await storage.getEmployeeById(testEmployee.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe(testEmployee.name);
  });

  it('retrieves employee by idNumber', async () => {
    const found = await storage.getEmployeeByIdNumber(`${TEST_PREFIX}_ID`);
    expect(found).toBeDefined();
    expect(found!.id).toBe(testEmployee.id);
  });

  it('lists all employees (includes test employee)', async () => {
    const all = await storage.getAllEmployees();
    expect(all.length).toBeGreaterThan(0);
    expect(all.find(e => e.id === testEmployee.id)).toBeDefined();
  });

  it('updates an employee', async () => {
    const updated = await storage.updateEmployee(testEmployee.id, { position: '更新職位' });
    expect(updated).toBeDefined();
    expect(updated!.position).toBe('更新職位');
  });

  it('deletes an employee', async () => {
    const extra = await storage.createEmployee({
      name: `${TEST_PREFIX}_刪除測試`,
      idNumber: `${TEST_PREFIX}_DEL`,
      position: '臨時',
      department: '臨時',
      active: true
    });
    expect(await storage.deleteEmployee(extra.id)).toBe(true);
    expect(await storage.getEmployeeById(extra.id)).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════
// 2b. AES compatibility
// ══════════════════════════════════════════════════════════

describe('real database — AES compatibility', () => {
  const plaintextId = buildTestTaiwanStyleId(101);
  let aesEmployee: Employee;
  let server: TestServer;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = enableAesWriteEnv();

    aesEmployee = await storage.createEmployee({
      name: `${TEST_PREFIX}_AES員工`,
      idNumber: plaintextId,
      isEncrypted: true,
      position: 'AES測試',
      department: 'AES部門',
      active: true
    });
    trackedEmployeeIds.push(aesEmployee.id);

    server = await createRealDbTestServer();
  });

  afterAll(async () => {
    try {
      await storage.deleteTemporaryAttendanceByEmployeeId(aesEmployee.id);
    } catch {
      // ignore cleanup errors in test teardown
    }

    try {
      await storage.deleteEmployee(aesEmployee.id);
    } catch {
      // ignore cleanup errors in test teardown
    }

    const trackedIndex = trackedEmployeeIds.indexOf(aesEmployee.id);
    if (trackedIndex >= 0) {
      trackedEmployeeIds.splice(trackedIndex, 1);
    }

    restoreEnv();
    await server.close();
  });

  it('stores employee ids as AES ciphertext when AES writes are enabled', async () => {
    const stored = await storage.getEmployeeById(aesEmployee.id);

    expect(stored).toBeDefined();
    expect(stored!.isEncrypted).toBe(true);
    expect(stored!.idNumber).not.toBe(plaintextId);
    expect(isAESEncrypted(stored!.idNumber)).toBe(true);
    expect(decryptAes(stored!.idNumber)).toBe(plaintextId);
  });

  it('retrieves AES employees by plaintext and stored ciphertext', async () => {
    const stored = await storage.getEmployeeById(aesEmployee.id);
    const byPlaintext = await storage.getEmployeeByIdNumber(plaintextId);
    const byStoredCiphertext = await storage.getEmployeeByIdNumber(stored!.idNumber);

    expect(byPlaintext?.id).toBe(aesEmployee.id);
    expect(byStoredCiphertext?.id).toBe(aesEmployee.id);
  });

  it('preserves stored AES ciphertext when updating non-identity fields', async () => {
    const beforeUpdate = await storage.getEmployeeById(aesEmployee.id);
    const updated = await storage.updateEmployee(aesEmployee.id, {
      department: 'AES更新部門'
    });
    const afterUpdate = await storage.getEmployeeById(aesEmployee.id);

    expect(updated).toBeDefined();
    expect(updated!.department).toBe('AES更新部門');
    expect(afterUpdate!.idNumber).toBe(beforeUpdate!.idNumber);
    expect(decryptAes(afterUpdate!.idNumber)).toBe(plaintextId);
  });

  it('returns display ids and scan ids for AES employees from admin routes', async () => {
    const adminListResponse = await fetch(`${server.baseUrl}/api/employees/admin`, {
      headers: {
        [TEST_ADMIN_HEADER]: 'true'
      }
    });

    expect(adminListResponse.status).toBe(200);
    const adminList = await adminListResponse.json();
    const adminListEmployee = adminList.find((employee: { id: number }) => employee.id === aesEmployee.id);

    expect(adminListEmployee).toMatchObject({
      id: aesEmployee.id,
      idNumber: plaintextId,
      scanIdNumber: plaintextId,
      isEncrypted: true
    });

    const singleEmployeeResponse = await fetch(`${server.baseUrl}/api/employees/${aesEmployee.id}`, {
      headers: {
        [TEST_ADMIN_HEADER]: 'true'
      }
    });

    expect(singleEmployeeResponse.status).toBe(200);
    const singleEmployee = await singleEmployeeResponse.json();

    expect(singleEmployee).toMatchObject({
      id: aesEmployee.id,
      idNumber: plaintextId,
      scanIdNumber: plaintextId,
      isEncrypted: true
    });

    const publicEmployeeResponse = await fetch(`${server.baseUrl}/api/employees`);
    const publicEmployees = await publicEmployeeResponse.json();
    const publicEmployee = publicEmployees.find((employee: { id: number }) => employee.id === aesEmployee.id);

    expect(publicEmployee).toMatchObject({
      id: aesEmployee.id,
      name: `${TEST_PREFIX}_AES員工`
    });
    expect(publicEmployee).not.toHaveProperty('idNumber');
    expect(publicEmployee).not.toHaveProperty('specialLeaveUsedDates');
  });

  it('supports plaintext clock flows for AES-encrypted employees', async () => {
    const firstScanResponse = await fetch(`${server.baseUrl}/api/barcode-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idNumber: plaintextId })
    });

    expect(firstScanResponse.status).toBe(200);
    const firstScan = await firstScanResponse.json();

    expect(firstScan.success).toBe(true);
    expect(firstScan.action).toBe('clock-in');
    expect(firstScan.employeeName).toBe(`${TEST_PREFIX}_AES員工`);

    if (firstScan.attendance?.id) {
      trackedAttendanceIds.push(firstScan.attendance.id);
    }

    const secondScanResponse = await fetch(`${server.baseUrl}/api/barcode-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idNumber: plaintextId })
    });

    expect(secondScanResponse.status).toBe(200);
    const secondScan = await secondScanResponse.json();

    expect(secondScan.success).toBe(true);
    expect(secondScan.action).toBe('clock-out');
    expect(secondScan.employeeName).toBe(`${TEST_PREFIX}_AES員工`);
    expect(secondScan.attendance?.clockOut).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════
// 3. Barcode scan — full HTTP flow against the real PostgreSQL-backed app
// ══════════════════════════════════════════════════════════

describe('real database — barcode scan attendance flow', () => {
  let scanEmployee: Employee;
  let server: TestServer;

  beforeAll(async () => {
    // Create a dedicated employee for scan tests
    scanEmployee = await storage.createEmployee({
      name: `${TEST_PREFIX}_掃描員工`,
      idNumber: `${TEST_PREFIX}_SCAN`,
      position: '掃描測試',
      department: '掃描部門',
      active: true
    });
    trackedEmployeeIds.push(scanEmployee.id);

    server = await createRealDbTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('rejects scan with missing idNumber', async () => {
    const res = await fetch(`${server.baseUrl}/api/barcode-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('rejects scan with unknown idNumber', async () => {
    const res = await fetch(`${server.baseUrl}/api/barcode-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idNumber: 'NONEXISTENT_999' })
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('EMPLOYEE_NOT_FOUND');
  });

  it('first scan creates a clock-in record', async () => {
    const res = await fetch(`${server.baseUrl}/api/barcode-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idNumber: `${TEST_PREFIX}_SCAN` })
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.action).toBe('clock-in');
    expect(body.isClockIn).toBe(true);
    expect(body.employeeName).toBe(`${TEST_PREFIX}_掃描員工`);
    expect(body.department).toBe('掃描部門');
    expect(body.attendance).toBeDefined();
    expect(body.attendance.clockIn).toBeTruthy();
    expect(body.attendance.employeeId).toBe(scanEmployee.id);

    // Track for cleanup
    if (body.attendance?.id) {
      trackedAttendanceIds.push(body.attendance.id);
    }
  });

  it('second scan creates a clock-out on the same record', async () => {
    const res = await fetch(`${server.baseUrl}/api/barcode-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idNumber: `${TEST_PREFIX}_SCAN` })
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.action).toBe('clock-out');
    expect(body.isClockIn).toBe(false);
    expect(body.attendance.clockOut).toBeTruthy();
  });

  it('/api/last-scan-result returns the latest scan', async () => {
    const res = await fetch(`${server.baseUrl}/api/last-scan-result`);

    // Could be 200 or 404 depending on whether today matches test date
    // If 200, verify structure
    if (res.status === 200) {
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.employeeName).toBeDefined();
      expect(body.attendance).toBeDefined();
    } else {
      expect(res.status).toBe(404);
    }
  });

  it('third scan opens a new clock-in shift', async () => {
    const res = await fetch(`${server.baseUrl}/api/barcode-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idNumber: `${TEST_PREFIX}_SCAN` })
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.action).toBe('clock-in');
    expect(body.isClockIn).toBe(true);

    if (body.attendance?.id) {
      trackedAttendanceIds.push(body.attendance.id);
    }
  });

  it('verifies attendance records were persisted in the real DB', async () => {
    const records = await storage.getTemporaryAttendanceByEmployeeAndDate(
      scanEmployee.id,
      getTaiwanDateTimeParts().dateKey
    );

    // We did at least 3 scans on the same employee today, should have records
    expect(records.length).toBeGreaterThan(0);

    const hasClockIn = records.some(r => r.clockIn && r.clockIn !== '');
    expect(hasClockIn).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// 4. Raspberry Pi scan endpoint
// ══════════════════════════════════════════════════════════

describe('real database — Raspberry Pi scan endpoint', () => {
  let piEmployee: Employee;
  let server: TestServer;

  beforeAll(async () => {
    piEmployee = await storage.createEmployee({
      name: `${TEST_PREFIX}_樹莓派員工`,
      idNumber: `${TEST_PREFIX}_RPI`,
      position: '樹莓派測試',
      department: 'IoT部門',
      active: true
    });
    trackedEmployeeIds.push(piEmployee.id);

    server = await createRealDbTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('processes a Raspberry Pi scan and returns simplified response', async () => {
    const res = await fetch(`${server.baseUrl}/api/raspberry-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idNumber: `${TEST_PREFIX}_RPI`,
        deviceId: 'test-device-001'
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.code).toBe('SUCCESS');
    expect(body.action).toBe('clock-in');
    expect(body.name).toBe(`${TEST_PREFIX}_樹莓派員工`);
    expect(body.department).toBe('IoT部門');
    expect(body.time).toBeTruthy();
    expect(typeof body.isHoliday).toBe('boolean');
  });

  it('second Raspberry Pi scan records clock-out', async () => {
    const res = await fetch(`${server.baseUrl}/api/raspberry-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idNumber: `${TEST_PREFIX}_RPI`,
        deviceId: 'test-device-001'
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.action).toBe('clock-out');
  });

  it('rejects missing ID from Raspberry Pi', async () => {
    const res = await fetch(`${server.baseUrl}/api/raspberry-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'test-device-001' })
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('MISSING_ID');
  });
});

// ══════════════════════════════════════════════════════════
// 5. Storage-level attendance lifecycle
// ══════════════════════════════════════════════════════════

describe('real database — attendance lifecycle', () => {
  let attendanceEmployee: Employee;
  let testAttendance: TemporaryAttendance;

  beforeAll(async () => {
    attendanceEmployee = await storage.createEmployee({
      name: `${TEST_PREFIX}_考勤員工`,
      idNumber: `${TEST_PREFIX}_ATT`,
      position: '考勤測試',
      department: '測試部門',
      active: true
    });
    trackedEmployeeIds.push(attendanceEmployee.id);
  });

  it('creates a clock-in record', async () => {
    testAttendance = await storage.createTemporaryAttendance({
      employeeId: attendanceEmployee.id,
      date: '2099/01/01',
      clockIn: '08:30',
      clockOut: '',
      isHoliday: false,
      isBarcodeScanned: true
    });
    trackedAttendanceIds.push(testAttendance.id);

    expect(testAttendance.id).toBeGreaterThan(0);
    expect(testAttendance.clockIn).toBe('08:30');
    expect(testAttendance.clockOut).toBe('');
  });

  it('updates with clock-out', async () => {
    const updated = await storage.updateTemporaryAttendance(testAttendance.id, { clockOut: '17:30' });
    expect(updated).toBeDefined();
    expect(updated!.clockOut).toBe('17:30');
  });

  it('retrieves by employee and date', async () => {
    const records = await storage.getTemporaryAttendanceByEmployeeAndDate(
      attendanceEmployee.id,
      '2099/01/01'
    );
    expect(records.length).toBeGreaterThan(0);
    const match = records.find(r => r.id === testAttendance.id);
    expect(match).toBeDefined();
    expect(match!.clockOut).toBe('17:30');
  });

  it('appears in full attendance list', async () => {
    const all = await storage.getTemporaryAttendance();
    expect(all.length).toBeGreaterThan(0);
  });

  it('deletes an attendance record', async () => {
    expect(await storage.deleteTemporaryAttendance(testAttendance.id)).toBe(true);
    trackedAttendanceIds.splice(trackedAttendanceIds.indexOf(testAttendance.id), 1);
    expect(await storage.getTemporaryAttendanceById(testAttendance.id)).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════
// 6. Holiday CRUD
// ══════════════════════════════════════════════════════════

describe('real database — holidays', () => {
  it('creates and retrieves a holiday', async () => {
    const holiday = await storage.createHoliday({
      date: '2099/12/25',
      name: `${TEST_PREFIX}_聖誕節`,
      holidayType: 'national'
    });
    trackedHolidayIds.push(holiday.id);

    expect(holiday.id).toBeGreaterThan(0);
    const all = await storage.getAllHolidays();
    expect(all.find(h => h.id === holiday.id)).toBeDefined();
  });

  it('deletes a holiday', async () => {
    const holiday = await storage.createHoliday({
      date: '2099/12/31',
      name: `${TEST_PREFIX}_跨年`,
      holidayType: 'national'
    });
    expect(await storage.deleteHoliday(holiday.id)).toBe(true);
    expect(await storage.getHolidayById(holiday.id)).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════
// 7. Settings
// ══════════════════════════════════════════════════════════

describe('real database — settings', () => {
  it('reads current settings from the real DB', async () => {
    const s = await storage.getSettings();
    if (s) {
      expect(s.baseHourlyRate).toBeGreaterThan(0);
      expect(s.adminPin).toBeDefined();
      // Admin PIN should be hashed (> 100 chars)
      expect(s.adminPin.length).toBeGreaterThan(100);
    }
  });

  it('GET /api/settings returns settings without exposing adminPin', async () => {
    const server = await createRealDbTestServer();
    try {
      const res = await fetch(`${server.baseUrl}/api/settings`);
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.baseHourlyRate).toBeGreaterThan(0);
      expect(body.adminPin).toBeUndefined();
      expect(body.baseMonthSalary).toBeDefined();
    } finally {
      await server.close();
    }
  });
});

// ══════════════════════════════════════════════════════════
// 8. Salary records
// ══════════════════════════════════════════════════════════

describe('real database — salary records', () => {
  it('lists salary records without error', async () => {
    const records = await storage.getAllSalaryRecords();
    expect(Array.isArray(records)).toBe(true);
  });

  it('looks up salary record by year/month', async () => {
    const record = await storage.getSalaryRecordByYearMonth(2099, 1);
    expect(record === undefined || typeof record.id === 'number').toBe(true);
  });
});
