import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SalaryCorrection, SalaryRecord } from '@shared/schema';
import type { PayrollCorrectionPreview } from '@shared/payrollCorrection';
import type { SalaryCorrectionCommit, SalaryListFilters } from '../storage';
import { createJsonTestServer, jsonRequest } from '../test-utils/http-test-server';
import { TEST_ADMIN_HEADER, setupTestAdminSession } from '../test-utils/admin-test-session';
import { PayrollCorrectionError } from '../services/payrollCorrection';
import { createSalaryPrintToken } from '../services/salaryPrintToken';

const salaryState = vi.hoisted(() => ({
  records: [] as SalaryRecord[],
  corrections: [] as SalaryCorrection[],
  lock: Promise.resolve(),
  settings: {
    id: 1, baseHourlyRate: 119, ot1Multiplier: 1.34, ot2Multiplier: 1.67,
    baseMonthSalary: 28590, welfareAllowance: 500, deductions: [], allowances: [], adminPin: 'synthetic-test-pin',
  },
}));

const salaryCalculatorMock = vi.hoisted(() => ({
  calculateSalary: vi.fn(() => ({
    totalOT1Hours: 4, totalOT2Hours: 2, totalOvertimePay: 1666, grossSalary: 33256, netSalary: 32856,
  })),
  calculateHolidayPayAdjustments: vi.fn(() => ({
    sickLeaveDays: 1, sickLeaveDeduction: 300, personalLeaveDays: 0, personalLeaveDeduction: 0,
    typhoonLeaveDays: 0, typhoonLeaveDeduction: 0, workedHolidayDays: 1, workedHolidayPay: 200,
    deductionItems: [{ name: 'Synthetic calculated leave deduction', amount: 300 }],
  })),
  calculateOvertimePay: vi.fn(() => 1234),
}));

const storageMock = vi.hoisted(() => ({
  getAllSalaryRecords: vi.fn(async () => salaryState.records),
  getAllSalaryRecordsPage: vi.fn(async (page: number, limit: number, filters: SalaryListFilters) => {
    const filtered = salaryState.records.filter((record) =>
      (!filters.year || record.salaryYear === filters.year) &&
      (!filters.employeeId || record.employeeId === filters.employeeId) &&
      (!filters.search || record.employeeName?.includes(filters.search)),
    );
    return { rows: filtered.slice((page - 1) * limit, page * limit), total: filtered.length };
  }),
  getFinalizedSalaryMonths: vi.fn(async () => salaryState.records.map(({ employeeId, salaryYear, salaryMonth }) =>
    ({ employeeId, salaryYear, salaryMonth }))),
  getSalaryRecordsByIds: vi.fn(async (ids: number[]) => salaryState.records.filter((record) => ids.includes(record.id))),
  getSalaryRecordById: vi.fn(async (id: number) => salaryState.records.find((record) => record.id === id)),
  getSalaryCorrections: vi.fn(async (id: number) => salaryState.corrections.filter((record) => record.originalRecordId === id)),
  getSettings: vi.fn(async () => salaryState.settings),
  getTemporaryAttendance: vi.fn(async () => []),
  getTemporaryAttendanceByEmployeeAndMonth: vi.fn(async () => []),
  createSalaryRecord: vi.fn(async (values) => {
    const record = { ...values, id: 8, revision: 0 };
    salaryState.records.push(record);
    return record;
  }),
  updateSalaryRecord: vi.fn(),
  commitSalaryCorrection: vi.fn(async (
    id: number, commit: SalaryCorrectionCommit, build: (record: SalaryRecord) => PayrollCorrectionPreview,
  ) => {
    const previousLock = salaryState.lock;
    let unlock!: () => void;
    salaryState.lock = new Promise<void>((resolve) => { unlock = resolve; });
    await previousLock;
    try {
      const index = salaryState.records.findIndex((record) => record.id === id);
      if (index === -1) throw new PayrollCorrectionError(404, 'NOT_FOUND', 'Salary record not found.');
      const current = salaryState.records[index];
      const prior = salaryState.corrections.find((record) =>
        record.originalRecordId === id && record.idempotencyKey === commit.idempotencyKey);
      if (prior) {
        if (prior.requestHash !== commit.requestHash || prior.previewTokenHash !== commit.previewTokenHash || prior.actorId !== commit.actorId) {
          throw new PayrollCorrectionError(409, 'IDEMPOTENCY_CONFLICT', 'This request key belongs to a different correction.');
        }
        return { record: current, correction: prior, replayed: true };
      }
      const preview = build(current);
      const record = { ...structuredClone(preview.after), revision: current.revision + 1 };
      const correction: SalaryCorrection = {
        id: salaryState.corrections.length + 1, salaryRecordId: id, originalRecordId: id,
        revision: record.revision, ...commit, reason: preview.reason, paymentHandling: preview.paymentHandling,
        holidays: preview.holidays, delta: preview.delta, beforeSnapshot: structuredClone(current),
        afterSnapshot: structuredClone(record), createdAt: new Date(),
      };
      salaryState.records[index] = record;
      salaryState.corrections.push(correction);
      return { record, correction, replayed: false };
    } finally { unlock(); }
  }),
}));

