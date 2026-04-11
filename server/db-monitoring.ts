/**
 * Database monitoring, backup, and restore helpers.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { sql } from 'drizzle-orm';
import { db } from './db';
import { storage } from './storage';
import * as schema from '@shared/schema';
import {
  AUTHORITATIVE_BACKUP_PAYLOAD_KEYS,
  AUTHORITATIVE_BACKUP_TABLES,
  AUTHORITATIVE_RESTORE_DELETE_ORDER,
  AUTHORITATIVE_RESTORE_INSERT_ORDER,
  AUTHORITATIVE_SEQUENCE_TABLES,
  AUTHORITATIVE_TABLE_NAMES,
  BACKUP_AUTHORITY_VERSION,
  EXCLUDED_BACKUP_TABLES,
  EXCLUDED_TABLE_NAMES,
  type AuthoritativeBackupPayloadKey,
  type DatabaseCountKey
} from './backup-authority';
import {
  SALARY_RETENTION_POLICY,
  SALARY_RETENTION_YEARS
} from './config/retentionPolicy';
import { ensureBackupRootDirExists, getBackupRootDir } from './config/runtimePaths';
import { createLogger } from './utils/logger';

const log = createLogger('db-monitor');

function getBackupDir(): string {
  return getBackupRootDir();
}

function getDailyBackupDir(): string {
  return path.join(getBackupDir(), 'daily');
}

function getWeeklyBackupDir(): string {
  return path.join(getBackupDir(), 'weekly');
}

function getMonthlyBackupDir(): string {
  return path.join(getBackupDir(), 'monthly');
}

function getManualBackupDir(): string {
  return path.join(getBackupDir(), 'manual');
}
const BACKUP_FILE_MODE = 0o600;
const BACKUP_DIR_MODE = 0o700;
const BACKUP_PROTECTION_FORMAT = 'backup-protected-v1';
const BACKUP_KEY_DERIVATION_ITERATIONS = 210_000;

type ProtectedBackupEnvelope = {
  backupProtection: {
    format: typeof BACKUP_PROTECTION_FORMAT;
    algorithm: 'aes-256-gcm';
    keyDerivation: 'pbkdf2-sha256';
    salt: string;
    iv: string;
    authTag: string;
    ciphertext: string;
    createdAt: string;
  };
};

function getBackupEncryptionKey(): string | null {
  const backupKey = process.env.BACKUP_ENCRYPTION_KEY?.trim();
  if (backupKey) {
    return backupKey;
  }

  const encryptionKey = process.env.ENCRYPTION_KEY?.trim();
  return encryptionKey ? encryptionKey : null;
}

function isProtectedBackupEnvelope(value: unknown): value is ProtectedBackupEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const protection = (value as ProtectedBackupEnvelope).backupProtection;

  return Boolean(
    protection &&
    protection.format === BACKUP_PROTECTION_FORMAT &&
    protection.algorithm === 'aes-256-gcm' &&
    protection.keyDerivation === 'pbkdf2-sha256' &&
    typeof protection.salt === 'string' &&
    typeof protection.iv === 'string' &&
    typeof protection.authTag === 'string' &&
    typeof protection.ciphertext === 'string' &&
    typeof protection.createdAt === 'string'
  );
}

function deriveBackupKey(secret: string, salt: string): Buffer {
  return crypto.pbkdf2Sync(secret, salt, BACKUP_KEY_DERIVATION_ITERATIONS, 32, 'sha256');
}

function encryptBackupPayload(rawPayload: string): string {
  const backupKey = getBackupEncryptionKey();

  if (!backupKey) {
    return rawPayload;
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveBackupKey(backupKey, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(rawPayload, 'utf8'), cipher.final()]).toString('base64');
  const authTag = cipher.getAuthTag().toString('base64');

  const envelope: ProtectedBackupEnvelope = {
    backupProtection: {
      format: BACKUP_PROTECTION_FORMAT,
      algorithm: 'aes-256-gcm',
      keyDerivation: 'pbkdf2-sha256',
      salt,
      iv: iv.toString('base64'),
      authTag,
      ciphertext,
      createdAt: new Date().toISOString()
    }
  };

  return JSON.stringify(envelope, null, 2);
}

function decryptBackupPayload(rawBackup: string): string {
  const parsed = JSON.parse(rawBackup) as unknown;

  if (!isProtectedBackupEnvelope(parsed)) {
    return rawBackup;
  }

  const backupKey = getBackupEncryptionKey();
  if (!backupKey) {
    throw new Error('This backup is encrypted but no backup encryption key is configured');
  }

  const { salt, iv, authTag, ciphertext } = parsed.backupProtection;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveBackupKey(backupKey, salt),
    Buffer.from(iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final()
  ]);

  return plaintext.toString('utf8');
}

function serializeBackupPayload(data: BackupPayload): string {
  return encryptBackupPayload(JSON.stringify(data, null, 2));
}

export function validateBackupId(backupId: string): string {
  const normalized = backupId.trim();

  if (!normalized) {
    throw new Error('Backup id is required');
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
    throw new Error('Backup id contains invalid path characters');
  }

  return normalized;
}

async function ensureBackupDirectories(): Promise<void> {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
    return;
  }

  await ensureBackupRootDirExists();
  await Promise.all([
    fs.promises.mkdir(getDailyBackupDir(), { recursive: true, mode: BACKUP_DIR_MODE }),
    fs.promises.mkdir(getWeeklyBackupDir(), { recursive: true, mode: BACKUP_DIR_MODE }),
    fs.promises.mkdir(getMonthlyBackupDir(), { recursive: true, mode: BACKUP_DIR_MODE }),
    fs.promises.mkdir(getManualBackupDir(), { recursive: true, mode: BACKUP_DIR_MODE })
  ]);
}

const AUTO_DAILY_BACKUP_INTERVAL = 24 * 60 * 60 * 1000; // 1 day
const AUTO_WEEKLY_BACKUP_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 1 week
const AUTO_MONTHLY_BACKUP_INTERVAL = 30 * 24 * 60 * 60 * 1000; // ~1 month
const MAX_BACKUPS_PER_CATEGORY = 7; // Keep a small retention window.
const AUTO_BACKUP_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

interface ConnectionStatus {
  isConnected: boolean;
  timestamp: number;
  error?: string;
}

// Rolling status cache for connectivity checks.
let connectionHistory: ConnectionStatus[] = [];
let lastNotificationTime = 0;
const NOTIFICATION_INTERVAL = 5 * 60 * 1000; // 5 minutes
let monitoringTimer: NodeJS.Timeout | null = null;
let monitoringIntervalMs: number | null = null;
let automaticBackupTimer: NodeJS.Timeout | null = null;

type BackupTimestamps = {
  daily: number;
  weekly: number;
  monthly: number;
};

let automaticBackupTimestamps: BackupTimestamps | null = null;

type BackupPayload = {
  metadata?: {
    timestamp?: string;
    type?: string;
    description?: string;
    version?: string;
    databaseType?: string;
    authorityVersion?: number;
    authoritativeTables?: string[];
    excludedTables?: Array<{ tableName?: string; reason?: string }>;
  };
  employees?: typeof schema.employees.$inferSelect[];
  settings?: typeof schema.settings.$inferSelect | null;
  holidays?: typeof schema.holidays.$inferSelect[];
  pendingBindings?: typeof schema.pendingBindings.$inferSelect[];
  salaryRecords?: typeof schema.salaryRecords.$inferSelect[];
  temporaryAttendance?: typeof schema.temporaryAttendance.$inferSelect[];
  calculationRules?: typeof schema.calculationRules.$inferSelect[];
  taiwanHolidays?: typeof schema.taiwanHolidays.$inferSelect[];
};

type BackupListEntry = {
  id: string;
  timestamp: number;
  fileName: string;
  size: number;
  type: BackupType;
  path: string;
};

type NormalizedBackupPayload = {
  metadata: BackupPayload['metadata'] | null;
  employees: typeof schema.employees.$inferSelect[];
  settings: typeof schema.settings.$inferSelect | null;
  holidays: typeof schema.holidays.$inferSelect[];
  pendingBindings: typeof schema.pendingBindings.$inferSelect[];
  salaryRecords: typeof schema.salaryRecords.$inferSelect[];
  temporaryAttendance: typeof schema.temporaryAttendance.$inferSelect[];
  calculationRules: typeof schema.calculationRules.$inferSelect[];
  taiwanHolidays: typeof schema.taiwanHolidays.$inferSelect[];
};

export type BackupInspection = {
  backupId: string;
  backupType: BackupType | 'unknown';
  path: string;
  metadata: BackupPayload['metadata'] | null;
  counts: DatabaseCounts;
  authority: {
    version: number;
    authoritativeTables: string[];
    excludedTables: Array<{ tableName: string; reason: string }>;
  };
  restoreOrder: string[];
  errors: string[];
  warnings: string[];
};

type RestoreExecutor = Pick<typeof db, 'delete' | 'insert' | 'execute'>;
type CountExecutor = Pick<typeof db, 'execute'>;

const ANONYMIZED_EMPLOYEE_NAME = '[ANONYMIZED EMPLOYEE - RETAIN 5 YEARS]';

export type DatabaseCounts = {
  employees: number;
  hasSettings: boolean;
  pendingBindings: number;
  holidays: number;
  salaryRecords: number;
  temporaryAttendance: number;
  calculationRules: number;
  taiwanHolidays: number;
};

export type RestoreRehearsalResult = {
  backupId: string;
  backupType: BackupType | 'unknown';
  path: string;
  metadata: BackupPayload['metadata'] | null;
  warnings: string[];
  restoreOrder: string[];
  backupCounts: DatabaseCounts;
  liveCountsBefore: DatabaseCounts;
  restoredCountsInTransaction: DatabaseCounts;
  rehearsalRolledBack: true;
};

type RestoreFromBackupOptions = {
  skipPreRestoreBackup?: boolean;
};

const RESTORE_TRANSACTION_MAX_ATTEMPTS = 3;
const RESTORE_TRANSACTION_RETRY_CODES = new Set(['40P01', '40001']);

class RestoreRehearsalRollback extends Error {
  readonly result: RestoreRehearsalResult;

  constructor(result: RestoreRehearsalResult) {
    super('RESTORE_REHEARSAL_ROLLBACK');
    this.name = 'RestoreRehearsalRollback';
    this.result = result;
  }
}

async function loadAuthoritativeBackupValue(payloadKey: AuthoritativeBackupPayloadKey) {
  switch (payloadKey) {
    case 'employees':
      return storage.getAllEmployeesIncludingDeleted();
    case 'settings':
      return (await storage.getSettings()) ?? null;
    case 'pendingBindings':
      return db.select().from(schema.pendingBindings);
    case 'holidays':
      return storage.getAllHolidays();
    case 'salaryRecords':
      return storage.getAllSalaryRecords();
    case 'temporaryAttendance':
      return storage.getTemporaryAttendance();
    case 'calculationRules':
      return db.select().from(schema.calculationRules);
    case 'taiwanHolidays':
      return db.select().from(schema.taiwanHolidays);
  }
}

function getRetryableRestoreErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const value = error as { code?: unknown; cause?: { code?: unknown } };
  const code = typeof value.code === 'string' ? value.code : value.cause?.code;
  return typeof code === 'string' ? code : null;
}

function isRetryableRestoreTransactionError(error: unknown): boolean {
  const code = getRetryableRestoreErrorCode(error);
  return code !== null && RESTORE_TRANSACTION_RETRY_CODES.has(code);
}

async function runRestoreTransaction<T>(
  operationLabel: string,
  callback: Parameters<typeof db.transaction>[0]
): Promise<T> {
  for (let attempt = 1; attempt <= RESTORE_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await db.transaction(callback) as T;
    } catch (error) {
      if (
        !isRetryableRestoreTransactionError(error) ||
        attempt === RESTORE_TRANSACTION_MAX_ATTEMPTS
      ) {
        throw error;
      }

      const code = getRetryableRestoreErrorCode(error);
      log.warn(`${operationLabel} hit retryable transaction error; retrying`, {
        attempt,
        code
      });
      await new Promise((resolve) => setTimeout(resolve, attempt * 50));
    }
  }

  throw new Error(`${operationLabel} failed before starting a transaction`);
}

/**
 * Check whether the database is reachable.
 */
