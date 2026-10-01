import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SalaryCorrection, SalaryRecord } from '@shared/schema';
import type { PayrollCorrectionPreview, PayrollCorrectionRequest } from '@shared/payrollCorrection';
import type { SalaryCorrectionCommit } from '../repositories/salaryRepository';
import { PermissionLevel } from '../admin-auth';
import { PayrollCorrectionError } from '../services/payrollCorrection';
import { createPayrollPreviewToken } from '../services/payrollPreviewToken';
import { TEST_ADMIN_HEADER, setupTestAdminSession } from '../test-utils/admin-test-session';
import { createJsonTestServer, jsonRequest, type TestHttpServer } from '../test-utils/http-test-server';

const state = vi.hoisted(() => ({
  records: [] as SalaryRecord[],
  corrections: [] as SalaryCorrection[],
  lock: Promise.resolve(),
}));

// HTTP integration uses only synthetic in-memory records. Row-lock behavior is
// modeled here; actual PostgreSQL transaction guarantees require separate DB tests.
const storageMock = vi.hoisted(() => ({
  getSalaryRecordById: vi.fn(async (id: number) => state.records.find((record) => record.id === id)),
  getSalaryCorrections: vi.fn(async (id: number) => state.corrections.filter((entry) => entry.originalRecordId === id)),
  commitSalaryCorrection: vi.fn(async (
    id: number,
    commit: SalaryCorrectionCommit,
    build: (record: SalaryRecord) => PayrollCorrectionPreview,
  ) => {
    const previousLock = state.lock;
    let unlock!: () => void;
    state.lock = new Promise<void>((resolve) => { unlock = resolve; });
    await previousLock;
    try {
      const index = state.records.findIndex((record) => record.id === id);
      if (index === -1) throw new PayrollCorrectionError(404, 'NOT_FOUND', 'Salary record not found.');
      const current = state.records[index];
      const prior = state.corrections.find((entry) => entry.originalRecordId === id && entry.idempotencyKey === commit.idempotencyKey);
      if (prior) {
        if (prior.requestHash !== commit.requestHash || prior.previewTokenHash !== commit.previewTokenHash || prior.actorId !== commit.actorId) {
          throw new PayrollCorrectionError(409, 'IDEMPOTENCY_CONFLICT', 'This request key belongs to another correction.');
        }
        return { record: current, correction: prior, replayed: true };
      }
      const preview = build(current);
      const record = { ...structuredClone(preview.after), revision: current.revision + 1 };
      const correction: SalaryCorrection = {
        id: state.corrections.length + 1, originalRecordId: id, salaryRecordId: id,
        revision: record.revision, ...commit, reason: preview.reason, paymentHandling: preview.paymentHandling,
        holidays: preview.holidays, delta: preview.delta, beforeSnapshot: structuredClone(current),
        afterSnapshot: structuredClone(record), createdAt: new Date(),
      };
      state.records[index] = record;
      state.corrections.push(correction);
      return { record, correction, replayed: false };
    } finally {
      unlock();
    }
  }),
}));

vi.mock('../repositories/salaryRepository', () => ({ salaryRepository: storageMock }));
vi.mock('../storage', () => ({ storage: storageMock }));

let registerPayrollCorrectionRoutes: typeof import('./payrollCorrection.routes').registerPayrollCorrectionRoutes;
let server: TestHttpServer;

function salary(id = 7): SalaryRecord {
  return {
    id, revision: 0, salaryYear: 2026, salaryMonth: 9, employeeId: id === 7 ? 42 : 43,
    employeeName: 'Synthetic employee', baseSalary: 30000, holidayCalculationBaseSalary: 30000, housingAllowance: 0, welfareAllowance: 200,
    allowances: [{ name: 'Synthetic allowance', amount: 200 }], totalOT1Hours: 0, totalOT2Hours: 0,
    totalOvertimePay: 0, holidayDays: 0, holidayDailySalary: 1000, totalHolidayPay: 0,
    grossSalary: 30200, deductions: [{ name: 'Synthetic withholding', amount: 1000 }],
    totalDeductions: 1000, netSalary: 29200, attendanceData: [], specialLeaveInfo: null,
    anonymizedAt: null, retentionUntil: null, employeeSnapshot: null, createdAt: new Date('2026-10-01T00:00:00Z'),
  };
}

