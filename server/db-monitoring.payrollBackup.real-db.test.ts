import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@shared/schema';
import type { SalaryRecord, TemporaryAttendance } from '@shared/schema';
import type { PayrollCorrectionRequest } from '@shared/payrollCorrection';
import { payrollTestDatabaseUrl } from '../scripts/test-payroll-real-db.mjs';
import { AUTHORITATIVE_BACKUP_TABLES, AUTHORITATIVE_RESTORE_DELETE_ORDER } from './backup-authority';
import { buildPayrollHolidayCorrection } from './services/payrollCorrection';
import { calculateHolidayPayAdjustments } from './utils/salaryCalculator';
import type { SalaryCorrectionCommit } from './repositories/salaryRepository';

let salaryRepository: typeof import('./repositories/salaryRepository').salaryRepository;
let db: typeof import('./db').db;
let sql: typeof import('./db').sql;
let backups: typeof import('./db-monitoring');
let freshSql: ReturnType<typeof postgres>;
let freshDb: typeof db;
const prefix = `__backup_synthetic_${randomUUID()}`;
const canonical = (value: unknown) => JSON.parse(JSON.stringify(value));

beforeAll(async () => {
  // Recheck destinations even when someone invokes this file without the runner.
  process.env.DATABASE_URL = payrollTestDatabaseUrl();
  const freshUrl = payrollTestDatabaseUrl({ PAYROLL_CORRECTION_TEST_DB_URL: process.env.PAYROLL_BACKUP_FRESH_DB_URL,
    PAYROLL_CORRECTION_TEST_DB_DISPOSABLE: process.env.PAYROLL_CORRECTION_TEST_DB_DISPOSABLE });
  expect(freshUrl).not.toBe(process.env.DATABASE_URL);
  ({ db, sql } = await import('./db'));
  ({ salaryRepository } = await import('./repositories/salaryRepository'));
  backups = await import('./db-monitoring');
  freshSql = postgres(freshUrl, { ssl: false, onnotice: () => {} });
  freshDb = drizzle(freshSql, { schema });
  for (const connection of [sql, freshSql]) {
    const [target] = await connection`select current_database() as name, host(inet_server_addr()) as address`;
    expect(target.name).toMatch(/^payroll_test_[a-z0-9_]+$/);
    expect(['127.0.0.1', '::1']).toContain(target.address);
    for (const table of AUTHORITATIVE_BACKUP_TABLES) {
      const [{ count }] = await connection.unsafe(`select count(*)::int as count from ${table.tableName}`);
      expect(count).toBe(0);
    }
  }
});

async function clearScratch(connection: typeof sql) {
  // The suite has verified these initially empty, separately owned scratch DBs.
  for (const key of AUTHORITATIVE_RESTORE_DELETE_ORDER) {
    const table = AUTHORITATIVE_BACKUP_TABLES.find(row => row.payloadKey === key)!;
    await connection.unsafe(`delete from ${table.tableName}`);
  }
}

beforeEach(async () => {
  vi.restoreAllMocks();
  delete process.env.BACKUP_ENCRYPTION_KEY;
  await clearScratch(sql);
  await clearScratch(freshSql);
  await sql.unsafe('DROP TRIGGER IF EXISTS synthetic_fail_journal ON salary_corrections');
  await sql.unsafe('DROP FUNCTION IF EXISTS synthetic_fail_journal()');
  await sql.unsafe('DROP TABLE IF EXISTS user_sessions');
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (sql) await sql.end({ timeout: 5 });
  if (freshSql) await freshSql.end({ timeout: 5 });
});

const commitMetadata = (): SalaryCorrectionCommit => ({ idempotencyKey: randomUUID(),
  requestHash: 'a'.repeat(64), previewTokenHash: 'b'.repeat(64), actorId: 'c'.repeat(64), actorRole: 'SUPER_ADMIN' });