export async function checkDatabaseConnection(): Promise<ConnectionStatus> {
  const timestamp = Date.now();
  let status: ConnectionStatus = { isConnected: false, timestamp };

  try {
    await db.execute('SELECT 1');
    status = { isConnected: true, timestamp };
  } catch (error) {
    status = {
      isConnected: false,
      timestamp,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  // Append the latest status to the rolling history.
  connectionHistory.push(status);

  // Keep only the most recent 30 samples.
  if (connectionHistory.length > 30) {
    connectionHistory = connectionHistory.slice(-30);
  }

  return status;
}

/**
 * Start the database connectivity monitor.
 */
export function startMonitoring(interval = 60000) {
  if (monitoringTimer) {
    if (monitoringIntervalMs !== interval) {
      log.warn(
        `Monitoring timer already active with different interval: existing=${monitoringIntervalMs}ms, requested=${interval}ms`
      );
    } else {
      log.info('Monitoring timer already active; reusing existing timer');
    }

    return monitoringTimer;
  }

  log.info('Starting monitoring timer', interval, 'ms');
  monitoringIntervalMs = interval;

  // Run one immediate check before the interval loop starts.
  checkDatabaseConnection().then(status => {
    log.info('Monitoring check completed', status.isConnected ? 'connected' : 'disconnected', status.error || '');
  });

  // Periodically verify connectivity.
  monitoringTimer = setInterval(async () => {
    const status = await checkDatabaseConnection();

    // Alert when the connection has been unhealthy for too long.
    if (!status.isConnected && Date.now() - lastNotificationTime > NOTIFICATION_INTERVAL) {
      log.error('Database connection check failed', status.error);
      lastNotificationTime = Date.now();
    }
  }, interval);

  return monitoringTimer;
}

/**
 * Stop the monitoring timer.
 */
export function stopMonitoring(timerId?: NodeJS.Timeout) {
  const targetTimer = timerId ?? monitoringTimer;

  if (!targetTimer) {
    return;
  }

  clearInterval(targetTimer);

  if (!timerId || targetTimer === monitoringTimer) {
    monitoringTimer = null;
    monitoringIntervalMs = null;
  }

  log.info('Stopped database connectivity monitor');
}

/**
 * Return the recent connectivity history.
 */
export function getConnectionHistory() {
  return connectionHistory;
}

function createInitialBackupTimestamps(): BackupTimestamps {
  const resolveLatestBackupTimestamp = (backupDir: string): number => {
    if (!fs.existsSync(backupDir)) {
      return 0;
    }

    let latestTimestamp = 0;

    for (const fileName of fs.readdirSync(backupDir).filter((file) => file.endsWith('.json'))) {
      const filePath = path.join(backupDir, fileName);

      try {
        const statTimestamp = fs.statSync(filePath).mtime.getTime();
        let resolvedTimestamp = statTimestamp;
        const rawBackup = fs.readFileSync(filePath, 'utf8');
        const { inspection } = parseBackupPayloadFromRaw(rawBackup, filePath, {
          backupId: fileName.replace(/\.json$/, ''),
          backupType: 'unknown'
        });
        const metadataTimestamp = inspection.metadata?.timestamp;

        if (typeof metadataTimestamp === 'string') {
          const parsedTimestamp = new Date(metadataTimestamp).getTime();

          if (Number.isFinite(parsedTimestamp)) {
            resolvedTimestamp = parsedTimestamp;
          }
        }

        latestTimestamp = Math.max(latestTimestamp, resolvedTimestamp);
      } catch (error) {
        log.warn(`Failed to inspect backup file: ${filePath}`, error);
      }
    }

    return latestTimestamp;
  };

  return {
    daily: resolveLatestBackupTimestamp(getDailyBackupDir()),
    weekly: resolveLatestBackupTimestamp(getWeeklyBackupDir()),
    monthly: resolveLatestBackupTimestamp(getMonthlyBackupDir())
  };
}

function normalizeRecordArray<T>(value: unknown, label: string): T[] {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Expected array value for ${label}`);
  }

  return value as T[];
}

function normalizeOptionalObject<T extends object>(value: unknown, label: string): T | null {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected object value for ${label}`);
  }

  return value as T;
}

