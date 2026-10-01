import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  employees, salaryRecords, salaryCorrections, settings,
  type SalaryRecord, type TemporaryAttendance, type Settings,
} from '@shared/schema';
import type { PayrollCorrectionRequest } from '@shared/payrollCorrection';
import { payrollTestDatabaseUrl, payrollTestReporterArgs } from '../scripts/test-payroll-real-db.mjs';
import { buildPayrollHolidayCorrection, PayrollCorrectionError } from './services/payrollCorrection';
import { calculateHolidayPayAdjustments } from './utils/salaryCalculator';
import type { SalaryCorrectionCommit } from './repositories/salaryRepository';

let storage: typeof import('./storage').storage;
let salaryRepository: typeof import('./repositories/salaryRepository').salaryRepository;
let db: typeof import('./db').db;
let sql: typeof import('./db').sql;
const prefix = `__payroll_correction_${randomUUID()}`;
const employeeIds = new Set<number>();
const recordIds = new Set<number>();
const settingsIds = new Set<number>();

beforeAll(async () => {
  // Repeat the guard so direct Vitest invocation cannot reach a production URL.
  process.env.DATABASE_URL = payrollTestDatabaseUrl();
  ({ db, sql } = await import('./db'));
  ({ storage } = await import('./storage'));
  ({ salaryRepository } = await import('./repositories/salaryRepository'));
  const [target] = await sql`select current_database() as name, host(inet_server_addr()) as address`;
  expect(target.name).toMatch(/^payroll_test_[a-z0-9_]+$/);
  expect(['127.0.0.1', '::1']).toContain(target.address);
  const [{ count }] = await sql`select count(*)::int as count from settings`;
  expect(count).toBe(0);
  for (const table of ['employees', 'salary_records', 'salary_corrections']) {
    const [{ count }] = await sql.unsafe(`select count(*)::int as count from ${table}`);
    expect(count).toBe(0);
  }
});

afterAll(async () => {
  if (!db || !sql) return;
  // Delete only rows tracked by this suite; never truncate, reset or drop a database.
  if (recordIds.size) {
    await db.delete(salaryCorrections).where(inArray(salaryCorrections.originalRecordId, [...recordIds]));
    await db.delete(salaryRecords).where(inArray(salaryRecords.id, [...recordIds]));
  }
  if (employeeIds.size) await db.delete(employees).where(inArray(employees.id, [...employeeIds]));
  if (settingsIds.size) await db.delete(settings).where(inArray(settings.id, [...settingsIds]));
  await sql.end({ timeout: 5 });
});

function attendance(employeeId: number, holidayType: string | null = null): TemporaryAttendance {
  return { id: 1, employeeId, date: '2026-09-25',
    clockIn: holidayType ? '--:--' : '08:00', clockOut: holidayType ? '--:--' : '17:00',
    isHoliday: !!holidayType, holidayType, isBarcodeScanned: false, holidayId: null, createdAt: null };
}

async function fixture(kind: 'empty' | 'normal' | 'sick_leave' = 'empty') {
  const [employee] = await db.insert(employees).values({
    name: `${prefix}_synthetic`, idNumber: `${prefix}_${employeeIds.size}`, employeeType: 'local',
  }).returning();
  employeeIds.add(employee.id);
  const rows = kind === 'empty' ? [] : [attendance(employee.id, kind === 'sick_leave' ? kind : null)];
  const adjustments = calculateHolidayPayAdjustments(rows.map(row => ({ ...row,
    employeeId: row.employeeId ?? undefined, clockOut: row.clockOut ?? undefined })), 30000);
  const deductions = [{ name: 'Synthetic withholding', amount: 1000 }, ...adjustments.deductionItems];
  const totalDeductions = deductions.reduce((sum, item) => sum + item.amount, 0);
  const record = await salaryRepository.createSalaryRecord({
    salaryYear: 2026, salaryMonth: 9, employeeId: employee.id, employeeName: employee.name,
    baseSalary: 30000, housingAllowance: 100, welfareAllowance: 200,
    totalOT1Hours: 1, totalOT2Hours: 0, totalOvertimePay: 300,
    holidayDays: 0, holidayDailySalary: 1000, totalHolidayPay: 0,
    grossSalary: 30600, netSalary: 30600 - totalDeductions, deductions, totalDeductions,
    allowances: [{ name: 'Synthetic allowance', amount: 200 }], attendanceData: rows,
  });
  recordIds.add(record.id);
  return { record, employee };
}

