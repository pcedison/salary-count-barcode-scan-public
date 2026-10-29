import { randomUUID } from 'node:crypto';
import pg from 'pg';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@shared/schema';

const databaseProxy = vi.hoisted(() => ({ transaction: vi.fn() }));
// No import of server/db.ts or .env; this test exclusively owns its random DB.
vi.mock('../db', () => ({ db: databaseProxy }));
import { DatabaseLineClockInRepository } from './lineClockInRepository';
import { storage } from '../storage';
import { applyLineClockSchema, checkLineClockSchema } from '../../scripts/apply-line-clock-requests-schema.mjs';

const target = process.env.TEST_ATTENDANCE_DATABASE_URL;
const dbName = `line_clock_test_${randomUUID().replaceAll('-', '')}`;
const suite = target ? describe : describe.skip;

suite('LINE receipts — isolated loopback PostgreSQL (set TEST_ATTENDANCE_DATABASE_URL)', () => {
  let admin: pg.Client;
  let client: pg.Client;
  let sql1: ReturnType<typeof postgres>;
  let sql2: ReturnType<typeof postgres>;
  let repo: DatabaseLineClockInRepository;
  let peer: DatabaseLineClockInRepository;
  let now = new Date('2026-10-29T00:00:00.000Z');
  let createdDatabase = false;

  beforeAll(async () => {
    const url = new URL(target!);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) throw new Error('Refusing non-loopback database tests.');
    if (!/^line_clock_test_[0-9a-f]{32}$/.test(dbName)) throw new Error('Invalid isolated database name.');
    admin = new pg.Client({ connectionString: url.href, ssl: false });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    createdDatabase = true;
    url.pathname = `/${dbName}`;
    client = new pg.Client({ connectionString: url.href, ssl: false });
    await client.connect();
    await client.query(`CREATE TABLE employees (
      id serial PRIMARY KEY, name text NOT NULL, id_number text NOT NULL UNIQUE,
      is_encrypted boolean DEFAULT false, position text, department text, email text, phone text,
      active boolean DEFAULT true, employee_type text DEFAULT 'local', line_user_id text,
      line_display_name text, line_picture_url text, line_binding_date timestamptz,
      special_leave_days integer DEFAULT 0, special_leave_work_date_range text,
      special_leave_used_dates json DEFAULT '[]', special_leave_cash_days integer DEFAULT 0,
      special_leave_cash_month text, special_leave_notes text, deleted_at timestamptz,
      deleted_by text, purge_after_at timestamptz, created_at timestamp DEFAULT now()
    ); CREATE TABLE temporary_attendance (
      id serial PRIMARY KEY, employee_id integer, date text NOT NULL, clock_in text NOT NULL,
      clock_out text DEFAULT '', is_holiday boolean DEFAULT false, is_barcode_scanned boolean DEFAULT false,
      holiday_id integer, holiday_type text, created_at timestamp DEFAULT now()
    )`);
    sql1 = postgres(url.href, { ssl: false, prepare: false, max: 4, onnotice: () => undefined });
    sql2 = postgres(url.href, { ssl: false, prepare: false, max: 4, onnotice: () => undefined });
    const db1 = drizzle(sql1, { schema });
    const db2 = drizzle(sql2, { schema });
    databaseProxy.transaction.mockImplementation(db1.transaction.bind(db1));
    repo = new DatabaseLineClockInRepository(db1, () => now);
    peer = new DatabaseLineClockInRepository(db2, () => now);
    expect(await checkLineClockSchema(client)).toEqual({ ready: false, reason: 'missing-table' });
    expect(await applyLineClockSchema(client)).toMatchObject({ ready: true, applied: true });
  }, 20_000);

  beforeEach(async () => {
    vi.unstubAllEnvs();
    now = new Date('2026-10-29T00:00:00.000Z');
    await client.query('TRUNCATE line_clock_requests, temporary_attendance, employees RESTART IDENTITY CASCADE');
    await client.query(`INSERT INTO employees(name,id_number,line_user_id,department) VALUES
      ('Synthetic A','TEST-A','U-A','Test'),('Synthetic B','TEST-B','U-B','Test')`);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all([sql1?.end(), sql2?.end()]);
    await client?.end();
    if (createdDatabase && /^line_clock_test_[0-9a-f]{32}$/.test(dbName)) await admin.query(`DROP DATABASE "${dbName}"`);
    await admin?.end();
  });

  async function command(repository = repo, employeeId = 1, lineUserId = 'U-A') {
    const state = await repository.getState(employeeId, lineUserId);
    return { eventId: randomUUID(), stateVersion: state.stateVersion, clientTimestamp: now.toISOString() };
  }

  async function counts() {
    const result = await client.query(`SELECT (SELECT count(*)::int FROM temporary_attendance) AS attendance,
      (SELECT count(*)::int FROM line_clock_requests) AS receipts`);
    return result.rows[0];
  }

  it('requires explicit migration, verifies it idempotently and refuses incompatible existing tables', async () => {
    expect(await applyLineClockSchema(client)).toMatchObject({ ready: true, applied: false });
    await client.query("COMMENT ON TABLE line_clock_requests IS 'unknown-owner'");
    await expect(applyLineClockSchema(client)).rejects.toThrow('incompatible');
    const marker = await client.query("SELECT obj_description('line_clock_requests'::regclass) AS marker");
    expect(marker.rows[0].marker).toBe('unknown-owner');
    await client.query("COMMENT ON TABLE line_clock_requests IS 'barcode-scan:line-clock-requests:v1'");
    await client.query('ALTER TABLE line_clock_requests RENAME TO hidden_clock_requests');
    try { await expect(repo.getState(1, 'U-A')).rejects.toMatchObject({ status: 503, code: 'LINE_CLOCK_SCHEMA_REQUIRED' }); }
    finally { await client.query('ALTER TABLE hidden_clock_requests RENAME TO line_clock_requests'); }
    expect(await counts()).toEqual({ attendance: 0, receipts: 0 });
  });

  it('returns a valid server clock anchor without changing the attendance state version or receipt contract', async () => {
    const first = await repo.getState(1, 'U-A');
    expect(first.serverTimestamp).toBe(now.toISOString());
    expect(new Date(first.serverTimestamp).toISOString()).toBe(first.serverTimestamp);
    now = new Date(now.getTime() + 5000);
    const later = await repo.getState(1, 'U-A');
    expect(later.serverTimestamp).toBe(now.toISOString());
    expect(later.stateVersion).toBe(first.stateVersion);
    const accepted = await repo.submit(1, 'U-A', { eventId: randomUUID(), stateVersion: later.stateVersion, clientTimestamp: later.serverTimestamp });
    expect(accepted.receipt).not.toHaveProperty('serverTimestamp');
  });

  it('replays a committed event after a lost response, later clock-out, rename and five-minute expiry without toggling', async () => {
    const firstCommand = await command();
    const first = await repo.submit(1, 'U-A', firstCommand);
    expect(first).toMatchObject({ replayed: false, receipt: { action: 'clock-in', clockTime: '08:00', attendance: { clockOut: '' } } });
    now = new Date('2026-10-29T09:00:00.000Z');
    const out = await peer.submit(1, 'U-A', await command(peer));
    expect(out.receipt.action).toBe('clock-out');
    await client.query("UPDATE employees SET name='Renamed' WHERE id=1");
    const retry = await peer.submit(1, 'U-A', firstCommand);
    expect(retry).toEqual({ receipt: first.receipt, replayed: true });
    expect(await repo.getReceipt(1, 'U-A', firstCommand.eventId)).toEqual(first.receipt);
    expect(await counts()).toEqual({ attendance: 1, receipts: 2 });
    expect((await client.query('SELECT clock_out FROM temporary_attendance')).rows[0].clock_out).toBe('17:00');
  });

  it('serializes identical concurrent requests from independent connections into one receipt and one clock-in', async () => {
    const input = await command();
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? peer : repo).submit(1, 'U-A', input)));
    expect(results.filter(result => !result.replayed)).toHaveLength(1);
    for (const result of results) expect(result.receipt).toEqual(results[0].receipt);
    expect(await counts()).toEqual({ attendance: 1, receipts: 1 });
    expect((await client.query('SELECT clock_out FROM temporary_attendance')).rows[0].clock_out).toBe('');
  });

  it('accepts only one of different concurrent event IDs with the same state, for both clock-in and clock-out', async () => {
    for (const action of ['clock-in', 'clock-out']) {
      const input = await command();
      const results = await Promise.allSettled([repo.submit(1, 'U-A', input), peer.submit(1, 'U-A', { ...input, eventId: randomUUID() })]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ status: 409, code: 'LINE_CLOCK_STATE_CONFLICT' });
      const accepted = results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof repo.submit>>>;
      expect(accepted.value.receipt.action).toBe(action);
    }
    expect(await counts()).toEqual({ attendance: 1, receipts: 2 });
  });

  it('shares the barcode employee advisory lock: concurrent channels cannot create two clock-ins or toggle', async () => {
    const input = await command();
    const [line, barcode] = await Promise.allSettled([
      repo.submit(1, 'U-A', input),
      storage.upsertTemporaryAttendanceScan({ employeeId: 1, dateKey: '2026/10/29', time: '08:00', isHoliday: false, expectedAction: 'clockIn' }),
    ]);
    expect(barcode.status).toBe('fulfilled');
    if (line.status === 'rejected') expect(line.reason).toMatchObject({ code: 'LINE_CLOCK_STATE_CONFLICT' });
    else expect((barcode as PromiseFulfilledResult<any>).value.duplicate).toBe(true);
    const rows = await client.query('SELECT clock_in,clock_out FROM temporary_attendance');
    expect(rows.rows).toEqual([{ clock_in: '08:00', clock_out: '' }]);
    expect((await counts()).receipts).toBe(line.status === 'fulfilled' ? 1 : 0);
  });

  it('rejects payload changes, cross-account event reuse and stale identity versions without disclosing receipts', async () => {
    const input = await command();
    await repo.submit(1, 'U-A', input);
    await expect(repo.submit(1, 'U-A', { ...input, clientTimestamp: '2026-10-28T23:59:59Z' })).rejects.toMatchObject({ code: 'LINE_CLOCK_EVENT_CONFLICT' });
    const other = await command(peer, 2, 'U-B');
    await expect(peer.submit(2, 'U-B', { ...other, eventId: input.eventId })).rejects.toMatchObject({ code: 'LINE_CLOCK_EVENT_CONFLICT' });
    expect(await peer.getReceipt(2, 'U-B', input.eventId)).toBeUndefined();
    await expect(peer.submit(2, 'U-B', { ...input, eventId: randomUUID() })).rejects.toMatchObject({ code: 'LINE_CLOCK_STATE_CONFLICT' });
    await client.query("UPDATE employees SET line_user_id='U-new' WHERE id=1");
    expect(await repo.getReceipt(1, 'U-new', input.eventId)).toBeUndefined();
    await expect(repo.submit(1, 'U-new', input)).rejects.toMatchObject({ code: 'LINE_CLOCK_EVENT_CONFLICT' });
    expect(await counts()).toEqual({ attendance: 1, receipts: 1 });
  });

  it('detects changes to any same-day record, slash/dash dates, MVCC updates and midnight', async () => {
    await client.query(`INSERT INTO temporary_attendance(employee_id,date,clock_in,clock_out) VALUES
      (1,'2026-10-29','05:00','06:00'), (1,'2026/10/29','07:00','')`);
    const input = await command();
    await client.query('UPDATE temporary_attendance SET is_holiday=true WHERE id=1');
    await expect(repo.submit(1, 'U-A', input)).rejects.toMatchObject({ code: 'LINE_CLOCK_STATE_CONFLICT' });
    const after = await command();
    await client.query('UPDATE temporary_attendance SET is_holiday=is_holiday WHERE id=1');
    await expect(repo.submit(1, 'U-A', after)).rejects.toMatchObject({ code: 'LINE_CLOCK_STATE_CONFLICT' });
    const midnight = await command();
    now = new Date('2026-10-29T16:00:00Z');
    await expect(repo.submit(1, 'U-A', { ...midnight, clientTimestamp: now.toISOString() })).rejects.toMatchObject({ code: 'LINE_CLOCK_STATE_CONFLICT' });
    expect(await counts()).toEqual({ attendance: 2, receipts: 0 });
  });

  it('keeps the five-minute boundary, rejects future/expired new events and never writes invalid or legacy requests', async () => {
    const input = await command();
    for (const clientTimestamp of ['2026-10-28T23:54:59.999Z', '2026-10-29T00:00:00.001Z']) {
      await expect(repo.submit(1, 'U-A', { ...input, clientTimestamp })).rejects.toMatchObject({ code: 'LINE_CLOCK_TIMESTAMP_EXPIRED' });
    }
    await expect(repo.submit(1, 'U-A', {})).rejects.toMatchObject({ code: 'LINE_CLOCK_REQUEST_INVALID' });
    expect(await counts()).toEqual({ attendance: 0, receipts: 0 });
    const atBoundary = await repo.submit(1, 'U-A', { ...input, clientTimestamp: '2026-10-28T23:55:00Z' });
    expect(atBoundary.receipt.clockTime).toBe('07:55');
    now = new Date('2026-10-29T00:05:00Z');
    const state = await repo.getState(1, 'U-A');
    expect((await repo.submit(1, 'U-A', { eventId: randomUUID(), stateVersion: state.stateVersion })).receipt.clockTime).toBe('08:05');
  });

  it('rejects a still-fresh clock-out timestamp before clock-in, and rejects an invalid open-row time atomically', async () => {
    await repo.submit(1, 'U-A', await command());
    now = new Date('2026-10-29T00:03:00.000Z');
    const input = await command();
    await expect(repo.submit(1, 'U-A', { ...input, clientTimestamp: '2026-10-28T23:59:00.000Z' }))
      .rejects.toMatchObject({ status: 400, code: 'LINE_CLOCK_TIME_CONFLICT' });
    expect(await counts()).toEqual({ attendance: 1, receipts: 1 });
    expect(await repo.getReceipt(1, 'U-A', input.eventId)).toBeUndefined();
    expect((await client.query('SELECT clock_out FROM temporary_attendance')).rows[0].clock_out).toBe('');
    await client.query("UPDATE temporary_attendance SET clock_in='--:--'");
    await expect(repo.submit(1, 'U-A', await command())).rejects.toMatchObject({ code: 'LINE_CLOCK_TIME_CONFLICT' });
    expect(await counts()).toEqual({ attendance: 1, receipts: 1 });
    await client.query("UPDATE temporary_attendance SET clock_in='08:00'");
    expect((await repo.submit(1, 'U-A', await command())).receipt.clockTime).toBe('08:03');
  });

  it('rolls attendance back when saving the event receipt fails, then safely retries the same event', async () => {
    const input = await command();
    await client.query(`CREATE FUNCTION fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$;
      CREATE TRIGGER fail_receipt BEFORE INSERT ON line_clock_requests FOR EACH ROW EXECUTE FUNCTION fail_receipt()`);
    try { await expect(repo.submit(1, 'U-A', input)).rejects.toThrow(); }
    finally { await client.query('DROP TRIGGER fail_receipt ON line_clock_requests; DROP FUNCTION fail_receipt()'); }
    expect(await counts()).toEqual({ attendance: 0, receipts: 0 });
    expect(await repo.getReceipt(1, 'U-A', input.eventId)).toBeUndefined();
    expect((await repo.submit(1, 'U-A', input)).receipt.action).toBe('clock-in');
    expect(await counts()).toEqual({ attendance: 1, receipts: 1 });
  });

  it('rechecks inactive/deleted/unbound employees inside the transaction and honors paused writes', async () => {
    const input = await command();
    await client.query('UPDATE employees SET active=false WHERE id=1');
    await expect(repo.submit(1, 'U-A', input)).rejects.toMatchObject({ code: 'EMPLOYEE_INACTIVE' });
    await client.query('UPDATE employees SET active=true,deleted_at=now() WHERE id=1');
    await expect(repo.submit(1, 'U-A', input)).rejects.toMatchObject({ code: 'LINE_EMPLOYEE_NOT_BOUND' });
    await client.query('UPDATE employees SET deleted_at=null WHERE id=1');
    vi.stubEnv('PAYROLL_WRITES_PAUSED', 'true');
    await expect(repo.submit(1, 'U-A', input)).rejects.toMatchObject({ code: 'PAYROLL_WRITES_PAUSED' });
    expect(await counts()).toEqual({ attendance: 0, receipts: 0 });
    vi.unstubAllEnvs();
    const accepted = await repo.submit(1, 'U-A', input);
    vi.stubEnv('PAYROLL_WRITES_PAUSED', 'true');
    expect(await repo.submit(1, 'U-A', input)).toEqual({ receipt: accepted.receipt, replayed: true });
    expect(await counts()).toEqual({ attendance: 1, receipts: 1 });
  });
});