function normalizeTimestampValue<T>(value: T): T | Date | null {
  if (value == null || value instanceof Date) {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const parsedDate = new Date(value);
  return Number.isNaN(parsedDate.getTime()) ? value : parsedDate;
}

function getSchemaTableByPayloadKey(payloadKey: AuthoritativeBackupPayloadKey) {
  switch (payloadKey) {
    case 'employees':
      return schema.employees;
    case 'settings':
      return schema.settings;
    case 'pendingBindings':
      return schema.pendingBindings;
    case 'holidays':
      return schema.holidays;
    case 'salaryRecords':
      return schema.salaryRecords;
    case 'temporaryAttendance':
      return schema.temporaryAttendance;
    case 'calculationRules':
      return schema.calculationRules;
    case 'taiwanHolidays':
      return schema.taiwanHolidays;
  }
}

function getTableNameForPayloadKey(payloadKey: AuthoritativeBackupPayloadKey): string {
  const table = AUTHORITATIVE_BACKUP_TABLES.find((entry) => entry.payloadKey === payloadKey);

  if (!table) {
    throw new Error(`Unknown backup authority payload key: ${payloadKey}`);
  }

  return table.tableName;
}

function getPayloadTableCount(payload: NormalizedBackupPayload, payloadKey: AuthoritativeBackupPayloadKey): number {
  switch (payloadKey) {
    case 'employees':
      return payload.employees.length;
    case 'settings':
      return payload.settings ? 1 : 0;
    case 'pendingBindings':
      return payload.pendingBindings.length;
    case 'holidays':
      return payload.holidays.length;
    case 'salaryRecords':
      return payload.salaryRecords.length;
    case 'temporaryAttendance':
      return payload.temporaryAttendance.length;
    case 'calculationRules':
      return payload.calculationRules.length;
    case 'taiwanHolidays':
      return payload.taiwanHolidays.length;
  }
}

function assignDatabaseCount(
  counts: DatabaseCounts,
  countKey: DatabaseCountKey,
  count: number,
  countMode: 'rows' | 'presence'
): void {
  if (countKey === 'hasSettings') {
    counts.hasSettings = countMode === 'presence' ? count > 0 : Boolean(count);
    return;
  }

  counts[countKey] = count;
}

function buildPayloadCounts(payload: NormalizedBackupPayload): DatabaseCounts {
  const counts: DatabaseCounts = {
    employees: 0,
    hasSettings: false,
    pendingBindings: 0,
    holidays: 0,
    salaryRecords: 0,
    temporaryAttendance: 0,
    calculationRules: 0,
    taiwanHolidays: 0
  };

  for (const table of AUTHORITATIVE_BACKUP_TABLES) {
    const count = getPayloadTableCount(payload, table.payloadKey);
    assignDatabaseCount(counts, table.countKey, count, table.countMode);
  }

  return counts;
}

function collectAuthorityMetadataIssues(
  rawPayload: BackupPayload,
  normalizedPayload: NormalizedBackupPayload,
  errors: string[],
  warnings: string[]
): void {
  const rawKeys = Object.keys(rawPayload);
  const allowedKeys = new Set<string>(['metadata', ...AUTHORITATIVE_BACKUP_PAYLOAD_KEYS]);
  const unexpectedKeys = rawKeys.filter((key) => !allowedKeys.has(key)).sort();
  const missingPayloadKeys = AUTHORITATIVE_BACKUP_PAYLOAD_KEYS.filter((payloadKey) => !(payloadKey in rawPayload));

  if (unexpectedKeys.length > 0) {
    errors.push(`Unexpected backup payload keys: ${unexpectedKeys.join(', ')}`);
  }

  if (missingPayloadKeys.length > 0) {
    errors.push(`Backup payload is missing authoritative tables: ${missingPayloadKeys.join(', ')}`);
  }

  if (!normalizedPayload.metadata?.authorityVersion) {
    warnings.push('Backup metadata is missing authorityVersion; treat as legacy artifact.');
  } else if (normalizedPayload.metadata.authorityVersion !== BACKUP_AUTHORITY_VERSION) {
    errors.push(
      `Backup authorityVersion mismatch: expected ${BACKUP_AUTHORITY_VERSION}, received ${normalizedPayload.metadata.authorityVersion}`
    );
  }

  if (!normalizedPayload.metadata?.authoritativeTables) {
    warnings.push('Backup metadata is missing authoritativeTables.');
  } else {
    const actual = [...normalizedPayload.metadata.authoritativeTables].sort();
    const expected = [...AUTHORITATIVE_TABLE_NAMES].sort();

    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(
        `Backup authoritativeTables mismatch: expected ${expected.join(', ')}, received ${actual.join(', ')}`
      );
    }
  }

  if (!normalizedPayload.metadata?.excludedTables) {
    warnings.push('Backup metadata is missing excludedTables.');
  } else {
    const actualExcluded = normalizedPayload.metadata.excludedTables
      .map((entry) => entry.tableName)
      .filter((tableName): tableName is string => typeof tableName === 'string')
      .sort();
    const expectedExcluded = [...EXCLUDED_TABLE_NAMES].sort();

    if (JSON.stringify(actualExcluded) !== JSON.stringify(expectedExcluded)) {
      errors.push(
        `Backup excludedTables mismatch: expected ${expectedExcluded.join(', ')}, received ${actualExcluded.join(', ')}`
      );
    }
  }
}