function request(date = '2026-09-25', mode: 'add' | 'replace' = 'add'): PayrollCorrectionRequest {
  return { holidays: [{ date, holidayType: 'national_holiday', name: 'Synthetic holiday', mode }],
  reason: 'Synthetic restore validation', paymentHandling: 'paid_adjustment' };
}

async function fixture(personalLeave = false) {
  const [employee] = await db.insert(schema.employees).values({ name: `${prefix}_employee`,
    idNumber: `${prefix}_${randomUUID()}`, employeeType: 'local' }).returning();
  const rows: TemporaryAttendance[] = personalLeave ? [{ id: 1, employeeId: employee.id,
    date: '2026-09-25', clockIn: '--:--', clockOut: '--:--', isHoliday: true,
    holidayType: 'personal_leave', isBarcodeScanned: false, holidayId: null, createdAt: null }] : [];
  const adjustment = calculateHolidayPayAdjustments(rows.map(row => ({ ...row,
    employeeId: row.employeeId ?? undefined, clockOut: row.clockOut ?? undefined })), 30000);
  const deductions = [{ name: 'Synthetic withholding', amount: 1000 }, ...adjustment.deductionItems];
  const totalDeductions = deductions.reduce((sum, item) => sum + item.amount, 0);
  const record = await salaryRepository.createSalaryRecord({ salaryYear: 2026, salaryMonth: 9,
    employeeId: employee.id, employeeName: employee.name, baseSalary: 30000,
    housingAllowance: 0, welfareAllowance: 0, totalOT1Hours: 0, totalOT2Hours: 0,
    totalOvertimePay: 0, holidayDays: 0, holidayDailySalary: 1000, totalHolidayPay: 0,
    grossSalary: 30000, netSalary: 30000 - totalDeductions, totalDeductions, deductions,
    allowances: [], attendanceData: rows });
  return { employee, record };
}

async function correct(record: SalaryRecord, input = request(), metadata = commitMetadata()) {
  return salaryRepository.commitSalaryCorrection(record.id, metadata, current => buildPayrollHolidayCorrection(current, input));
}

async function backup() {
  const id = await backups.createDatabaseBackup(backups.BackupType.MANUAL, 'Synthetic authoritative backup test');
  const inspection = backups.inspectBackupFile(id, backups.BackupType.MANUAL);
  expect(inspection.errors).toEqual([]);
  return { id, inspection, payload: JSON.parse(await readFile(inspection.path, 'utf8')) };
}

async function snapshot(connection = sql) {
  const output: Record<string, unknown> = {};
  for (const table of AUTHORITATIVE_BACKUP_TABLES) {
    const rows = await connection.unsafe(`select * from ${table.tableName} order by id`);
    // Existing Drizzle Date columns and JSON backups have millisecond precision.
    // Compare the app's supported precision while retaining all stored fields.
    output[table.payloadKey] = rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, typeof value === 'string' && /(?:_at|_until|_date)$/.test(key)
        ? value.replace(/(\d{2}:\d{2}:\d{2})(?:\.(\d+))?/, (_match, time, fraction = '') =>
          `${time}.${(fraction + '000').slice(0, 3)}`) : value])));
  }
  return canonical(output);
}

async function writeArtifact(payload: any) {
  const id = `synthetic_${randomUUID()}`;
  const filePath = path.join(process.env.APP_BACKUP_DIR!, 'manual', `${id}.json`);
  await writeFile(filePath, JSON.stringify(payload));
  return id;
}

async function adminSessions() {
  await sql.unsafe('CREATE TABLE user_sessions (sid text primary key, sess json NOT NULL, expire timestamp NOT NULL)');
  await sql`insert into user_sessions values ('synthetic-admin', ${JSON.stringify({ adminAuth: { role: 'SUPER_ADMIN' }, barcodeScanAuthorized: true })}::json, now()+interval '1 day'),
    ('synthetic-scan', ${JSON.stringify({ barcodeScanAuthorized: true })}::json, now()+interval '1 day'),
    ('synthetic-line', ${JSON.stringify({ lineUserId: 'synthetic-only' })}::json, now()+interval '1 day')`;
  await sql`insert into user_sessions values ('__payroll_restore_epoch__',
    ${JSON.stringify({ payrollRestoreEpoch: 'synthetic-epoch-before' })}::json, '2140-01-01')`;
}

