import { createHash } from 'node:crypto';
import { and, eq, getTableColumns, isNull, or, sql } from 'drizzle-orm';

import { employees, lineClockRequests, temporaryAttendance, type TemporaryAttendance } from '@shared/schema';
import { normalizeDateToDash, normalizeDateToSlash } from '@shared/utils/specialLeaveSync';
import { db } from '../db';
import { assertPayrollWritesEnabled } from '../config/payrollWrites';
import { getLatestIncompleteAttendanceRecord, getTaiwanDateTimeParts } from '../routes/scan-helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^v1\.(\d{4}-\d{2}-\d{2})\.[0-9a-f]{64}$/;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type AttendanceVersionRow = TemporaryAttendance & { revision: string };

export interface LineClockState {
  success: true;
  dateKey: string;
  stateVersion: string;
  action: 'clock-in' | 'clock-out';
}

export interface LineClockReceipt extends LineClockState {
  eventId: string;
  employeeName: string;
  department: string | null;
  clockTime: string;
  timestamp: string;
  attendance: Omit<TemporaryAttendance, 'createdAt'> & { createdAt: string | null };
}

export interface LineClockCommand {
  eventId: string;
  stateVersion: string;
  clientTimestamp?: string;
}

export class LineClockError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function parseLineClockEventId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new LineClockError(400, 'LINE_CLOCK_REQUEST_INVALID', '請重新載入打卡頁面，再確認本次打卡。');
  }
  return value.toLowerCase();
}

export function parseLineClockCommand(value: unknown): LineClockCommand {
  const input = value as Partial<LineClockCommand> | null;
  const eventId = parseLineClockEventId(input?.eventId);
  if (typeof input?.stateVersion !== 'string' || !VERSION.test(input.stateVersion)) {
    throw new LineClockError(400, 'LINE_CLOCK_REQUEST_INVALID', '請重新載入打卡頁面，再確認本次打卡。');
  }
  if (input.clientTimestamp !== undefined &&
      (typeof input.clientTimestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.clientTimestamp) || !Number.isFinite(Date.parse(input.clientTimestamp)))) {
    throw new LineClockError(400, 'LINE_CLOCK_TIMESTAMP_INVALID', '打卡時間無效，請重新確認。');
  }
  if (input.clientTimestamp !== undefined) {
    const calendarDate = input.clientTimestamp.slice(0, 10);
    if (new Date(`${calendarDate}T00:00:00Z`).toISOString().slice(0, 10) !== calendarDate) {
      throw new LineClockError(400, 'LINE_CLOCK_TIMESTAMP_INVALID', '打卡日期無效，請重新確認。');
    }
  }
  return { eventId, stateVersion: input.stateVersion,
    ...(input.clientTimestamp === undefined ? {} : { clientTimestamp: new Date(input.clientTimestamp).toISOString() }) };
}

export function buildLineClockState(employeeId: number, dateKey: string, records: AttendanceVersionRow[], lineUserId: string): LineClockState {
  const normalizedDate = normalizeDateToDash(dateKey);
  const rows = [...records].sort((a, b) => a.id - b.id);
  return {
    success: true,
    dateKey: normalizeDateToSlash(dateKey),
    stateVersion: `v1.${normalizedDate}.${hash([employeeId, hash(lineUserId), normalizedDate, rows])}`,
    action: getLatestIncompleteAttendanceRecord(rows) ? 'clock-out' : 'clock-in',
  };
}

export class DatabaseLineClockInRepository {
  constructor(private readonly database: typeof db = db, private readonly now: () => Date = () => new Date()) {}