function normalizeBackupPayload(payload: unknown): NormalizedBackupPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Backup payload must be a non-array object');
  }

  const parsed = payload as BackupPayload;

  return {
    metadata: normalizeOptionalObject<NonNullable<BackupPayload['metadata']>>(parsed.metadata, 'metadata'),
    employees: normalizeRecordArray<typeof schema.employees.$inferSelect>(parsed.employees, 'employees').map((employee) => ({
      ...employee,
      createdAt: normalizeTimestampValue(employee.createdAt),
      lineBindingDate: normalizeTimestampValue(employee.lineBindingDate),
      deletedAt: normalizeTimestampValue(employee.deletedAt),
      purgeAfterAt: normalizeTimestampValue(employee.purgeAfterAt)
    })),
    settings: (() => {
      const normalizedSettings = normalizeOptionalObject<typeof schema.settings.$inferSelect>(parsed.settings, 'settings');

      if (!normalizedSettings) {
        return null;
      }

      return {
        ...normalizedSettings,
        updatedAt: normalizeTimestampValue(normalizedSettings.updatedAt)
      };
    })(),
    holidays: normalizeRecordArray<typeof schema.holidays.$inferSelect>(parsed.holidays, 'holidays').map((holiday) => ({
      ...holiday,
      createdAt: normalizeTimestampValue(holiday.createdAt)
    })),
    pendingBindings: normalizeRecordArray<typeof schema.pendingBindings.$inferSelect>(
      parsed.pendingBindings,
      'pendingBindings'
    ).map((binding) => ({
      ...binding,
      requestedAt: normalizeTimestampValue(binding.requestedAt),
      reviewedAt: normalizeTimestampValue(binding.reviewedAt)
    })),
    salaryRecords: normalizeRecordArray<typeof schema.salaryRecords.$inferSelect>(
      parsed.salaryRecords,
      'salaryRecords'
    ).map((salaryRecord) => ({
      ...salaryRecord,
      createdAt: normalizeTimestampValue(salaryRecord.createdAt),
      anonymizedAt: normalizeTimestampValue(salaryRecord.anonymizedAt),
      retentionUntil: normalizeTimestampValue(salaryRecord.retentionUntil)
    })),
    temporaryAttendance: normalizeRecordArray<typeof schema.temporaryAttendance.$inferSelect>(
      parsed.temporaryAttendance,
      'temporaryAttendance'
    ).map((attendance) => ({
      ...attendance,
      createdAt: normalizeTimestampValue(attendance.createdAt)
    })),
    calculationRules: normalizeRecordArray<typeof schema.calculationRules.$inferSelect>(
      parsed.calculationRules,
      'calculationRules'
    ).map((rule) => ({
      ...rule,
      createdAt: normalizeTimestampValue(rule.createdAt),
      updatedAt: normalizeTimestampValue(rule.updatedAt)
    })),
    taiwanHolidays: normalizeRecordArray<typeof schema.taiwanHolidays.$inferSelect>(
      parsed.taiwanHolidays,
      'taiwanHolidays'
    ).map((holiday) => ({
      ...holiday,
      createdAt: normalizeTimestampValue(holiday.createdAt)
    }))
  };
}

function collectDuplicateIds<T extends { id?: number | null }>(
  rows: T[],
  label: string,
  target: string[]
): void {
  const seen = new Set<number>();
  const duplicates = new Set<number>();

  for (const row of rows) {
    if (typeof row.id !== 'number') {
      continue;
    }

    if (seen.has(row.id)) {
      duplicates.add(row.id);
      continue;
    }

    seen.add(row.id);
  }

  if (duplicates.size > 0) {
    target.push(`${label} contains duplicate IDs: ${Array.from(duplicates).sort((left, right) => left - right).join(', ')}`);
  }
}

function collectDuplicateComparableIds<T extends { id?: number | string | null }>(
  rows: T[],
  label: string,
  target: string[]
): void {
  const seen = new Set<number | string>();
  const duplicates = new Set<number | string>();

  for (const row of rows) {
    if (typeof row.id !== 'number' && typeof row.id !== 'string') {
      continue;
    }

    if (seen.has(row.id)) {
      duplicates.add(row.id);
      continue;
    }

    seen.add(row.id);
  }

  if (duplicates.size > 0) {
    target.push(`${label} contains duplicate ids: ${Array.from(duplicates).sort().join(', ')}`);
  }
}

function collectMissingReferences(
  ids: Array<number | null | undefined>,
  existingIds: Set<number>,
  label: string,
  target: string[]
): void {
  const missingIds = Array.from(
    new Set(ids.filter((id): id is number => typeof id === 'number' && !existingIds.has(id)))
  ).sort((left, right) => left - right);

  if (missingIds.length > 0) {
    target.push(`${label} is missing references: ${missingIds.join(', ')}`);
  }
}

function collectSalarySnapshotReferenceIssues(
  salaryRecords: NormalizedBackupPayload['salaryRecords'],
  employeeIds: Set<number>,
  target: string[]
): void {
  const missingEmployeeRefs = new Map<number, Set<number>>();

  for (const record of salaryRecords) {
    const attendanceData = Array.isArray(record.attendanceData) ? record.attendanceData : [];
    if (attendanceData.length === 0) {
      continue;
    }

    const recordId = typeof record.id === 'number' ? record.id : -1;

    for (const entry of attendanceData) {
      if (typeof entry.employeeId === 'number' && !employeeIds.has(entry.employeeId)) {
        if (!missingEmployeeRefs.has(recordId)) {
          missingEmployeeRefs.set(recordId, new Set());
        }
        missingEmployeeRefs.get(recordId)!.add(entry.employeeId);
      }
    }
  }

  for (const [recordId, ids] of Array.from(missingEmployeeRefs.entries())) {
    target.push(
      `salary record #${recordId === -1 ? 'unknown' : recordId} references missing employee IDs: ${Array.from(ids).sort((left, right) => left - right).join(', ')}`
    );
  }
}

function collectDeletedEmployeeLifecycleIssues(
  employees: NormalizedBackupPayload['employees'],
  target: string[]
): void {
  for (const employee of employees) {
    const identifier = typeof employee.id === 'number' ? `employee #${employee.id}` : 'employee <unknown>';
    const isDeleted = employee.deletedAt instanceof Date;

    if (!isDeleted) {
      if (employee.deletedBy != null || employee.purgeAfterAt != null) {
        target.push(`${identifier} has partial recycle-bin metadata without deletedAt`);
      }
      continue;
    }

    if (!(employee.purgeAfterAt instanceof Date)) {
      target.push(`${identifier} is deleted but missing purgeAfterAt`);
    } else if (!(employee.deletedAt instanceof Date) || employee.purgeAfterAt.getTime() <= employee.deletedAt.getTime()) {
      target.push(`${identifier} has purgeAfterAt that is not later than deletedAt`);
    }

    if (employee.lineUserId != null || employee.lineDisplayName != null || employee.linePictureUrl != null || employee.lineBindingDate != null) {
      target.push(`${identifier} is deleted but still carries LINE binding data`);
    }
  }
}