vi.mock('../repositories/salaryRepository', () => ({ salaryRepository: storageMock }));
vi.mock('../storage', () => ({ storage: storageMock }));
vi.mock('../utils/salaryCalculator', () => salaryCalculatorMock);

let registerSalaryRoutes: typeof import('./salary.routes').registerSalaryRoutes;

function salary(id = 7): SalaryRecord {
  return {
    id, revision: 0, salaryYear: 2026, salaryMonth: 3, employeeId: id === 7 ? 5 : 6,
    employeeName: 'Synthetic employee', baseSalary: 30000, holidayCalculationBaseSalary: 30000, housingAllowance: 0, welfareAllowance: 500,
    allowances: [{ name: 'Synthetic welfare', amount: 500 }], totalOT1Hours: 2, totalOT2Hours: 1,
    totalOvertimePay: 800, holidayDays: 0, holidayDailySalary: 0, totalHolidayPay: 0,
    grossSalary: 31300, deductions: [], totalDeductions: 0, netSalary: 31300, attendanceData: [],
    specialLeaveInfo: null, anonymizedAt: null, retentionUntil: null, employeeSnapshot: null,
    createdAt: new Date('2026-03-12T00:00:00.000Z'),
  };
}

function manualRequest() {
  return {
    revision: 0, reason: 'Correct synthetic manual inputs', paymentHandling: 'unpaid' as const,
    idempotencyKey: randomUUID(), baseSalary: 31000,
    allowances: [{ name: 'Synthetic welfare', amount: 500 }],
    deductions: [{ name: 'Synthetic manual deduction', amount: 100 }],
  };
}

async function testServer() {
  return createJsonTestServer(registerSalaryRoutes, { setupApp: (app) => setupTestAdminSession(app) });
}

beforeAll(async () => { ({ registerSalaryRoutes } = await import('./salary.routes')); });
beforeEach(() => {
  salaryState.records = [salary()];
  salaryState.corrections = [];
  salaryState.lock = Promise.resolve();
  vi.clearAllMocks();
});