  private async withSchema<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      const cause = (error as { cause?: { code?: string } })?.cause ?? error;
      if ((cause as { code?: string })?.code === '42P01') {
        throw new LineClockError(503, 'LINE_CLOCK_SCHEMA_REQUIRED', '打卡服務尚未完成資料庫更新，請聯絡管理員。');
      }
      throw error;
    }
  }

  private async employee(tx: Transaction, employeeId: number, lineUserId: string) {
    // Same employee advisory lock as DatabaseStorage.upsertTemporaryAttendanceScan.
    // It also serializes midnight transitions across both attendance channels.
    await tx.execute(sql`select pg_advisory_xact_lock(918273, ${employeeId})`);
    const [employee] = await tx.select().from(employees).where(and(
      eq(employees.id, employeeId), eq(employees.lineUserId, lineUserId), isNull(employees.deletedAt),
    )).for('update');
    if (!employee) throw new LineClockError(404, 'LINE_EMPLOYEE_NOT_BOUND', '此 LINE 帳號尚未綁定員工。');
    if (!employee.active) throw new LineClockError(403, 'EMPLOYEE_INACTIVE', '停用員工無法打卡。');
    return employee;
  }

  private records(tx: Transaction, employeeId: number, dateKey: string) {
    return tx.select({ ...getTableColumns(temporaryAttendance), revision: sql<string>`${temporaryAttendance}.xmin::text` })
      .from(temporaryAttendance).where(and(eq(temporaryAttendance.employeeId, employeeId), or(
        eq(temporaryAttendance.date, normalizeDateToSlash(dateKey)),
        eq(temporaryAttendance.date, normalizeDateToDash(dateKey)),
      ))).for('update');
  }

  async getState(employeeId: number, lineUserId: string): Promise<LineClockState & { serverTimestamp: string }> {
    return this.withSchema(() => this.database.transaction(async tx => {
      await this.employee(tx, employeeId, lineUserId);
      // Fail closed before showing a confirmation if migration has not been applied.
      await tx.select({ eventId: lineClockRequests.eventId }).from(lineClockRequests).limit(0);
      const now = this.now();
      const { dateKey } = getTaiwanDateTimeParts(now);
      const state = buildLineClockState(employeeId, dateKey, await this.records(tx, employeeId, dateKey), lineUserId);
      return { ...state, serverTimestamp: now.toISOString() };
    }));
  }

  async getReceipt(employeeId: number, lineUserId: string, rawEventId: unknown): Promise<LineClockReceipt | undefined> {
    const eventId = parseLineClockEventId(rawEventId);
    return this.withSchema(() => this.database.transaction(async tx => {
      await this.employee(tx, employeeId, lineUserId);
      const [entry] = await tx.select().from(lineClockRequests).where(and(
        eq(lineClockRequests.eventId, eventId), eq(lineClockRequests.employeeId, employeeId),
        eq(lineClockRequests.lineUserHash, hash(lineUserId)),
      ));
      return entry?.receipt as LineClockReceipt | undefined;
    }));
  }

  async submit(employeeId: number, lineUserId: string, rawCommand: unknown): Promise<{ receipt: LineClockReceipt; replayed: boolean }> {
    const command = parseLineClockCommand(rawCommand);
    const payloadHash = hash([employeeId, lineUserId, command.stateVersion, command.clientTimestamp ?? null]);
    return this.withSchema(() => this.database.transaction(async tx => {
      // Global event lock makes a reused UUID from another employee deterministic too.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`line-clock-event:${command.eventId}`}, 0))`);
      const employee = await this.employee(tx, employeeId, lineUserId);
      const [entry] = await tx.select().from(lineClockRequests).where(eq(lineClockRequests.eventId, command.eventId));
      if (entry) {
        if (entry.employeeId !== employeeId || entry.payloadHash !== payloadHash || entry.lineUserHash !== hash(lineUserId)) {
          throw new LineClockError(409, 'LINE_CLOCK_EVENT_CONFLICT', '此打卡識別碼已用於不同內容，請先核對原紀錄。');
        }
        return { receipt: entry.receipt as LineClockReceipt, replayed: true };
      }
      assertPayrollWritesEnabled();
      const now = this.now();
      const clockBase = command.clientTimestamp === undefined ? now : new Date(command.clientTimestamp);
      const age = now.getTime() - clockBase.getTime();
      if (age < 0 || age > 5 * 60 * 1000) {
        throw new LineClockError(400, 'LINE_CLOCK_TIMESTAMP_EXPIRED', '本次打卡時間已過期或超前，請先核對紀錄再重新確認。');
      }
      const { dateKey, time, timestamp } = getTaiwanDateTimeParts(clockBase);
      const records = await this.records(tx, employeeId, dateKey);
      const state = buildLineClockState(employeeId, dateKey, records, lineUserId);
      if (command.stateVersion !== state.stateVersion) {
        throw new LineClockError(409, 'LINE_CLOCK_STATE_CONFLICT', '出勤狀態已變更，請重新載入並確認上班或下班。');
      }
      const incomplete = getLatestIncompleteAttendanceRecord(records);
      if (incomplete && (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(incomplete.clockIn) || time < incomplete.clockIn)) {
        throw new LineClockError(400, 'LINE_CLOCK_TIME_CONFLICT', '下班時間不可早於上班時間；請先核對原紀錄再重新確認。');
      }
      const [attendance] = incomplete
        ? await tx.update(temporaryAttendance).set({ clockOut: time }).where(eq(temporaryAttendance.id, incomplete.id)).returning()
        : await tx.insert(temporaryAttendance).values({ employeeId, date: dateKey, clockIn: time, clockOut: '', isHoliday: false, isBarcodeScanned: true }).returning();
      if (!attendance) throw new Error('Unable to persist LINE attendance');
      const receipt: LineClockReceipt = {
        ...state, eventId: command.eventId, employeeName: employee.name, department: employee.department,
        clockTime: time, timestamp,
        attendance: { ...attendance, createdAt: attendance.createdAt?.toISOString() ?? null },
      };
      await tx.insert(lineClockRequests).values({
        eventId: command.eventId, employeeId, lineUserHash: hash(lineUserId), payloadHash,
        dateKey, stateVersion: command.stateVersion, receipt,
      });
      return { receipt, replayed: false };
    }));
  }
}

export const lineClockInRepository = new DatabaseLineClockInRepository();