function collectPendingBindingLifecycleIssues(
  bindings: NormalizedBackupPayload['pendingBindings'],
  deletedEmployeeIds: Set<number>,
  target: string[]
): void {
  for (const binding of bindings) {
    const identifier = typeof binding.id === 'number' ? `pending binding #${binding.id}` : 'pending binding <unknown>';

    if (deletedEmployeeIds.has(binding.employeeId)) {
      target.push(`${identifier} references deleted employee #${binding.employeeId}`);
    }
  }
}

function isAnonymizedSalaryRecord(
  record: NormalizedBackupPayload['salaryRecords'][number]
): boolean {
  return record.employeeId == null || record.employeeName === ANONYMIZED_EMPLOYEE_NAME;
}

function collectSalaryRetentionLifecycleIssues(
  salaryRecords: NormalizedBackupPayload['salaryRecords'],
  target: string[]
): void {
  for (const record of salaryRecords) {
    const identifier = typeof record.id === 'number' ? `salary record #${record.id}` : 'salary record <unknown>';
    const attendanceData = Array.isArray(record.attendanceData) ? record.attendanceData : [];
    const isAnonymized = isAnonymizedSalaryRecord(record);

    if (!isAnonymized) {
      if (record.anonymizedAt != null || record.retentionUntil != null || record.employeeSnapshot != null) {
        target.push(`${identifier} is active but still contains anonymization retention metadata`);
      }
      continue;
    }

    if (record.employeeName !== ANONYMIZED_EMPLOYEE_NAME) {
      target.push(`${identifier} is anonymized but employeeName is not the anonymized sentinel`);
    }

    if (!(record.anonymizedAt instanceof Date)) {
      target.push(`${identifier} is anonymized but missing anonymizedAt`);
    }

    if (!(record.retentionUntil instanceof Date)) {
      target.push(`${identifier} is anonymized but missing retentionUntil`);
    } else if (record.anonymizedAt instanceof Date && record.retentionUntil.getTime() <= record.anonymizedAt.getTime()) {
      target.push(`${identifier} has retentionUntil that is not later than anonymizedAt`);
    }

    const snapshot = record.employeeSnapshot;
    if (!snapshot || typeof snapshot !== 'object') {
      target.push(`${identifier} is anonymized but missing employeeSnapshot`);
    } else {
      if (snapshot.deletedAt == null) {
        target.push(`${identifier} is anonymized but employeeSnapshot.deletedAt is missing`);
      }

      if (snapshot.retentionYears !== SALARY_RETENTION_YEARS) {
        target.push(`${identifier} is anonymized but employeeSnapshot.retentionYears is not ${SALARY_RETENTION_YEARS}`);
      }

      if (snapshot.retentionPolicy !== SALARY_RETENTION_POLICY) {
        target.push(`${identifier} is anonymized but employeeSnapshot.retentionPolicy is not ${SALARY_RETENTION_POLICY}`);
      }
    }

    const nonNullAttendanceEmployeeRefs = attendanceData
      .filter((entry) => entry && typeof entry === 'object' && (entry as { employeeId?: unknown }).employeeId != null)
      .map((entry) => (entry as { employeeId?: unknown }).employeeId);

    if (nonNullAttendanceEmployeeRefs.length > 0) {
      target.push(`${identifier} is anonymized but attendanceData still contains employeeId values`);
    }
  }
}

function inspectNormalizedBackupPayload(
  backupId: string,
  backupType: BackupType | 'unknown',
  backupPath: string,
  rawPayload: BackupPayload,
  payload: NormalizedBackupPayload
): BackupInspection {
  const errors: string[] = [];
  const warnings: string[] = [];
  const employeeIds = new Set(
    payload.employees
      .map((employee) => employee.id)
      .filter((id): id is number => typeof id === 'number')
  );
  const holidayIds = new Set(
    payload.holidays
      .map((holiday) => holiday.id)
      .filter((id): id is number => typeof id === 'number')
  );
  const deletedEmployeeIds = new Set(
    payload.employees
      .filter((employee) => employee.deletedAt instanceof Date)
      .map((employee) => employee.id)
      .filter((id): id is number => typeof id === 'number')
  );

  collectDuplicateIds(payload.employees, 'employees', errors);
  collectDuplicateIds(payload.holidays, 'holidays', errors);
  collectDuplicateIds(payload.pendingBindings, 'pendingBindings', errors);
  collectDuplicateIds(payload.salaryRecords, 'salaryRecords', errors);
  collectDuplicateIds(payload.temporaryAttendance, 'temporaryAttendance', errors);

  collectDuplicateIds(payload.calculationRules, 'calculation rules', errors);
  collectDuplicateComparableIds(payload.taiwanHolidays, 'taiwan_holidays', errors);

  collectMissingReferences(
    payload.holidays.map((holiday) => holiday.employeeId),
    employeeIds,
    'holiday.employeeId',
    errors
  );

  collectMissingReferences(
    payload.pendingBindings.map((binding) => binding.employeeId),
    employeeIds,
    'pendingBinding.employeeId',
    errors
  );

  collectMissingReferences(
    payload.salaryRecords.map((record) => record.employeeId),
    employeeIds,
    'salaryRecord.employeeId',
    errors
  );

  collectMissingReferences(
    payload.temporaryAttendance.map((attendance) => attendance.employeeId),
    employeeIds,
    'temporaryAttendance.employeeId',
    errors
  );

  collectMissingReferences(
    payload.temporaryAttendance.map((attendance) => attendance.holidayId),
    holidayIds,
    'temporaryAttendance.holidayId',
    errors
  );

  collectMissingReferences(
    payload.calculationRules.map((rule) => rule.employeeId),
    employeeIds,
    'calculation_rules references missing employee IDs',
    errors
  );

  collectSalarySnapshotReferenceIssues(payload.salaryRecords, employeeIds, errors);
  collectDeletedEmployeeLifecycleIssues(payload.employees, errors);
  collectPendingBindingLifecycleIssues(payload.pendingBindings, deletedEmployeeIds, errors);
  collectSalaryRetentionLifecycleIssues(payload.salaryRecords, errors);

  collectAuthorityMetadataIssues(rawPayload, payload, errors, warnings);

  if (!payload.metadata?.timestamp) {
    warnings.push('Backup metadata missing timestamp');
  }

  if (payload.metadata?.databaseType && payload.metadata.databaseType !== 'postgres') {
    warnings.push(`Unsupported metadata.databaseType: ${payload.metadata.databaseType}; expected PostgreSQL-only payload`);
  }

  return {
    backupId,
    backupType,
    path: backupPath,
    metadata: payload.metadata,
    counts: buildPayloadCounts(payload),
    authority: {
      version: BACKUP_AUTHORITY_VERSION,
      authoritativeTables: [...AUTHORITATIVE_TABLE_NAMES],
      excludedTables: EXCLUDED_BACKUP_TABLES.map((table) => ({ ...table }))
    },
    restoreOrder: [
      ...AUTHORITATIVE_RESTORE_DELETE_ORDER.map((payloadKey) => `delete ${getTableNameForPayloadKey(payloadKey)}`),
      ...AUTHORITATIVE_RESTORE_INSERT_ORDER.map((payloadKey) => `insert ${getTableNameForPayloadKey(payloadKey)}`),
      `reset serial sequences: ${AUTHORITATIVE_SEQUENCE_TABLES.join(', ')}`
    ],
    errors,
    warnings
  };
}