function request(replace = false): PayrollCorrectionRequest {
  return { holidays: replace ? [
    { date: '2026-09-25', holidayType: 'national_holiday', name: 'Synthetic holiday A', mode: 'replace' },
  ] : [
    { date: '2026-09-25', holidayType: 'national_holiday', name: 'Synthetic holiday A', mode: 'add' },
    { date: '2026-09-28', holidayType: 'national_holiday', name: 'Synthetic holiday B', mode: 'add' },
  ], reason: 'Correct synthetic omitted holiday records', paymentHandling: 'paid_adjustment' };
}

function metadata(overrides: Partial<SalaryCorrectionCommit> = {}): SalaryCorrectionCommit {
  return { idempotencyKey: randomUUID(), requestHash: 'a'.repeat(64), previewTokenHash: 'b'.repeat(64),
    actorId: 'c'.repeat(64), actorRole: 'SUPER_ADMIN', ...overrides };
}

function builder(original: SalaryRecord, input = request()) {
  return (current: SalaryRecord) => {
    if (current.revision !== original.revision) {
      throw new PayrollCorrectionError(409, 'REVISION_CONFLICT', 'Reload and preview again.');
    }
    return buildPayrollHolidayCorrection(current, input);
  };
}

describe('payroll database destination guards', () => {
  it.each([
    {},
    { DATABASE_URL: 'postgres://test@127.0.0.1/payroll_test_example', PAYROLL_CORRECTION_TEST_DB_DISPOSABLE: '1' },
    { PAYROLL_CORRECTION_TEST_DB_URL: 'postgres://test@127.0.0.1/payroll_test_example' },
    { PAYROLL_CORRECTION_TEST_DB_URL: 'postgres://test@example.com/payroll_test_example', PAYROLL_CORRECTION_TEST_DB_DISPOSABLE: '1' },
    { PAYROLL_CORRECTION_TEST_DB_URL: 'postgres://test@127.0.0.1/salary_production', PAYROLL_CORRECTION_TEST_DB_DISPOSABLE: '1' },
    { PAYROLL_CORRECTION_TEST_DB_URL: 'postgres://test@127.0.0.1/payroll_test_example?host=example.com', PAYROLL_CORRECTION_TEST_DB_DISPOSABLE: '1' },
  ])('rejects an absent, implicit, remote or unapproved scratch destination %#', env => {
    expect(() => payrollTestDatabaseUrl(env)).toThrow();
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])('accepts an explicit %s scratch destination', host => {
    const url = `postgres://test@${host}:5432/payroll_test_example`;
    expect(payrollTestDatabaseUrl({ PAYROLL_CORRECTION_TEST_DB_URL: url,
      PAYROLL_CORRECTION_TEST_DB_DISPOSABLE: '1' })).toBe(url);
  });

  it.each([['--config=vitest.real-db.config.ts'], ['--config', 'vitest.real-db.config.ts'],
    ['--testNamePattern=skip'], ['--reporter=./custom-code.mjs']])('refuses suite or executable-reporter overrides %#', args => {
    expect(() => payrollTestReporterArgs(args)).toThrow();
  });

  it('permits report formatting without changing the dedicated suite', () => {
    const args = ['--reporter=json', '--outputFile=report.json'];
    expect(payrollTestReporterArgs(args)).toEqual(args);
  });
});