async function sessionPrincipals() {
  return (await sql`select sid from user_sessions where sid <> '__payroll_restore_epoch__' order by sid`).map(row => row.sid);
}

async function restoreEpoch() {
  return (await sql`select sess->>'payrollRestoreEpoch' as epoch from user_sessions where sid='__payroll_restore_epoch__'`)[0]?.epoch;
}

describe('actual PostgreSQL authoritative payroll backup and restore', () => {
  it('exports journal, nullable retention link and idempotency evidence in authority v3', async () => {
    const { record } = await fixture();
    const metadata = commitMetadata();
    const corrected = await correct(record, request(), metadata);
    const retained = await fixture();
    const retentionJournal = await correct(retained.record);
    await db.delete(schema.salaryRecords).where(eq(schema.salaryRecords.id, retained.record.id));
    const { id, payload, inspection } = await backup();
    expect(inspection.counts.salaryCorrections).toBe(2);
    expect(inspection.journalCoverage).toBe('complete');
    expect(payload.metadata.authorityVersion).toBe(3);
    expect(payload.salaryCorrections.find((row: any) => row.id === corrected.correction.id))
      .toEqual(canonical(corrected.correction));
    expect(payload.salaryCorrections.find((row: any) => row.id === retentionJournal.correction.id))
      .toMatchObject({ salaryRecordId: null, originalRecordId: retained.record.id });
    expect(payload.salaryCorrections[0].idempotencyKey).toBe(metadata.idempotencyKey);
    const expected = await snapshot();
    await backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true });
    expect(await snapshot()).toEqual(expected);
  });

  it('restores all authority into a separate fresh DB and preserves replay and the next revision', async () => {
    const { record, employee } = await fixture();
    const metadata = commitMetadata();
    await correct(record, request(), metadata);
    await db.insert(schema.settings).values({ adminPin: 'synthetic-fixture-only', baseMonthSalary: 30000 });
    await db.insert(schema.pendingBindings).values({ employeeId: employee.id,
      lineUserId: 'synthetic-line-fixture', status: 'pending', requestedAt: new Date() });
    const [holiday] = await db.insert(schema.holidays).values({ employeeId: employee.id,
      date: '2026-09-25', name: 'Synthetic restore holiday', holidayType: 'national_holiday' }).returning();
    await db.insert(schema.temporaryAttendance).values({ employeeId: employee.id,
      date: '2026-09-25', clockIn: '--:--', clockOut: '--:--', isHoliday: true,
      holidayId: holiday.id, holidayType: 'national_holiday' });
    await db.insert(schema.calculationRules).values({ ruleKey: 'synthetic_restore_rule', version: '1',
      year: 2026, month: 9, employeeId: employee.id, totalOT1Hours: 0, totalOT2Hours: 0,
      baseSalary: 30000, totalOvertimePay: 0, grossSalary: 30000, netSalary: 29000 });
    await db.insert(schema.taiwanHolidays).values({ year: 2026, holidayDate: '2026-09-25',
      holidayName: 'Synthetic reference fixture' });
    const { id } = await backup();
    const expected = await snapshot();
    // Connection substitution only: every query and transaction runs on the
    // independently guarded second PostgreSQL database, never a mocked executor.
    const restoreTx = vi.spyOn(db, 'transaction').mockImplementation(freshDb.transaction.bind(freshDb));
    await backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true });
    restoreTx.mockRestore();
    expect(await snapshot(freshSql)).toEqual(expected);
    const impact = await backups.getRestorePreflight(id, backups.BackupType.MANUAL);
    expect(impact.replacedJournalRows).toBe(0);
    await backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true });
    expect(await snapshot()).toEqual(expected);
    const replay = await salaryRepository.commitSalaryCorrection(record.id, metadata, () => { throw new Error('Replay must not rebuild'); });
    expect(replay.replayed).toBe(true);
    const next = await correct(replay.record, request('2026-09-28'));
    expect(next.record.revision).toBe(2);
    expect(next.correction.id).toBeGreaterThan(replay.correction.id);
    expect(await salaryRepository.getSalaryCorrections(record.id)).toHaveLength(2);
  });

  it('previews monetary impact and refuses older journal state until the current explicit confirmation', async () => {
    const { record } = await fixture(true);
    const { id } = await backup();
    await correct(record, request('2026-09-25', 'replace'));
    const before = await snapshot();
    const impact = await backups.getRestorePreflight(id, backups.BackupType.MANUAL);
    expect(impact).toMatchObject({ replacedJournalRows: 1, requiresJournalConfirmation: true,
      payrollTotals: { before: { grossSalary: 30000, totalDeductions: 1000, netSalary: 29000 },
        after: { grossSalary: 30000, totalDeductions: 2000, netSalary: 28000 },
        delta: { grossSalary: 0, totalDeductions: 1000, netSalary: -1000 } } });
    await expect(backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true }))
      .rejects.toMatchObject({ status: 409, code: 'RESTORE_JOURNAL_CONFIRMATION_REQUIRED' });
    expect(await snapshot()).toEqual(before);
    await backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true,
      confirmJournalReplacement: true, confirmationToken: impact.confirmationToken });
    expect((await salaryRepository.getSalaryRecordById(record.id))?.revision).toBe(0);
    expect(await salaryRepository.getSalaryCorrections(record.id)).toHaveLength(0);
    const next = await correct((await salaryRepository.getSalaryRecordById(record.id))!, request('2026-09-25', 'replace'));
    expect(next.record.revision).toBe(1);
  });

  it('blocks a stale confirmation when another edit changes the target state', async () => {
    const { record } = await fixture();
    const { id } = await backup();
    await correct(record);
    const impact = await backups.getRestorePreflight(id, backups.BackupType.MANUAL);
    await db.update(schema.employees).set({ department: 'Synthetic concurrent edit' });
    const before = await snapshot();
    await expect(backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true,
      confirmJournalReplacement: true, confirmationToken: impact.confirmationToken }))
      .rejects.toMatchObject({ status: 409, code: 'RESTORE_STATE_CHANGED' });
    expect(await snapshot()).toEqual(before);
  });

  it('lists each changed salary when opposite adjustments cancel in aggregate, without employee details', async () => {
    const first = await fixture(), second = await fixture();
    const { id } = await backup();
    await db.update(schema.salaryRecords).set({ totalDeductions: 0, netSalary: 30000 }).where(eq(schema.salaryRecords.id, first.record.id));
    await db.update(schema.salaryRecords).set({ totalDeductions: 2000, netSalary: 28000 }).where(eq(schema.salaryRecords.id, second.record.id));
    const before = await snapshot();
    const impact = await backups.getRestorePreflight(id, backups.BackupType.MANUAL);
    expect(impact.payrollTotals.delta.netSalary).toBe(0);
    expect(impact.changedSalaryRecords).toHaveLength(2);
    expect(impact.changedSalaryRecords.map(row => row.delta.netSalary).sort((a, b) => a - b)).toEqual([-1000, 1000]);
    expect(impact.changedSalaryRecords.every(row => row.projectionChanged && !row.added && !row.deleted)).toBe(true);
    for (const row of impact.changedSalaryRecords) {
      expect(Object.keys(row).sort()).toEqual(['salaryRecordId', 'beforeRevision', 'afterRevision', 'before', 'after', 'delta',
        'projectionChanged', 'added', 'deleted'].sort());
    }
    expect(JSON.stringify(impact.changedSalaryRecords)).not.toContain(prefix);
    expect(await snapshot()).toEqual(before);
  });

  it('lists date/category corrections even when every stored monetary amount remains unchanged', async () => {
    const { record } = await fixture();
    const { id } = await backup();
    const initialImpact = await backups.getRestorePreflight(id, backups.BackupType.MANUAL);
    await db.update(schema.salaryRecords).set({ attendanceData: [{ id: -1, employeeId: record.employeeId,
      date: '2026-09-25', clockIn: '--:--', clockOut: '--:--', isHoliday: true,
      holidayType: 'national_holiday', isBarcodeScanned: false, holidayId: null, createdAt: null }] })
      .where(eq(schema.salaryRecords.id, record.id));
    const before = await snapshot();
    const impact = await backups.getRestorePreflight(id, backups.BackupType.MANUAL);
    expect(impact.payrollTotals.delta).toEqual({ grossSalary: 0, totalDeductions: 0, netSalary: 0 });
    expect(impact.changedSalaryRecords).toEqual([{ salaryRecordId: record.id, beforeRevision: 0, afterRevision: 0,
      before: { grossSalary: 30000, totalDeductions: 1000, netSalary: 29000 },
      after: { grossSalary: 30000, totalDeductions: 1000, netSalary: 29000 },
      delta: { grossSalary: 0, totalDeductions: 0, netSalary: 0 }, projectionChanged: true, added: false, deleted: false }]);
    expect(impact.confirmationToken).not.toBe(initialImpact.confirmationToken);
    expect(await snapshot()).toEqual(before);
  });

  it('identifies added and deleted salary projections when their aggregate totals cancel', async () => {
    const first = await fixture();
    const { id } = await backup();
    await db.delete(schema.salaryRecords).where(eq(schema.salaryRecords.id, first.record.id));
    const second = await fixture();
    const before = await snapshot();
    const impact = await backups.getRestorePreflight(id, backups.BackupType.MANUAL);
    expect(impact.payrollTotals.delta.netSalary).toBe(0);
    expect(impact.changedSalaryRecords).toMatchObject([
      { salaryRecordId: first.record.id, beforeRevision: null, afterRevision: 0, before: null,
        added: true, deleted: false, delta: { netSalary: 29000 } },
      { salaryRecordId: second.record.id, beforeRevision: 0, afterRevision: null, after: null,
        added: false, deleted: true, delta: { netSalary: -29000 } },
    ]);
    expect(await snapshot()).toEqual(before);
  });

  it('restores revision one over revision two explicitly, then records revision two again without collision', async () => {
    const { record } = await fixture();
    const first = await correct(record);
    const { id } = await backup();
    const second = await correct(first.record, request('2026-09-28'));
    const impact = await backups.getRestorePreflight(id, backups.BackupType.MANUAL);
    expect(impact.replacedJournalRows).toBe(1);
    await expect(backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true,
      confirmJournalReplacement: true })).rejects.toMatchObject({ code: 'RESTORE_JOURNAL_CONFIRMATION_REQUIRED' });
    await backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true,
      confirmJournalReplacement: true, confirmationToken: impact.confirmationToken });
    expect(await salaryRepository.getSalaryCorrections(record.id)).toHaveLength(1);
    const restored = (await salaryRepository.getSalaryRecordById(record.id))!;
    expect(restored.revision).toBe(1);
    const next = await correct(restored, request('2026-09-28'));
    expect(next.record.revision).toBe(2);
    expect(next.correction.id).toBeGreaterThan(second.correction.id);
    expect((await salaryRepository.getSalaryCorrections(record.id)).map(row => row.revision).sort()).toEqual([1, 2]);
  });

  it('accepts unrevised legacy v2 only without target journal and rejects legacy revised projections', async () => {
    const { record } = await fixture();
    const current = await backup();
    const legacy = structuredClone(current.payload);
    delete legacy.salaryCorrections;
    legacy.metadata.authorityVersion = 2;
    legacy.metadata.authoritativeTables = legacy.metadata.authoritativeTables.filter((name: string) => name !== 'salary_corrections');
    legacy.metadata.excludedTables = legacy.metadata.excludedTables.filter((table: any) => table.tableName !== 'monthly_salary_runs');
    const id = await writeArtifact(legacy);
    expect(backups.inspectBackupFile(id, backups.BackupType.MANUAL).errors).toEqual([]);
    await backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true });
    await db.update(schema.salaryRecords).set({ revision: 3 }).where(eq(schema.salaryRecords.id, record.id));
    const automatedState = await snapshot();
    await expect(backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true }))
      .rejects.toMatchObject({ code: 'LEGACY_BACKUP_JOURNAL_UNAVAILABLE' });
    expect(await snapshot()).toEqual(automatedState);
    await db.update(schema.salaryRecords).set({ revision: 0 }).where(eq(schema.salaryRecords.id, record.id));
    await correct((await salaryRepository.getSalaryRecordById(record.id))!);
    const before = await snapshot();
    await expect(backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true,
      confirmJournalReplacement: true })).rejects.toMatchObject({ code: 'LEGACY_BACKUP_JOURNAL_UNAVAILABLE' });
    expect(await snapshot()).toEqual(before);
    legacy.salaryRecords[0].revision = 1;
    const revisedId = await writeArtifact(legacy);
    expect(backups.inspectBackupFile(revisedId, backups.BackupType.MANUAL).errors.join(' ')).toContain('revised salary records');
    await expect(backups.restoreFromBackup(revisedId, backups.BackupType.MANUAL, { skipPreRestoreBackup: true }))
      .rejects.toMatchObject({ code: 'INVALID_RESTORE_BACKUP' });
  });

  it('does not invent continuous journals for projections advanced by historical automation', async () => {
    const { record } = await fixture();
    await db.update(schema.salaryRecords).set({ revision: 7 }).where(eq(schema.salaryRecords.id, record.id));
    const gapRecord = (await salaryRepository.getSalaryRecordById(record.id))!;
    await correct(gapRecord);
    const { id, inspection } = await backup();
    expect(inspection.errors).toEqual([]);
    expect((await salaryRepository.getSalaryCorrections(record.id))[0].revision).toBe(8);
    await backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true });
    expect((await salaryRepository.getSalaryRecordById(record.id))?.revision).toBe(8);
  });

  it.each(['duplicate', 'invalid-link', 'inconsistent-delta', 'invalid-created-at', 'invalid-transition'])('rejects %s journal artifacts without mutation', async kind => {
    const { record } = await fixture();
    await correct(record);
    const { payload } = await backup();
    if (kind === 'duplicate') payload.salaryCorrections.push({ ...payload.salaryCorrections[0], id: 9999 });
    if (kind === 'invalid-link') payload.salaryCorrections[0].salaryRecordId = 9999;
    if (kind === 'inconsistent-delta') payload.salaryCorrections[0].delta.netSalary = 42;
    if (kind === 'invalid-created-at') payload.salaryCorrections[0].createdAt = null;
    if (kind === 'invalid-transition') payload.salaryCorrections[0].beforeSnapshot.revision = -2;
    const id = await writeArtifact(payload);
    const before = await snapshot();
    await expect(backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true }))
      .rejects.toMatchObject({ code: 'INVALID_RESTORE_BACKUP' });
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back all table replacements and keeps administrator sessions when the journal insert fails', async () => {
    const { record } = await fixture();
    await correct(record);
    const { id } = await backup();
    await adminSessions();
    await db.update(schema.employees).set({ department: 'Synthetic live state' });
    const before = await snapshot();
    await sql.unsafe(`CREATE FUNCTION synthetic_fail_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic journal insert failure'; END $$`);
    await sql.unsafe('CREATE TRIGGER synthetic_fail_journal BEFORE INSERT ON salary_corrections FOR EACH ROW EXECUTE FUNCTION synthetic_fail_journal()');
    await expect(backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true })).rejects.toThrow('transaction could not be completed');
    expect(await snapshot()).toEqual(before);
    expect(await sessionPrincipals()).toEqual(['synthetic-admin', 'synthetic-line', 'synthetic-scan']);
    expect(await restoreEpoch()).toBe('synthetic-epoch-before');
  });

  it('invalidates administrator sessions atomically and preserves LINE/scan sessions; rehearsal rolls back', async () => {
    const { record } = await fixture();
    await correct(record);
    const { id } = await backup();
    await adminSessions();
    const before = await snapshot();
    const rehearsal = await backups.rehearseRestoreFromBackup(id, backups.BackupType.MANUAL);
    expect(rehearsal.backupCounts).toEqual(rehearsal.restoredCountsInTransaction);
    expect(rehearsal.backupCounts.salaryCorrections).toBe(1);
    expect(await snapshot()).toEqual(before);
    expect(await sessionPrincipals()).toHaveLength(3);
    expect(await restoreEpoch()).toBe('synthetic-epoch-before');
    await backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true });
    expect(await sessionPrincipals()).toEqual(['synthetic-line', 'synthetic-scan']);
    const firstEpoch = await restoreEpoch();
    expect(firstEpoch).toMatch(/^[a-f0-9-]{36}$/);
    await backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true });
    expect(await restoreEpoch()).not.toBe(firstEpoch);
  });

  it('rolls back restored payroll and journals if administrator-session invalidation fails', async () => {
    const { record } = await fixture();
    await correct(record);
    const { id } = await backup();
    await adminSessions();
    await db.update(schema.employees).set({ department: 'Synthetic state to preserve on failure' });
    const before = await snapshot();
    await sql.unsafe(`CREATE FUNCTION synthetic_fail_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic session deletion failure'; END $$`);
    await sql.unsafe('CREATE TRIGGER synthetic_fail_session_delete BEFORE DELETE ON user_sessions FOR EACH ROW EXECUTE FUNCTION synthetic_fail_session_delete()');
    try {
      await expect(backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true }))
        .rejects.toThrow('transaction could not be completed');
      expect(await snapshot()).toEqual(before);
      expect(await sessionPrincipals()).toEqual(['synthetic-admin', 'synthetic-line', 'synthetic-scan']);
      expect(await restoreEpoch()).toBe('synthetic-epoch-before');
    } finally {
      await sql.unsafe('DROP TRIGGER synthetic_fail_session_delete ON user_sessions');
      await sql.unsafe('DROP FUNCTION synthetic_fail_session_delete()');
    }
  });

  it('reads projection and journal from one repeatable-read snapshot during a concurrent correction', async () => {
    const { record } = await fixture();
    const originalTransaction = db.transaction.bind(db);
    let injected = false;
    const spy = vi.spyOn(db, 'transaction').mockImplementation(((callback: any, config: any) =>
      originalTransaction(async (tx: any) => {
        if (config?.accessMode !== 'read only') return callback(tx);
        const wrapped = new Proxy(tx, { get(target, key) {
          if (key !== 'select') return Reflect.get(target, key);
          return () => ({ from: async (table: any) => {
            const rows = await target.select().from(table);
            if (table === schema.salaryRecords && !injected) {
              injected = true;
              await correct(record);
            }
            return rows;
          } });
        } });
        return callback(wrapped);
      }, config)) as typeof db.transaction);
    const { id, payload } = await backup();
    spy.mockRestore();
    expect(injected).toBe(true);
    expect(payload.salaryRecords[0].revision).toBe(0);
    expect(payload.salaryCorrections).toEqual([]);
    expect((await salaryRepository.getSalaryRecordById(record.id))?.revision).toBe(1);
    expect(await salaryRepository.getSalaryCorrections(record.id)).toHaveLength(1);
    expect((await backups.getRestorePreflight(id, backups.BackupType.MANUAL)).replacedJournalRows).toBe(1);
  });

  it('retains optional AES-GCM encryption for complete journal artifacts', async () => {
    const { record } = await fixture();
    await correct(record);
    process.env.BACKUP_ENCRYPTION_KEY = 'synthetic-test-only-backup-key';
    const id = await backups.createDatabaseBackup(backups.BackupType.MANUAL);
    const inspection = backups.inspectBackupFile(id, backups.BackupType.MANUAL);
    expect(inspection.errors).toEqual([]);
    expect(inspection.counts.salaryCorrections).toBe(1);
    const envelope = JSON.parse(await readFile(inspection.path, 'utf8'));
    expect(envelope.salaryCorrections).toBeUndefined();
    expect(envelope.backupProtection.algorithm).toBe('aes-256-gcm');
    await backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true });
    expect(await salaryRepository.getSalaryCorrections(record.id)).toHaveLength(1);
  });

  it('runs required restore readiness and the real rehearsal CLI against an actual corrected backup', async () => {
    const { record } = await fixture();
    await correct(record);
    const { id } = await backup();
    const before = await snapshot();
    const root = process.cwd();
    const env = { ...process.env, LOG_LEVEL: 'info', TSX_TSCONFIG_PATH: path.join(root, 'tsconfig.json') };
    // The runner supplies an isolated environment; executing from its new temp
    // runtime also prevents the legacy CLI's dotenv loader from finding .env.
    const cli = path.join(root, 'node_modules/tsx/dist/cli.mjs');
    const check = spawnSync(process.execPath, [cli, path.join(root, 'server/scripts/restore-check.ts'), '--require-backup'],
      { cwd: process.env.APP_RUNTIME_DIR, env, encoding: 'utf8' });
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('Latest backup passed restore readiness checks.');
    expect(check.stdout).not.toContain('Skipping restore validation');
    const rehearsal = spawnSync(process.execPath, [cli, path.join(root, 'server/scripts/restore-rehearsal.ts'),
      '--backup-id', id, '--type', 'manual'], { cwd: process.env.APP_RUNTIME_DIR, env, encoding: 'utf8' });
    expect(rehearsal.status).toBe(0);
    const reports = path.join(process.env.APP_BACKUP_DIR!, 'restore-rehearsal', 'reports');
    const files = await readdir(reports);
    const report = JSON.parse(await readFile(path.join(reports, files[files.length - 1]), 'utf8'));
    expect(report.result.backupId).toBe(id);
    expect(report.result.backupCounts.salaryCorrections).toBe(1);
    expect(report.result.backupCounts).toEqual(report.result.restoredCountsInTransaction);
    expect(report.result.rehearsalRolledBack).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses direct production restores before any side effect unless payroll maintenance is active', async () => {
    const { record } = await fixture();
    await correct(record);
    const { id } = await backup();
    const before = await snapshot();
    const filesBefore = await readdir(path.join(process.env.APP_BACKUP_DIR!, 'manual'));
    const previousNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.PAYROLL_WRITES_PAUSED;
      await expect(backups.restoreFromBackup(id, backups.BackupType.MANUAL))
        .rejects.toMatchObject({ status: 409, code: 'RESTORE_REQUIRES_MAINTENANCE' });
      expect(await snapshot()).toEqual(before);
      expect(await readdir(path.join(process.env.APP_BACKUP_DIR!, 'manual'))).toEqual(filesBefore);
      process.env.PAYROLL_WRITES_PAUSED = 'true';
      await backups.restoreFromBackup(id, backups.BackupType.MANUAL, { skipPreRestoreBackup: true });
      expect(await snapshot()).toEqual(before);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      delete process.env.PAYROLL_WRITES_PAUSED;
    }
  });
});