function getBackupSearchDirectories(type?: BackupType): string[] {
  if (!type) {
    return [
      getDailyBackupDir(),
      getWeeklyBackupDir(),
      getMonthlyBackupDir(),
      getManualBackupDir(),
      getBackupDir()
    ];
  }

  switch (type) {
    case BackupType.DAILY:
      return [getDailyBackupDir()];
    case BackupType.WEEKLY:
      return [getWeeklyBackupDir()];
    case BackupType.MONTHLY:
      return [getMonthlyBackupDir()];
    case BackupType.MANUAL:
    default:
      return [getManualBackupDir(), getBackupDir()];
  }
}

function resolveBackupPath(backupId: string, backupType?: BackupType): string {
  const safeBackupId = validateBackupId(backupId);

  for (const dir of getBackupSearchDirectories(backupType)) {
    const resolvedDir = path.resolve(dir);
    const filePath = path.resolve(resolvedDir, `${safeBackupId}.json`);

    if (!filePath.startsWith(`${resolvedDir}${path.sep}`)) {
      continue;
    }

    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  throw new Error(`Backup not found: ${safeBackupId}`);
}

async function resolveBackupPathAsync(backupId: string, backupType?: BackupType): Promise<string> {
  const safeBackupId = validateBackupId(backupId);

  for (const dir of getBackupSearchDirectories(backupType)) {
    const resolvedDir = path.resolve(dir);
    const filePath = path.resolve(resolvedDir, `${safeBackupId}.json`);

    if (!filePath.startsWith(`${resolvedDir}${path.sep}`)) {
      continue;
    }

    try {
      await fs.promises.access(filePath);
      return filePath;
    } catch {
      continue;
    }
  }

  throw new Error(`Backup not found: ${safeBackupId}`);
}

function parseBackupPayloadFromRaw(
  rawBackup: string,
  backupPath: string,
  options: { backupId: string; backupType?: BackupType | 'unknown' }
): { inspection: BackupInspection; payload: NormalizedBackupPayload } {
  const parsedBackup = JSON.parse(decryptBackupPayload(rawBackup)) as BackupPayload;
  const normalizedPayload = normalizeBackupPayload(parsedBackup);
  const inspection = inspectNormalizedBackupPayload(
    options.backupId,
    options.backupType ?? 'unknown',
    backupPath,
    parsedBackup,
    normalizedPayload
  );

  return {
    inspection,
    payload: normalizedPayload
  };
}

function readBackupInspectionFromPath(
  backupPath: string,
  options: { backupId: string; backupType?: BackupType | 'unknown' }
): { inspection: BackupInspection; payload: NormalizedBackupPayload } {
  const rawBackup = fs.readFileSync(backupPath, 'utf8');
  return parseBackupPayloadFromRaw(rawBackup, backupPath, options);
}

async function readBackupInspectionFromPathAsync(
  backupPath: string,
  options: { backupId: string; backupType?: BackupType | 'unknown' }
): Promise<{ inspection: BackupInspection; payload: NormalizedBackupPayload }> {
  const rawBackup = await fs.promises.readFile(backupPath, 'utf8');
  return parseBackupPayloadFromRaw(rawBackup, backupPath, options);
}

export function inspectBackupFileAtPath(
  backupPath: string,
  options: { backupId: string; backupType?: BackupType | 'unknown' }
): BackupInspection {
  return readBackupInspectionFromPath(backupPath, options).inspection;
}

export function inspectBackupFile(backupId: string, backupType?: BackupType): BackupInspection {
  const backupPath = resolveBackupPath(backupId, backupType);
  return inspectBackupFileAtPath(backupPath, {
    backupId,
    backupType: backupType ?? 'unknown'
  });
}

function extractRowList(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    return result as Array<Record<string, unknown>>;
  }

  if (result && typeof result === 'object' && 'rows' in result && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }

  return [];
}

function coerceNumber(value: unknown, label: string): number {
  const normalized =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;

  if (!Number.isFinite(normalized)) {
    throw new Error(`Invalid numeric value for ${label}`);
  }

  return normalized;
}

async function queryTableCount(executor: CountExecutor, tableName: string): Promise<number> {
  const rows = extractRowList(
    await executor.execute(sql.raw(`SELECT COUNT(*)::int AS count FROM ${tableName};`))
  );

  return coerceNumber(rows[0]?.count, `${tableName}.count`);
}

async function collectDatabaseCounts(executor: CountExecutor): Promise<DatabaseCounts> {
  const counts: DatabaseCounts = {
    employees: 0,
    hasSettings: false,
    pendingBindings: 0,
    holidays: 0,
    salaryRecords: 0,
    temporaryAttendance: 0,
    calculationRules: 0,
    taiwanHolidays: 0
  };

  for (const table of AUTHORITATIVE_BACKUP_TABLES) {
    const count = await queryTableCount(executor, table.tableName);
    assignDatabaseCount(counts, table.countKey, count, table.countMode);
  }

  return counts;
}

export async function getLiveDatabaseCounts(): Promise<DatabaseCounts> {
  return collectDatabaseCounts(db);
}

async function resetSerialSequence(executor: RestoreExecutor, tableName: string): Promise<void> {
  await executor.execute(
    sql.raw(
      `SELECT setval(pg_get_serial_sequence('${tableName}', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${tableName};`
    )
  );
}

async function clearTablesForRestore(executor: RestoreExecutor): Promise<void> {
  for (const payloadKey of AUTHORITATIVE_RESTORE_DELETE_ORDER) {
    await executor.delete(getSchemaTableByPayloadKey(payloadKey));
  }
}

async function restoreTableData(
  executor: RestoreExecutor,
  payload: NormalizedBackupPayload
): Promise<void> {
  for (const payloadKey of AUTHORITATIVE_RESTORE_INSERT_ORDER) {
    switch (payloadKey) {
      case 'employees':
        if (payload.employees.length > 0) {
          await executor.insert(schema.employees).values(payload.employees as typeof schema.employees.$inferInsert[]);
        }
        break;
      case 'settings':
        if (payload.settings) {
          await executor.insert(schema.settings).values(payload.settings as typeof schema.settings.$inferInsert);
        }
        break;
      case 'pendingBindings':
        if (payload.pendingBindings.length > 0) {
          await executor.insert(schema.pendingBindings).values(
            payload.pendingBindings as typeof schema.pendingBindings.$inferInsert[]
          );
        }
        break;
      case 'holidays':
        if (payload.holidays.length > 0) {
          await executor.insert(schema.holidays).values(payload.holidays as typeof schema.holidays.$inferInsert[]);
        }
        break;
      case 'salaryRecords':
        if (payload.salaryRecords.length > 0) {
          await executor
            .insert(schema.salaryRecords)
            .values(payload.salaryRecords as typeof schema.salaryRecords.$inferInsert[]);
        }
        break;
      case 'temporaryAttendance':
        if (payload.temporaryAttendance.length > 0) {
          await executor
            .insert(schema.temporaryAttendance)
            .values(payload.temporaryAttendance as typeof schema.temporaryAttendance.$inferInsert[]);
        }
        break;
      case 'calculationRules':
        if (payload.calculationRules.length > 0) {
          await executor
            .insert(schema.calculationRules)
            .values(payload.calculationRules as typeof schema.calculationRules.$inferInsert[]);
        }
        break;
      case 'taiwanHolidays':
        if (payload.taiwanHolidays.length > 0) {
          await executor
            .insert(schema.taiwanHolidays)
            .values(payload.taiwanHolidays as typeof schema.taiwanHolidays.$inferInsert[]);
        }
        break;
    }
  }
}