describe('salary routes integration', () => {
  it('captures server-derived daily hours for a new settlement and discards forged client hours', async () => {
    salaryState.records = [];
    salaryCalculatorMock.calculateSalary.mockReturnValueOnce({
      totalOT1Hours: 3, totalOT2Hours: 0.5, totalOvertimePay: 888, grossSalary: 30888, netSalary: 30888,
    });
    const server = await testServer();
    try {
      const attendanceData = ['17:00', '18:20'].map((clockOut, index) => ({
        id: index + 1, employeeId: 5, date: `2026-03-0${index + 2}`, clockIn: '08:00', clockOut,
        isHoliday: false, isBarcodeScanned: false, holidayType: null, holidayId: null, createdAt: null,
        overtimeHours: { ot1: 24, ot2: 24 },
      }));
      const result = await jsonRequest<SalaryRecord>(server.baseUrl, '/api/salary-records', {
        method: 'POST', headers: { [TEST_ADMIN_HEADER]: 'true', 'content-type': 'application/json' },
        body: JSON.stringify({ ...salary(), attendanceData }),
      });
      expect(result.response.status).toBe(201);
      expect(result.body?.attendanceData?.map(row => row.overtimeHours)).toEqual([{ ot1: 1, ot2: 0 }, { ot1: 2, ot2: 0.5 }]);
      expect(result.body).toMatchObject({ totalOT1Hours: 3, totalOT2Hours: 0.5, totalOvertimePay: 888 });
      expect(result.body?.attendanceData?.map(row => row.date)).toEqual(attendanceData.map(row => row.date));
    } finally { await server.close(); }
  });
  it('saves the base actually used for a new settlement, rather than current settings or a client basis', async () => {
    salaryState.records = [];
    const server = await testServer();
    try {
      const draft = { ...salary(), holidayCalculationBaseSalary: 99999 };
      const result = await jsonRequest<SalaryRecord>(server.baseUrl, '/api/salary-records', {
        method: 'POST', headers: { [TEST_ADMIN_HEADER]: 'true', 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      expect(result.response.status).toBe(201);
      expect(result.body?.holidayCalculationBaseSalary).toBe(30000);
      expect(salaryCalculatorMock.calculateHolidayPayAdjustments).toHaveBeenCalledWith([], 30000);
      expect(storageMock.createSalaryRecord).toHaveBeenCalledWith(expect.objectContaining({
        baseSalary: 30000, holidayCalculationBaseSalary: 30000,
      }));
      expect(result.body?.holidayCalculationBaseSalary).not.toBe(salaryState.settings.baseMonthSalary);
    } finally { await server.close(); }
  });
  it('requires admin authorization for salary reads, finalized-month summaries and debug endpoints', async () => {
    const server = await testServer();
    try {
      for (const path of [
        '/api/salary-records', '/api/salary-records/finalized-months', '/api/salary-records/7',
        '/api/salary-records/7/pdf', '/api/test-salary-calculation',
      ]) {
        const result = await jsonRequest(server.baseUrl, path, { redirect: 'manual' });
        expect(result.response.status).toBe(401);
      }
      expect(storageMock.getAllSalaryRecordsPage).not.toHaveBeenCalled();
      expect(storageMock.getFinalizedSalaryMonths).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('returns salary data and print redirect for an authorized administrator', async () => {
    const server = await testServer();
    try {
      const headers = { [TEST_ADMIN_HEADER]: 'true' };
      const list = await jsonRequest<{
        data: SalaryRecord[]; pagination: { page: number; limit: number; total: number; pages: number };
      }>(server.baseUrl, '/api/salary-records', { headers });
      expect(list.response.status).toBe(200);
      expect(list.body).toEqual({
        data: [expect.objectContaining({ id: 7, employeeName: 'Synthetic employee', netSalary: 31300 })],
        pagination: { page: 1, limit: 50, total: 1, pages: 1 },
      });
      expect(storageMock.getAllSalaryRecordsPage).toHaveBeenCalledWith(
        1, 50, { year: undefined, employeeId: undefined, search: undefined },
      );
      expect(storageMock.getAllSalaryRecords).not.toHaveBeenCalled();
      const detail = await jsonRequest<SalaryRecord>(server.baseUrl, '/api/salary-records/7', { headers });
      expect(detail.response.status).toBe(200);
      expect(detail.body).toMatchObject({ id: 7, revision: 0, salaryYear: 2026, salaryMonth: 3 });
      const pdf = await jsonRequest(server.baseUrl, '/api/salary-records/7/pdf', { headers, redirect: 'manual' });
      expect(pdf.response.status).toBe(302);
      expect(pdf.response.headers.get('location')).toBe('/print-salary?id=7');
    } finally { await server.close(); }
  });

  it('validates server-side history filters and passes them to paginated storage queries', async () => {
    const server = await testServer();
    salaryState.records.push(salary(8));
    try {
      const headers = { [TEST_ADMIN_HEADER]: 'true' };
      const result = await jsonRequest<{ data: SalaryRecord[] }>(
        server.baseUrl, '/api/salary-records?page=1&limit=10&year=2026&employeeId=5&search=Synthetic', { headers },
      );
      expect(result.response.status).toBe(200);
      expect(result.body?.data.map((record) => record.id)).toEqual([7]);
      expect(storageMock.getAllSalaryRecordsPage).toHaveBeenCalledWith(
        1, 10, { salaryYear: 2026, salaryMonth: undefined, employeeId: 5, search: 'Synthetic' },
      );
      const invalid = await jsonRequest(server.baseUrl, '/api/salary-records?year=invalid&employeeId=-1', { headers });
      expect(invalid.response.status).toBe(400);
      expect(storageMock.getAllSalaryRecordsPage).toHaveBeenCalledTimes(1);
    } finally { await server.close(); }
  });

  it('returns complete finalized-month metadata without querying full payroll snapshots', async () => {
    const server = await testServer();
    salaryState.records.push({ ...salary(8), salaryYear: 2025, salaryMonth: 12 });
    try {
      const result = await jsonRequest(server.baseUrl, '/api/salary-records/finalized-months', {
        headers: { [TEST_ADMIN_HEADER]: 'true' },
      });
      expect(result.response.status).toBe(200);
      expect(result.body).toEqual({ data: [
        { employeeId: 5, salaryYear: 2026, salaryMonth: 3 },
        { employeeId: 6, salaryYear: 2025, salaryMonth: 12 },
      ] });
      expect(storageMock.getFinalizedSalaryMonths).toHaveBeenCalledOnce();
      expect(storageMock.getAllSalaryRecordsPage).not.toHaveBeenCalled();
      expect(storageMock.getSalaryRecordById).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('loads signed batch print records in one query and restores the requested ordering', async () => {
    const server = await testServer();
    salaryState.records.push(salary(8));
    try {
      const token = createSalaryPrintToken([8, 7]);
      const result = await jsonRequest<{ records: SalaryRecord[] }>(
        server.baseUrl, `/api/salary-records/print-batch?ids=8,7&token=${token}`,
      );
      expect(result.response.status).toBe(200);
      expect(result.body?.records.map((record) => record.id)).toEqual([8, 7]);
      expect(storageMock.getSalaryRecordsByIds).toHaveBeenCalledExactlyOnceWith([8, 7]);
      expect(storageMock.getSalaryRecordById).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('rejects missing or oversized print batches and invalid signatures before querying salary records', async () => {
    const server = await testServer();
    try {
      const ids = Array.from({ length: 101 }, (_, index) => index + 1);
      for (const path of [
        '/api/salary-records/print-batch',
        `/api/salary-records/print-batch?ids=${ids.join(',')}&token=${createSalaryPrintToken(ids)}`,
      ]) expect((await jsonRequest(server.baseUrl, path)).response.status).toBe(400);
      expect((await jsonRequest(server.baseUrl, '/api/salary-records/print-batch?ids=7&token=invalid')).response.status).toBe(401);
      expect(storageMock.getSalaryRecordsByIds).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('does not expose the salary calculation debug route in production mode', async () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    let server: Awaited<ReturnType<typeof createJsonTestServer>> | undefined;
    try {
      server = await createJsonTestServer(registerSalaryRoutes);
      expect((await jsonRequest(server.baseUrl, '/api/test-salary-calculation')).response.status).toBe(404);
    } finally {
      if (server) await server.close();
      process.env.NODE_ENV = previousEnv;
    }
  });

  it('rejects the old forced client-calculated salary override without writing anything', async () => {
    const server = await testServer();
    const original = structuredClone(salaryState.records[0]);
    try {
      const result = await jsonRequest<{ code: string }>(server.baseUrl, '/api/salary-records/7', {
        method: 'PATCH', headers: { [TEST_ADMIN_HEADER]: 'true', 'content-type': 'application/json', 'x-force-update': 'true' },
        body: JSON.stringify({ baseSalary: 31000, totalOvertimePay: 2500, grossSalary: 34500, netSalary: 34000 }),
      });
      expect(result.response.status).toBe(400);
      expect(result.body?.code).toBe('FORCE_UPDATE_REMOVED');
      expect(storageMock.commitSalaryCorrection).not.toHaveBeenCalled();
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.getSettings).not.toHaveBeenCalled();
      expect(salaryState.records[0]).toEqual(original);
      expect(salaryState.corrections).toHaveLength(0);
    } finally { await server.close(); }
  });

  it('recalculates audited manual salary inputs on the server while preserving original overtime and holiday totals', async () => {
    const server = await testServer();
    const original = structuredClone(salaryState.records[0]);
    try {
      const request = {
        ...manualRequest(), totalOT1Hours: 12, totalOT2Hours: 6, totalOvertimePay: 999999,
        totalHolidayPay: 400, holidayDays: 999, grossSalary: 1, totalDeductions: 999999, netSalary: 1,
      };
      const result = await jsonRequest<SalaryRecord>(server.baseUrl, '/api/salary-records/7', {
        method: 'PATCH', headers: { [TEST_ADMIN_HEADER]: 'true', 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      expect(result.response.status).toBe(200);
      expect(result.body).toMatchObject({
        id: 7, revision: 1, baseSalary: 31000, totalOT1Hours: 2, totalOT2Hours: 1,
        totalOvertimePay: 800, totalHolidayPay: 0, holidayDays: 0, welfareAllowance: 500,
        grossSalary: 32300, totalDeductions: 100, netSalary: 32200,
      });
      expect(storageMock.commitSalaryCorrection).toHaveBeenCalledWith(7, expect.objectContaining({
        idempotencyKey: request.idempotencyKey, actorRole: 'SUPER', actorId: expect.stringMatching(/^[a-f0-9]{64}$/),
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/), previewTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }), expect.any(Function));
      expect(salaryState.corrections).toHaveLength(1);
      expect(salaryState.corrections[0].beforeSnapshot).toEqual(original);
      expect(salaryState.corrections[0].afterSnapshot.netSalary).toBe(32200);
      expect(salaryState.corrections[0].delta).toEqual({
        grossSalary: 1000, totalDeductions: 100, netSalary: 900, totalHolidayPay: 0, holidayDays: 0,
      });
      expect(storageMock.updateSalaryRecord).not.toHaveBeenCalled();
      expect(storageMock.getSettings).not.toHaveBeenCalled();
      expect(storageMock.getTemporaryAttendance).not.toHaveBeenCalled();
      expect(storageMock.getTemporaryAttendanceByEmployeeAndMonth).not.toHaveBeenCalled();
      expect(salaryCalculatorMock.calculateSalary).not.toHaveBeenCalled();
      expect(salaryCalculatorMock.calculateHolidayPayAdjustments).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it.each(['Saved synthetic description', null])('removes a deduction after a holiday revision while preserving deduction metadata: %s', async (description) => {
    const server = await testServer();
    const retained = { name: 'Synthetic retained deduction', amount: 500, description };
    const erroneous = { name: 'Synthetic mistaken deduction', amount: 120, description: 'Synthetic previous-period item' };
    const original = { ...salary(), revision: 1, deductions: [retained, erroneous], totalDeductions: 620, netSalary: 30680 };
    salaryState.records = [structuredClone(original)];
    const request = { revision: 1, reason: 'Remove synthetic mistaken deduction', paymentHandling: 'unknown_adjustment',
      idempotencyKey: randomUUID(), baseSalary: original.baseSalary, housingAllowance: 0,
      deductions: [retained], specialLeaveInfo: null };
    try {
      let cookie = '';
      const save = () => jsonRequest<SalaryRecord>(server.baseUrl, '/api/salary-records/7', {
        method: 'PATCH', headers: { [TEST_ADMIN_HEADER]: 'true', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(request),
      });
      const result = await save();
      cookie = result.response.headers.get('set-cookie')!.split(';')[0];
      expect(result.response.status).toBe(200);
      expect(result.body).toMatchObject({ revision: 2, deductions: [retained], totalDeductions: 500, grossSalary: 31300, netSalary: 30800 });
      expect(result.body?.attendanceData).toEqual(original.attendanceData);
      expect(result.body?.totalOvertimePay).toBe(original.totalOvertimePay);
      expect(result.body?.totalHolidayPay).toBe(original.totalHolidayPay);
      expect(salaryState.corrections).toHaveLength(1);
      expect(salaryState.corrections[0].beforeSnapshot).toEqual(original);
      expect(salaryState.corrections[0].delta.netSalary).toBe(120);
      const replay = await save();
      expect(replay.response.status).toBe(200);
      expect(replay.body?.revision).toBe(2);
      expect(salaryState.corrections).toHaveLength(1);
      const changedMetadata = await jsonRequest(server.baseUrl, '/api/salary-records/7', {
        method: 'PATCH', headers: { [TEST_ADMIN_HEADER]: 'true', 'content-type': 'application/json', cookie },
        body: JSON.stringify({ ...request, deductions: [{ ...retained, description: 'Changed synthetic metadata' }] }),
      });
      expect(changedMetadata.response.status).toBe(409);
      expect(salaryState.corrections).toHaveLength(1);
      expect(salaryState.records[0].deductions).toEqual([retained]);
    } finally { await server.close(); }
  });

  it.each(['revision', 'reason', 'paymentHandling', 'idempotencyKey'])('requires %s for an audited historical edit', async (field) => {
    const server = await testServer();
    try {
      const request: Record<string, unknown> = manualRequest();
      delete request[field];
      const result = await jsonRequest(server.baseUrl, '/api/salary-records/7', {
        method: 'PATCH', headers: { [TEST_ADMIN_HEADER]: 'true', 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      expect(result.response.status).toBe(400);
      expect(storageMock.commitSalaryCorrection).not.toHaveBeenCalled();
      expect(salaryState.corrections).toHaveLength(0);
      expect(salaryState.records[0].revision).toBe(0);
    } finally { await server.close(); }
  });

  it.each([
    { deductions: [{ name: { text: 'invalid' }, amount: 1 }] },
    { deductions: [null] },
    { deductions: { name: 'invalid array', amount: 1 } },
    { deductions: [{ name: 'negative amount', amount: -1 }] },
    { deductions: [{ name: 'invalid description', amount: 1, description: {} }] },
    { deductions: [{ name: 'long description', amount: 1, description: 'x'.repeat(1001) }] },
    { deductions: [{ name: 'unexpected metadata', amount: 1, employeeId: 99 }] },
    { allowances: [{ name: 42, amount: 1 }] },
    { allowances: [{ name: '   ', amount: 1 }] },
    { allowances: [{ name: 'x'.repeat(101), amount: 1 }] },
    { allowances: [{ name: 'invalid amount', amount: '100' }] },
    { allowances: [{ name: 'invalid description', amount: 1, description: {} }] },
    { allowances: Array.from({ length: 101 }, () => ({ name: 'too many items', amount: 1 })) },
    { specialLeaveInfo: { usedDays: 0, usedDates: [], cashDays: 0, cashAmount: -1 } },
    { specialLeaveInfo: { usedDays: 0, usedDates: [], cashDays: 0, cashAmount: 1, notes: {} } },
  ])('rejects invalid historical JSON inputs without creating a revision: %j', async (invalidFields) => {
    const server = await testServer();
    const original = structuredClone(salaryState.records[0]);
    try {
      const result = await jsonRequest(server.baseUrl, '/api/salary-records/7', {
        method: 'PATCH', headers: { [TEST_ADMIN_HEADER]: 'true', 'content-type': 'application/json' },
        body: JSON.stringify({ ...manualRequest(), ...invalidFields }),
      });
      expect(result.response.status).toBe(400);
      expect(storageMock.commitSalaryCorrection).not.toHaveBeenCalled();
      expect(salaryState.records[0]).toEqual(original);
      expect(salaryState.corrections).toHaveLength(0);
    } finally { await server.close(); }
  });

  it('rejects an outdated historical edit revision without overwriting newer payroll', async () => {
    const server = await testServer();
    salaryState.records[0].revision = 1;
    const original = structuredClone(salaryState.records[0]);
    try {
      const result = await jsonRequest<{ code: string }>(server.baseUrl, '/api/salary-records/7', {
        method: 'PATCH', headers: { [TEST_ADMIN_HEADER]: 'true', 'content-type': 'application/json' },
        body: JSON.stringify(manualRequest()),
      });
      expect(result.response.status).toBe(409);
      expect(result.body?.code).toBe('REVISION_CONFLICT');
      expect(salaryState.records[0]).toEqual(original);
      expect(salaryState.corrections).toHaveLength(0);
    } finally { await server.close(); }
  });
});