function input(): PayrollCorrectionRequest & { revision: number } {
  return { revision: 0, holidays: [
    { date: '2026-09-25', holidayType: 'national_holiday', name: 'Synthetic holiday A', mode: 'add' },
    { date: '2026-09-28', holidayType: 'national_holiday', name: 'Synthetic holiday B', mode: 'add' },
  ], reason: 'Record omitted holidays', paymentHandling: 'unknown_adjustment' };
}

function headers(cookie: string): Record<string, string> {
  return { cookie, 'content-type': 'application/json' };
}

async function adminCookie(): Promise<string> {
  const result = await jsonRequest(server.baseUrl, '/api/salary-records/7/holiday-corrections', {
    headers: { [TEST_ADMIN_HEADER]: 'true' },
  });
  expect(result.response.status).toBe(200);
  const cookie = result.response.headers.get('set-cookie');
  expect(cookie).toBeTruthy();
  return cookie!.split(';')[0];
}

async function preview(cookie: string, body: unknown = input(), recordId = 7) {
  return jsonRequest<PayrollCorrectionPreview & { previewToken: string }>(
    server.baseUrl, `/api/salary-records/${recordId}/holiday-corrections/preview`,
    { method: 'POST', headers: headers(cookie), body: JSON.stringify(body) },
  );
}

async function confirm(cookie: string, token: string, body: unknown = input(), key = randomUUID(), recordId = 7) {
  return jsonRequest<{ record: SalaryRecord; correction: Record<string, unknown>; replayed: boolean; code?: string }>(
    server.baseUrl, `/api/salary-records/${recordId}/holiday-corrections`,
    { method: 'POST', headers: headers(cookie), body: JSON.stringify({ ...(body as object), previewToken: token, idempotencyKey: key }) },
  );
}

beforeAll(async () => {
  ({ registerPayrollCorrectionRoutes } = await import('./payrollCorrection.routes'));
});

beforeEach(async () => {
  state.records = [salary(), salary(8)];
  state.corrections = [];
  state.lock = Promise.resolve();
  vi.clearAllMocks();
  server = await createJsonTestServer(registerPayrollCorrectionRoutes, {
    setupApp: (app) => {
      setupTestAdminSession(app);
      app.use((req, _res, next) => {
        if (req.headers['x-test-basic'] === 'true' && req.session.adminAuth) {
          req.session.adminAuth.permissionLevel = PermissionLevel.BASIC;
        }
        next();
      });
    },
  });
});

afterEach(async () => { await server.close(); });