async function resetRestoreSequences(executor: RestoreExecutor): Promise<void> {
  for (const tableName of AUTHORITATIVE_SEQUENCE_TABLES) {
    await resetSerialSequence(executor, tableName);
  }
}

async function runAutomaticBackupCycle(lastBackup: BackupTimestamps): Promise<void> {
  const now = Date.now();

  if (now - lastBackup.daily >= AUTO_DAILY_BACKUP_INTERVAL) {
    try {
      const backupId = await createDatabaseBackup(BackupType.DAILY, `Daily backup ${new Date().toLocaleString()}`);
      log.info(`Created daily backup ${backupId}`);
      lastBackup.daily = now;
    } catch (error) {
      log.error('Failed to create daily backup:', error);
    }
  }

  if (now - lastBackup.weekly >= AUTO_WEEKLY_BACKUP_INTERVAL) {
    try {
      const backupId = await createDatabaseBackup(BackupType.WEEKLY, `Weekly backup ${new Date().toLocaleString()}`);
      log.info(`Created weekly backup ${backupId}`);
      lastBackup.weekly = now;
    } catch (error) {
      log.error('Failed to create weekly backup:', error);
    }
  }

  if (now - lastBackup.monthly >= AUTO_MONTHLY_BACKUP_INTERVAL) {
    try {
      const backupId = await createDatabaseBackup(BackupType.MONTHLY, `Monthly backup ${new Date().toLocaleString()}`);
      log.info(`Created monthly backup ${backupId}`);
      lastBackup.monthly = now;
    } catch (error) {
      log.error('Failed to create monthly backup:', error);
    }
  }
}

async function runInitialDailyBackup(lastBackup: BackupTimestamps): Promise<void> {
  const now = Date.now();
  const hasFreshDailyBackup =
    lastBackup.daily > 0 && now - lastBackup.daily < AUTO_DAILY_BACKUP_INTERVAL;

  if (hasFreshDailyBackup) {
    log.info('Skipping daily backup because a fresh daily backup already exists');
    return;
  }

  try {
    const backupId = await createDatabaseBackup(BackupType.DAILY, `Daily backup ${new Date().toLocaleString()}`);
    log.info(`Created daily backup ${backupId}`);
    lastBackup.daily = now;
  } catch (error) {
    log.error('Failed to create daily backup', error);
  }
}

/**
 * Backup types.
 */
export enum BackupType {
  MANUAL = 'manual',
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly'
}

/**
 * Create a database backup.
 */