describe('isolated PostgreSQL payroll correction transactions', () => {
  it('persists September 25 and 28 once without paying an already covered national holiday twice', async () => {
    const { record } = await fixture();
    const result = await salaryRepository.commitSalaryCorrection(record.id, metadata(), builder(record));
    expect(result.replayed).toBe(false);
    expect(result.record.revision).toBe(1);
    expect(result.record.holidayCalculationBaseSalary).toBe(30000);
    expect(result.record.attendanceData?.map(row => row.date)).toEqual(['2026-09-25', '2026-09-28']);
    expect(result.record.netSalary).toBe(record.netSalary);
    expect(result.correction.beforeSnapshot.attendanceData).toEqual([]);
    expect(result.correction.delta.netSalary).toBe(0);
    expect(result.correction.paymentHandling).toBe('paid_adjustment');
    expect(await salaryRepository.getSalaryRecordById(record.id)).toMatchObject(result.record);
    expect(await salaryRepository.getSalaryCorrections(record.id)).toHaveLength(1);
  });

  it('atomically replaces the existing sick-leave deduction using the original calculation rules', async () => {
    const { record } = await fixture('sick_leave');
    const result = await salaryRepository.commitSalaryCorrection(record.id, metadata(), builder(record, request(true)));
    expect(result.record.netSalary).toBe(record.netSalary + 500);
    expect(result.record.totalDeductions).toBe(record.totalDeductions! - 500);
    expect(result.record.deductions).toEqual([{ name: 'Synthetic withholding', amount: 1000 }]);
    expect(result.correction.delta).toMatchObject({ netSalary: 500, totalDeductions: -500, grossSalary: 0 });
    expect(result.correction.beforeSnapshot.netSalary).toBe(record.netSalary);
    expect(result.correction.afterSnapshot.netSalary).toBe(result.record.netSalary);
    expect(result.record.totalOvertimePay).toBe(record.totalOvertimePay);
  });

  it('rolls back the projection and revision when PostgreSQL rejects the journal INSERT', async () => {
    const { record } = await fixture('sick_leave');
    await expect(salaryRepository.commitSalaryCorrection(record.id, metadata({ idempotencyKey: 'invalid-uuid' }),
      builder(record, request(true)))).rejects.toThrow();
    expect(await salaryRepository.getSalaryRecordById(record.id)).toEqual(record);
    expect(await salaryRepository.getSalaryCorrections(record.id)).toEqual([]);
  });

  it('serializes concurrent same-key requests into one journal row and one replay', async () => {
    const { record } = await fixture();
    const commit = metadata();
    let builds = 0;
    const build = (current: SalaryRecord) => { builds++; return builder(record)(current); };
    const results = await Promise.all([
      salaryRepository.commitSalaryCorrection(record.id, commit, build),
      salaryRepository.commitSalaryCorrection(record.id, commit, build),
    ]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(builds).toBe(1);
    expect(results[0].correction.id).toBe(results[1].correction.id);
    expect((await salaryRepository.getSalaryRecordById(record.id))?.revision).toBe(1);
    expect(await salaryRepository.getSalaryCorrections(record.id)).toHaveLength(1);
    await expect(salaryRepository.commitSalaryCorrection(record.id, { ...commit, actorId: 'd'.repeat(64) }, build))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(await salaryRepository.getSalaryCorrections(record.id)).toHaveLength(1);
  });

  it('permits only one winner for concurrent different-key requests using the same original revision', async () => {
    const { record } = await fixture();
    const results = await Promise.allSettled([
      salaryRepository.commitSalaryCorrection(record.id, metadata(), builder(record)),
      salaryRepository.commitSalaryCorrection(record.id, metadata(), builder(record)),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(result => result.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    expect((await salaryRepository.getSalaryRecordById(record.id))?.revision).toBe(1);
    expect(await salaryRepository.getSalaryCorrections(record.id)).toHaveLength(1);
  });

  it('blocks generic history update and deletion after a correction', async () => {
    const { record } = await fixture();
    const result = await salaryRepository.commitSalaryCorrection(record.id, metadata(), builder(record));
    await expect(salaryRepository.updateSalaryRecord(record.id, { netSalary: 1 }))
      .rejects.toMatchObject({ status: 409, code: 'CORRECTION_REQUIRED' });
    await expect(salaryRepository.deleteSalaryRecord(record.id))
      .rejects.toMatchObject({ status: 409, code: 'CORRECTION_HISTORY_PROTECTED' });
    expect(await salaryRepository.getSalaryRecordById(record.id)).toEqual(result.record);
    expect(await salaryRepository.getSalaryCorrections(record.id)).toHaveLength(1);
  });

  it('whitelists attendance and special-leave snapshots so the journal does not duplicate employee identity', async () => {
    const { record, employee } = await fixture('normal');
    const rows = record.attendanceData!.map(row => ({ ...row,
      _employeeName: employee.name, idNumber: employee.idNumber, unexpectedIdentity: 'synthetic-private' }));
    const [original] = await db.update(salaryRecords).set({ attendanceData: rows,
      employeeSnapshot: { employeeType: 'local', department: 'Synthetic department', position: null,
        deletedAt: null, deletedBy: 'synthetic-actor' },
      specialLeaveInfo: { usedDays: 0, usedDates: [], cashDays: 0, cashAmount: 0, notes: 'synthetic-private' },
    }).where(eq(salaryRecords.id, record.id)).returning();
    const result = await salaryRepository.commitSalaryCorrection(record.id, metadata(), builder(original, request(true)));
    for (const snapshot of [result.correction.beforeSnapshot, result.correction.afterSnapshot]) {
      expect(snapshot.employeeId).toBeNull();
      expect(snapshot.employeeName).toBeNull();
      expect(snapshot.employeeSnapshot).toBeNull();
      expect(snapshot.attendanceData?.[0].employeeId).toBeNull();
      expect(snapshot.attendanceData?.[0]).not.toHaveProperty('_employeeName');
      expect(snapshot.attendanceData?.[0]).not.toHaveProperty('idNumber');
      expect(snapshot.attendanceData?.[0]).not.toHaveProperty('unexpectedIdentity');
      expect(snapshot.specialLeaveInfo).not.toHaveProperty('notes');
      expect(JSON.stringify(snapshot)).not.toContain('synthetic-private');
      expect(JSON.stringify(snapshot)).not.toContain(employee.name);
    }
    expect(result.record.employeeId).toBe(employee.id);
    expect(result.record.employeeName).toBe(employee.name);
  });

  it('unlinks an expired anonymized projection through the nullable FK while preserving its original journal', async () => {
    const { record } = await fixture();
    const result = await salaryRepository.commitSalaryCorrection(record.id, metadata(), builder(record));
    await db.update(salaryRecords).set({ employeeId: null, employeeName: null,
      anonymizedAt: new Date('2000-01-01T00:00:00Z'), retentionUntil: new Date('2001-01-01T00:00:00Z'),
    }).where(eq(salaryRecords.id, record.id));
    expect(await salaryRepository.purgeExpiredRetainedSalaryRecords()).toBe(1);
    expect(await salaryRepository.getSalaryRecordById(record.id)).toBeUndefined();
    const [journal] = await salaryRepository.getSalaryCorrections(record.id);
    expect(journal.salaryRecordId).toBeNull();
    expect(journal.originalRecordId).toBe(record.id);
    expect(journal.beforeSnapshot).toEqual(result.correction.beforeSnapshot);
    expect(journal.afterSnapshot).toEqual(result.correction.afterSnapshot);
    expect(journal.delta).toEqual(result.correction.delta);
  });

  it('allows only one administrator PIN compare-and-swap winner and preserves it during unrelated settings updates', async () => {
    const [setting] = await db.insert(settings).values({ adminPin: `${prefix}_old` }).returning();
    settingsIds.add(setting.id);
    const hashes = [`${prefix}_new_a`, `${prefix}_new_b`];
    const results = await Promise.all(hashes.map(hash => storage.compareAndSwapAdminPin(setting.adminPin, hash)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = hashes[results.findIndex(Boolean)];
    expect((await storage.getSettings())?.adminPin).toBe(winner);
    await storage.createOrUpdateSettings({ welfareAllowance: 123 });
    expect((await storage.getSettings())?.adminPin).toBe(winner);
    expect((await storage.getSettings())?.welfareAllowance).toBe(123);
    expect(await storage.compareAndSwapAdminPin(setting.adminPin, `${prefix}_stale`)).toBe(false);
    expect((await storage.getSettings())?.adminPin).toBe(winner);
    const snapshotA = (await storage.getSettings())!;
    const clientB = postgres(payrollTestDatabaseUrl(), { ssl: false, max: 1, onnotice: () => {} });
    try {
      await clientB`update settings set admin_pin=${`${prefix}_client_b`} where id=${setting.id}`;
      expect(await storage.compareAndSwapAdminPin(snapshotA.adminPin, `${prefix}_client_a_stale`)).toBe(false);
      expect((await storage.getSettings())?.adminPin).toBe(`${prefix}_client_b`);
    } finally {
      await clientB.end({ timeout: 5 });
    }
  });
});


describe('public atomic salary batch revision guards', () => {
  const draft = (record: SalaryRecord) => {
    const { id: _id, revision: _revision, createdAt: _created, holidayCalculationBaseSalary: _base,
      anonymizedAt: _anonymized, retentionUntil: _retention, employeeSnapshot: _snapshot, ...values } = record;
    return values;
  };

  it('rejects force overwrites of a corrected journal row and rolls back the whole mixed batch', async () => {
    const ordinary = await fixture();
    const corrected = await fixture();
    await salaryRepository.commitSalaryCorrection(corrected.record.id, metadata(), builder(corrected.record));
    await expect(salaryRepository.saveSalaryRecordsAtomically([
      { existingId: ordinary.record.id, expectedRevision: 0, record: { ...draft(ordinary.record), housingAllowance: 900 } },
      { existingId: corrected.record.id, expectedRevision: 1, record: draft(corrected.record) },
    ])).rejects.toMatchObject({ status: 409, code: 'CORRECTION_REQUIRED' });
    expect((await salaryRepository.getSalaryRecordById(ordinary.record.id))?.housingAllowance).toBe(100);
    expect((await salaryRepository.getSalaryRecordById(ordinary.record.id))?.revision).toBe(0);
    expect(await salaryRepository.getSalaryCorrections(corrected.record.id)).toHaveLength(1);
  });

  it('permits successive ordinary forced reruns using their current revision but rejects stale or absent revisions', async () => {
    const { record } = await fixture();
    const [first] = await salaryRepository.saveSalaryRecordsAtomically([
      { existingId: record.id, expectedRevision: 0, record: draft(record) },
    ]);
    expect(first.revision).toBe(1);
    const [second] = await salaryRepository.saveSalaryRecordsAtomically([
      { existingId: first.id, expectedRevision: 1, record: draft(first) },
    ]);
    expect(second.revision).toBe(2);
    await expect(salaryRepository.saveSalaryRecordsAtomically([
      { existingId: record.id, expectedRevision: 1, record: draft(record) },
    ])).rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    await expect(salaryRepository.saveSalaryRecordsAtomically([
      { existingId: record.id, record: draft(record) },
    ])).rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    expect((await salaryRepository.getSalaryRecordById(record.id))?.revision).toBe(2);
    expect(await salaryRepository.getSalaryCorrections(record.id)).toEqual([]);
  });

  it('allows only one concurrent ordinary batch using the same pre-calculation revision', async () => {
    const { record } = await fixture();
    const writes = () => [{ existingId: record.id, expectedRevision: 0, record: draft(record) }];
    const results = await Promise.allSettled([
      salaryRepository.saveSalaryRecordsAtomically(writes()), salaryRepository.saveSalaryRecordsAtomically(writes()),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    expect((await salaryRepository.getSalaryRecordById(record.id))?.revision).toBe(1);
  });
});


describe('public settlement calculation basis persistence', () => {
  const snapshotDraft = (record: SalaryRecord) => {
    const { id: _id, revision: _revision, createdAt: _created, anonymizedAt: _anonymized,
      retentionUntil: _retention, employeeSnapshot: _snapshot, ...values } = record;
    return values;
  };
  const currentSettings = { id: 1, baseMonthSalary: 99000, baseHourlyRate: 119,
    ot1Multiplier: 1.34, ot2Multiplier: 1.67, welfareAllowance: 200,
    deductions: [], allowances: [{ name: 'Synthetic allowance', amount: 200 }],
    adminPin: 'synthetic-only', barcodeEnabled: false, updatedAt: null } satisfies Settings;

  it('persists the actual settlement base through both single and atomic new-record writes', async () => {
    const { record } = await fixture();
    const { buildCalculatedSalaryRecord } = await import('./routes/salary.routes');
    const calculated = await buildCalculatedSalaryRecord({ ...snapshotDraft(record),
      holidayCalculationBaseSalary: 88000, salaryMonth: 10 }, currentSettings, { attendanceRecords: [] });
    expect(calculated.holidayCalculationBaseSalary).toBe(30000);
    const single = await salaryRepository.createSalaryRecord(calculated);
    recordIds.add(single.id);
    const [batch] = await salaryRepository.saveSalaryRecordsAtomically([{ record: { ...calculated, salaryMonth: 11 } }]);
    recordIds.add(batch.id);
    for (const row of [single, batch]) {
      expect((await salaryRepository.getSalaryRecordById(row.id))?.holidayCalculationBaseSalary).toBe(30000);
    }
  });

  it('updates the basis on an ordinary force rerun and retains it when an audited manual edit changes displayed base salary', async () => {
    const { record } = await fixture();
    const { buildCalculatedSalaryRecord } = await import('./routes/salary.routes');
    const { buildHistorySalaryEdit } = await import('./services/historySalaryEdit');
    const initial = await buildCalculatedSalaryRecord({ ...snapshotDraft(record), salaryMonth: 10 }, currentSettings, { attendanceRecords: [] });
    const [settled] = await salaryRepository.saveSalaryRecordsAtomically([{ record: initial }]);
    recordIds.add(settled.id);
    const recalculated = await buildCalculatedSalaryRecord({ ...snapshotDraft(settled),
      baseSalary: 36000, holidayDailySalary: 1200 }, currentSettings, { attendanceRecords: [] });
    const [rerun] = await salaryRepository.saveSalaryRecordsAtomically([
      { existingId: settled.id, expectedRevision: 0, record: recalculated },
    ]);
    expect(rerun).toMatchObject({ baseSalary: 36000, holidayCalculationBaseSalary: 36000, revision: 1 });
    const edit = await salaryRepository.commitSalaryCorrection(rerun.id, metadata(), current =>
      buildHistorySalaryEdit(current, { baseSalary: 41000 }, 'Synthetic manual salary edit', 'unpaid'));
    expect(edit.record).toMatchObject({ baseSalary: 41000, holidayCalculationBaseSalary: 36000, revision: 2 });
    expect(edit.correction.beforeSnapshot.holidayCalculationBaseSalary).toBe(36000);
    expect(edit.correction.afterSnapshot.holidayCalculationBaseSalary).toBe(36000);
  });

  it.each([30000, null])('restores a fresh exported CSV with its saved basis or legacy null into PostgreSQL: %s', async (basis) => {
    const { record, employee } = await fixture();
    const { buildCalculatedSalaryRecord } = await import('./routes/salary.routes');
    const { buildSalaryRecordCsv } = await import('../client/src/lib/historyExport');
    const { registerImportRoutes } = await import('./routes/import.routes');
    const { createJsonTestServer, jsonRequest } = await import('./test-utils/http-test-server');
    const { TEST_ADMIN_HEADER, setupTestAdminSession } = await import('./test-utils/admin-test-session');
    const calculated = await buildCalculatedSalaryRecord({ ...snapshotDraft(record), salaryMonth: 10 },
      currentSettings, { attendanceRecords: [] });
    const source = await salaryRepository.createSalaryRecord({ ...calculated, holidayCalculationBaseSalary: basis });
    recordIds.add(source.id);
    const csvContent = buildSalaryRecordCsv(source);
    // Simulate recovery of an absent uncorrected record; only this tracked fixture row is removed.
    expect(await salaryRepository.deleteSalaryRecord(source.id)).toBe(true);
    const server = await createJsonTestServer(registerImportRoutes, { setupApp: setupTestAdminSession });
    try {
      const result = await jsonRequest<{ record: SalaryRecord }>(server.baseUrl, '/api/admin/import/salary-record', {
        method: 'POST', headers: { [TEST_ADMIN_HEADER]: 'true', 'content-type': 'application/json' },
        body: JSON.stringify({ csvContent, employeeId: employee.id }),
      });
      expect(result.response.status).toBe(200);
      const restored = result.body!.record;
      recordIds.add(restored.id);
      const persisted = (await salaryRepository.getSalaryRecordById(restored.id))!;
      expect(persisted.holidayCalculationBaseSalary).toBe(basis);
      for (const key of ['baseSalary', 'grossSalary', 'totalDeductions', 'netSalary'] as const) {
        expect(persisted[key]).toBe(source[key]);
      }
      expect(persisted.holidayCalculationBaseSalary).not.toBe(currentSettings.baseMonthSalary);
    } finally { await server.close(); }
  });
});