describe('payroll correction HTTP integration', () => {
  it('requires an administrator session for preview, confirmation, and journal reads', async () => {
    for (const suffix of ['/preview', '']) {
      const result = await jsonRequest(server.baseUrl, `/api/salary-records/7/holiday-corrections${suffix}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input()),
      });
      expect(result.response.status).toBe(401);
    }
    const journal = await jsonRequest(server.baseUrl, '/api/salary-records/7/holiday-corrections');
    expect(journal.response.status).toBe(401);
    expect(storageMock.getSalaryRecordById).not.toHaveBeenCalled();
    expect(storageMock.commitSalaryCorrection).not.toHaveBeenCalled();
  });

  it('rejects a lower-privilege authenticated session', async () => {
    const result = await jsonRequest(server.baseUrl, '/api/salary-records/7/holiday-corrections/preview', {
      method: 'POST',
      headers: { [TEST_ADMIN_HEADER]: 'true', 'x-test-basic': 'true', 'content-type': 'application/json' },
      body: JSON.stringify(input()),
    });
    expect(result.response.status).toBe(403);
    expect(storageMock.commitSalaryCorrection).not.toHaveBeenCalled();
  });

  it('previews both omitted September holidays and cancellation leaves the original record untouched', async () => {
    const cookie = await adminCookie();
    const original = structuredClone(state.records[0]);
    const result = await preview(cookie);
    expect(result.response.status).toBe(200);
    expect(result.body?.delta.netSalary).toBe(0);
    expect(result.body?.after.attendanceData).toHaveLength(2);
    expect(result.body?.previewToken).toBeTruthy();
    expect(state.records[0]).toEqual(original);
    expect(state.corrections).toHaveLength(0);
    expect(storageMock.commitSalaryCorrection).not.toHaveBeenCalled();
    const reopened = await jsonRequest<{ corrections: unknown[] }>(server.baseUrl, '/api/salary-records/7/holiday-corrections', { headers: { cookie } });
    expect(reopened.body?.corrections).toEqual([]);
  });

  it('confirms once, increments the revision, and exposes only sanitized journal fields', async () => {
    const cookie = await adminCookie();
    const result = await preview(cookie);
    const saved = await confirm(cookie, result.body!.previewToken);
    expect(saved.response.status).toBe(200);
    expect(saved.body?.replayed).toBe(false);
    expect(saved.body?.record.revision).toBe(1);
    expect(saved.body?.record.attendanceData).toHaveLength(2);
    expect(state.corrections).toHaveLength(1);
    expect(state.corrections[0].beforeSnapshot.attendanceData).toHaveLength(0);
    expect(state.corrections[0].afterSnapshot.attendanceData).toHaveLength(2);
    const journal = await jsonRequest<{ corrections: Array<Record<string, unknown>> }>(
      server.baseUrl, '/api/salary-records/7/holiday-corrections', { headers: { cookie } },
    );
    expect(journal.response.status).toBe(200);
    expect(journal.body?.corrections).toHaveLength(1);
    expect(Object.keys(journal.body!.corrections[0]).sort()).toEqual([
      'actorRole', 'createdAt', 'delta', 'holidays', 'id', 'paymentHandling', 'reason', 'revision',
    ].sort());
    expect(saved.body?.correction).not.toHaveProperty('actorId');
    expect(saved.body?.correction).not.toHaveProperty('requestHash');
    expect(saved.body?.correction).not.toHaveProperty('beforeSnapshot');
  });

  it('replays an identical key without applying the correction a second time', async () => {
    const cookie = await adminCookie();
    const result = await preview(cookie);
    const key = randomUUID();
    const first = await confirm(cookie, result.body!.previewToken, input(), key);
    const second = await confirm(cookie, result.body!.previewToken, input(), key);
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(second.body?.replayed).toBe(true);
    expect(state.records[0].revision).toBe(1);
    expect(state.corrections).toHaveLength(1);
  });

  it('rejects reuse of a key for a changed correction payload', async () => {
    const cookie = await adminCookie();
    const result = await preview(cookie);
    const key = randomUUID();
    expect((await confirm(cookie, result.body!.previewToken, input(), key)).response.status).toBe(200);
    const changed = { ...input(), reason: 'A different synthetic reason' };
    const replay = await confirm(cookie, result.body!.previewToken, changed, key);
    expect(replay.response.status).toBe(409);
    expect(state.corrections).toHaveLength(1);
  });

  it('rejects a stale revision or a changed salary snapshot even if its revision was not advanced', async () => {
    const cookie = await adminCookie();
    const result = await preview(cookie);
    state.records[0].revision += 1;
    expect((await confirm(cookie, result.body!.previewToken)).response.status).toBe(409);
    state.records[0].revision = 0;
    state.records[0].netSalary -= 1;
    expect((await confirm(cookie, result.body!.previewToken)).response.status).toBe(409);
    expect(state.corrections).toHaveLength(0);
  });

  it('rejects a changed payload, a tampered signature, and a correctly signed expired preview', async () => {
    const cookie = await adminCookie();
    const result = await preview(cookie);
    const token = result.body!.previewToken;
    const changed = { ...input(), reason: 'Changed after preview' };
    expect((await confirm(cookie, token, changed)).response.status).toBe(409);
    const last = token.slice(-1);
    const tampered = token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect((await confirm(cookie, tampered)).response.status).toBe(409);
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as { actorId: string };
    const expired = createPayrollPreviewToken(state.records[0], input(), payload.actorId, Date.now() - 11 * 60_000);
    expect((await confirm(cookie, expired)).response.status).toBe(409);
    expect(state.corrections).toHaveLength(0);
  });

  it('binds a preview to the administrator session that requested it', async () => {
    const firstAdmin = await adminCookie();
    const secondAdmin = await adminCookie();
    expect(firstAdmin).not.toBe(secondAdmin);
    const result = await preview(firstAdmin);
    expect((await confirm(secondAdmin, result.body!.previewToken)).response.status).toBe(409);
    expect(state.corrections).toHaveLength(0);
    expect((await confirm(firstAdmin, result.body!.previewToken)).response.status).toBe(200);
  });

  it('handles rapid repeated confirmation with one journal entry', async () => {
    const cookie = await adminCookie();
    const result = await preview(cookie);
    const key = randomUUID();
    const confirmations = await Promise.all([
      confirm(cookie, result.body!.previewToken, input(), key),
      confirm(cookie, result.body!.previewToken, input(), key),
    ]);
    expect(confirmations.map((entry) => entry.response.status)).toEqual([200, 200]);
    expect(confirmations.map((entry) => entry.body?.replayed).sort()).toEqual([false, true]);
    expect(state.corrections).toHaveLength(1);
    expect(state.records[0].revision).toBe(1);
  });

  it('allows only one of two concurrent corrections based on the same original preview', async () => {
    const cookie = await adminCookie();
    const result = await preview(cookie);
    const confirmations = await Promise.all([
      confirm(cookie, result.body!.previewToken),
      confirm(cookie, result.body!.previewToken),
    ]);
    expect(confirmations.map((entry) => entry.response.status).sort()).toEqual([200, 409]);
    expect(state.corrections).toHaveLength(1);
  });

  it('cannot use one employee salary preview to mutate another salary record', async () => {
    const cookie = await adminCookie();
    const result = await preview(cookie);
    expect((await confirm(cookie, result.body!.previewToken, input(), randomUUID(), 8)).response.status).toBe(409);
    expect(state.records[1].revision).toBe(0);
    expect(state.records[1].attendanceData).toEqual([]);
    expect(state.corrections).toHaveLength(0);
  });

  it.each([
    { date: '2026-09-31' },
    { date: '2026-10-01' },
    { date: '2026/09/25' },
    { holidayType: 'unsupported' },
    { clockIn: '08:00' },
  ])('rejects invalid holiday dates and additional client fields: %o', async (change) => {
    const cookie = await adminCookie();
    const bad = input();
    Object.assign(bad.holidays[0], change);
    const result = await preview(cookie, bad);
    expect(result.response.status).toBe(400);
    expect(storageMock.commitSalaryCorrection).not.toHaveBeenCalled();
  });

  it('rejects employee and monetary field injection, missing revision, and invalid request keys', async () => {
    const cookie = await adminCookie();
    for (const field of [{ employeeId: 43 }, { netSalary: 1 }, { revision: undefined }]) {
      expect((await preview(cookie, { ...input(), ...field })).response.status).toBe(400);
    }
    const result = await preview(cookie);
    expect((await confirm(cookie, result.body!.previewToken, input(), 'not-a-uuid')).response.status).toBe(400);
    expect(storageMock.commitSalaryCorrection).not.toHaveBeenCalled();
  });

  it('rejects malformed record IDs and unknown salaries before confirming anything', async () => {
    const cookie = await adminCookie();
    for (const id of ['7x', '0', '9007199254740993']) {
      const result = await jsonRequest(server.baseUrl, `/api/salary-records/${id}/holiday-corrections/preview`, {
        method: 'POST', headers: headers(cookie), body: JSON.stringify(input()),
      });
      expect(result.response.status).toBe(400);
    }
    expect((await preview(cookie, input(), 999)).response.status).toBe(404);
    expect(storageMock.commitSalaryCorrection).not.toHaveBeenCalled();
  });

  it('rejects cross-origin writes and non-JSON confirmation requests', async () => {
    const cookie = await adminCookie();
    for (const crossOrigin of [{ origin: 'https://untrusted.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      const result = await jsonRequest(server.baseUrl, '/api/salary-records/7/holiday-corrections/preview', {
        method: 'POST', headers: { ...headers(cookie), ...crossOrigin }, body: JSON.stringify(input()),
      });
      expect(result.response.status).toBe(403);
    }
    const notJson = await jsonRequest(server.baseUrl, '/api/salary-records/7/holiday-corrections', {
      method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: JSON.stringify(input()),
    });
    expect(notJson.response.status).toBe(415);
    expect(storageMock.commitSalaryCorrection).not.toHaveBeenCalled();
  });

  it('rejects a repeated holiday addition after reopening the corrected month', async () => {
    const cookie = await adminCookie();
    const result = await preview(cookie);
    expect((await confirm(cookie, result.body!.previewToken)).response.status).toBe(200);
    const repeated = await preview(cookie, { ...input(), revision: 1 });
    expect(repeated.response.status).toBe(409);
    expect(state.records[0].attendanceData).toHaveLength(2);
    expect(state.corrections).toHaveLength(1);
  });
});