export async function createDatabaseBackup(
  type: BackupType = BackupType.MANUAL,
  description?: string
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupId = `backup-${timestamp}`;
  // Choose the backup directory for the requested type.
  let backupDir;
  switch (type) {
    case BackupType.DAILY:
      backupDir = getDailyBackupDir();
      break;
    case BackupType.WEEKLY:
      backupDir = getWeeklyBackupDir();
      break;
    case BackupType.MONTHLY:
      backupDir = getMonthlyBackupDir();
      break;
    case BackupType.MANUAL:
    default:
      backupDir = getManualBackupDir();
      break;
  }

  const backupPath = path.join(backupDir, `${backupId}.json`);

  const data: BackupPayload = {
    metadata: {
      timestamp: new Date().toISOString(),
      type,
      description: description || `${type} backup`,
      version: '1.0.0',
      databaseType: 'postgres',
      authorityVersion: BACKUP_AUTHORITY_VERSION,
      authoritativeTables: [...AUTHORITATIVE_TABLE_NAMES],
      excludedTables: EXCLUDED_BACKUP_TABLES.map((table) => ({ ...table }))
    },
    employees: [],
    settings: null,
    holidays: [],
    pendingBindings: [],
    salaryRecords: [],
    temporaryAttendance: [],
    calculationRules: [],
    taiwanHolidays: []
  };

  try {
    await ensureBackupDirectoryExists(backupDir);

    // Capture the current application state.
    data.employees = await storage.getAllEmployeesIncludingDeleted();

    // Include current settings.
    data.settings = await storage.getSettings() ?? null;

    // Include holidays.
    data.holidays = await storage.getAllHolidays();

    // Include pending bindings.
    data.pendingBindings = await db.select().from(schema.pendingBindings);

    // Include salary records.
    data.salaryRecords = await storage.getAllSalaryRecords();

    // Include temporary attendance and reference tables.
    data.temporaryAttendance = await storage.getTemporaryAttendance();
    data.calculationRules = await db.select().from(schema.calculationRules);
    data.taiwanHolidays = await db.select().from(schema.taiwanHolidays);

    // Write with restrictive permissions and optional at-rest encryption.
    await fs.promises.writeFile(backupPath, serializeBackupPayload(data), {
      encoding: 'utf8',
      flag: 'wx',
      mode: BACKUP_FILE_MODE
    });

    log.info(`${type} backup created at ${backupPath}`);

    // Trim older backups in the same category.
    await cleanupOldBackups(backupDir);

    return backupId;
  } catch (error) {
    log.error(`Failed to create backup for ${type}`, error);
    throw new Error(`Backup creation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Remove old backups beyond the retention limit.
 */
async function cleanupOldBackups(backupDir: string): Promise<void> {
  try {
    const backupFiles = await fs.promises.readdir(backupDir);
    const files = await Promise.all(
      backupFiles
        .filter((file) => file.endsWith('.json'))
        .map(async (file) => {
          const filePath = path.join(backupDir, file);
          const stat = await fs.promises.stat(filePath);
          return {
            fileName: file,
            path: filePath,
            timestamp: stat.mtime.getTime()
          };
        })
    );

    files.sort((a, b) => b.timestamp - a.timestamp);

    // Delete anything beyond the retention window.
    if (files.length > MAX_BACKUPS_PER_CATEGORY) {
      const filesToDelete = files.slice(MAX_BACKUPS_PER_CATEGORY);
      for (const file of filesToDelete) {
        try {
          await fs.promises.unlink(file.path);
          log.info(`Deleted backup ${file.path}`);
        } catch (err) {
          log.error(`Failed to delete backup ${file.path}`, err);
        }
      }
    }
  } catch (error) {
    log.error('Failed to clean up old backups', error);
  }
}

async function ensureBackupDirectoryExists(backupDir: string): Promise<void> {
  await fs.promises.mkdir(backupDir, { recursive: true, mode: BACKUP_DIR_MODE });
}

/**
 * List backups for the requested type.
 */
export async function getBackupsList(type?: BackupType): Promise<BackupListEntry[]> {
  try {
    const typeDirectories = type
      ? (() => {
          switch (type) {
            case BackupType.DAILY:
              return [{ dir: getDailyBackupDir(), type }];
            case BackupType.WEEKLY:
              return [{ dir: getWeeklyBackupDir(), type }];
            case BackupType.MONTHLY:
              return [{ dir: getMonthlyBackupDir(), type }];
            case BackupType.MANUAL:
            default:
              return [
                { dir: getManualBackupDir(), type: BackupType.MANUAL },
                { dir: getBackupDir(), type: BackupType.MANUAL }
              ];
          }
        })()
      : [
          { dir: getDailyBackupDir(), type: BackupType.DAILY },
          { dir: getWeeklyBackupDir(), type: BackupType.WEEKLY },
          { dir: getMonthlyBackupDir(), type: BackupType.MONTHLY },
          { dir: getManualBackupDir(), type: BackupType.MANUAL },
          { dir: getBackupDir(), type: BackupType.MANUAL }
        ];

    const backups = await Promise.all(
      typeDirectories.map(async ({ dir, type: backupType }) => {
        try {
          await fs.promises.access(dir);
        } catch {
          return [];
        }

        try {
          const files = await fs.promises.readdir(dir);
          const entries = await Promise.all(
            files
              .filter((file) => file.endsWith('.json'))
              .map(async (file) => {
                const filePath = path.join(dir, file);

                try {
                  const stat = await fs.promises.stat(filePath);
                  return {
                    id: file.replace('.json', ''),
                    timestamp: stat.mtime.getTime(),
                    fileName: file,
                    size: stat.size,
                    type: backupType,
                    path: filePath
                  } satisfies BackupListEntry;
                } catch (error) {
                  log.warn(`Failed to inspect backup file metadata: ${filePath}`, error);
                  return null;
                }
              })
          );

          return entries.filter((entry): entry is BackupListEntry => entry !== null);
        } catch (error) {
          log.warn(`Failed to inspect backup directory: ${dir}`, error);
          return [];
        }
      })
    );

    return backups.flat().sort((a, b) => b.timestamp - a.timestamp);
  } catch (error) {
    log.error('Failed to inspect backup metadata', error);
    return [];
  }
}

/**
 * Start the automatic backup scheduler.
 */
export function setupAutomaticBackups(): NodeJS.Timeout {
  void ensureBackupDirectories().catch((error) => {
    log.error('Failed to prepare backup directories', error);
  });

  if (automaticBackupTimer) {
    log.info('Automatic backup scheduler already running; reusing existing timer');
    return automaticBackupTimer;
  }

  log.info('Starting automatic backup scheduler');

  automaticBackupTimestamps = createInitialBackupTimestamps();

  automaticBackupTimer = setInterval(() => {
    if (!automaticBackupTimestamps) {
      return;
    }

    void runAutomaticBackupCycle(automaticBackupTimestamps);
  }, AUTO_BACKUP_CHECK_INTERVAL);

  void runInitialDailyBackup(automaticBackupTimestamps);

  return automaticBackupTimer;
}

export function stopAutomaticBackups(timerId?: NodeJS.Timeout): void {
  const targetTimer = timerId ?? automaticBackupTimer;

  if (!targetTimer) {
    return;
  }

  clearInterval(targetTimer);

  if (!timerId || targetTimer === automaticBackupTimer) {
    automaticBackupTimer = null;
    automaticBackupTimestamps = null;
  }

  log.info('Stopped automatic backup scheduler');
}

/**
 * Restore a backup into the live database.
 */
export async function restoreFromBackup(
  backupId: string,
  backupType?: BackupType,
  options: RestoreFromBackupOptions = {}
): Promise<boolean> {
  try {
    const backupPath = await resolveBackupPathAsync(backupId, backupType);
    const { inspection, payload } = await readBackupInspectionFromPathAsync(backupPath, {
      backupId,
      backupType: backupType ?? 'unknown'
    });

    if (inspection.errors.length > 0) {
      throw new Error(`Restore validation failed: ${inspection.errors.join('; ')}`);
    }

    if (inspection.warnings.length > 0) {
      log.warn(`Restore validation warnings: ${inspection.warnings.join('; ')}`);
    }

    if (!options.skipPreRestoreBackup) {
      await createDatabaseBackup(BackupType.MANUAL, `Restore backup ${new Date().toLocaleString()}`);
    }

      await runRestoreTransaction('restore', async (tx) => {
        await clearTablesForRestore(tx);
        await restoreTableData(tx, payload);
        await resetRestoreSequences(tx);
      });

    log.info(`Restore completed for ${backupId}`);
    return true;
  } catch (error) {
    log.error('Restore failed', error);
    throw new Error(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function rehearseRestoreFromBackup(
  backupId: string,
  backupType?: BackupType
): Promise<RestoreRehearsalResult> {
  try {
    const backupPath = await resolveBackupPathAsync(backupId, backupType);
    const { inspection, payload } = await readBackupInspectionFromPathAsync(backupPath, {
      backupId,
      backupType: backupType ?? 'unknown'
    });

    if (inspection.errors.length > 0) {
      throw new Error(`Restore validation failed: ${inspection.errors.join('; ')}`);
    }

    if (inspection.warnings.length > 0) {
      log.warn(`Restore validation warnings: ${inspection.warnings.join('; ')}`);
    }

    const liveCountsBefore = await collectDatabaseCounts(db);
    const rehearsalWarnings = [
      ...inspection.warnings,
      'Restore rehearsal skips sequence reset because PostgreSQL sequences are not transactional.'
    ];

    await runRestoreTransaction('restore rehearsal', async (tx) => {
      await clearTablesForRestore(tx);
      await restoreTableData(tx, payload);

      const restoredCountsInTransaction = await collectDatabaseCounts(tx);

      throw new RestoreRehearsalRollback({
        backupId: inspection.backupId,
        backupType: inspection.backupType,
        path: inspection.path,
        metadata: inspection.metadata,
        warnings: rehearsalWarnings,
        restoreOrder: inspection.restoreOrder,
        backupCounts: inspection.counts,
        liveCountsBefore,
        restoredCountsInTransaction,
        rehearsalRolledBack: true
      });
    });

    throw new Error('restore rehearsal rollback');
  } catch (error) {
    if (error instanceof RestoreRehearsalRollback) {
      log.info(`Restore rehearsal rolled back for ${backupId}`);
      return error.result;
    }

    log.error('Restore rehearsal failed', error);
    throw new Error(`Restore rehearsal failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Delete a backup file.
 */
export async function deleteBackup(
  backupId: string,
  backupType?: BackupType
): Promise<boolean> {
  const backupPath = await resolveBackupPathAsync(backupId, backupType);

  try {
    await fs.promises.unlink(backupPath);
    log.info(`Deleted backup ${backupPath}`);
    return true;
  } catch (error) {
    log.error(`Failed to delete backup at ${backupPath}`, error);
    throw new Error(`Failed to delete backup: ${error instanceof Error ? error.message : String(error)}`);
  }
}
