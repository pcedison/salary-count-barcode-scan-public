/**
 * Database monitoring, backup, and restore helpers.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db';
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
import { assertRestoreMaintenance } from './config/payrollWrites';
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
const DEFAULT_PRODUCTION_STARTUP_BACKUP_DELAY_MS = 10 * 60 * 1000; // 10 minutes

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
let automaticBackupStartupTimer: NodeJS.Timeout | null = null;

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
  salaryCorrections?: typeof schema.salaryCorrections.$inferSelect[];
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
  salaryCorrections: typeof schema.salaryCorrections.$inferSelect[];
  journalCoverage: 'complete' | 'legacy-unrevised';
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
  journalCoverage: NormalizedBackupPayload['journalCoverage'];
  authority: {
    version: number;
    authoritativeTables: string[];
    excludedTables: Array<{ tableName: string; reason: string }>;
  };
  restoreOrder: string[];
  errors: string[];
  warnings: string[];
};

type RestoreExecutor = Pick<typeof db, 'delete' | 'insert' | 'execute' | 'select'>;
type CountExecutor = Pick<typeof db, 'execute'>;

const ANONYMIZED_EMPLOYEE_NAME = '[ANONYMIZED EMPLOYEE - RETAIN 5 YEARS]';

export type DatabaseCounts = {
  employees: number;
  hasSettings: boolean;
  pendingBindings: number;
  holidays: number;
  salaryRecords: number;
  salaryCorrections: number;
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

export type RestoreFromBackupOptions = {
  skipPreRestoreBackup?: boolean;
  confirmJournalReplacement?: boolean;
  confirmationToken?: string;
};

export type RestorePayrollAmounts = { grossSalary: number; totalDeductions: number; netSalary: number };

export type RestoreSalaryRecordImpact = {
  salaryRecordId: number;
  beforeRevision: number | null;
  afterRevision: number | null;
  before: RestorePayrollAmounts | null;
  after: RestorePayrollAmounts | null;
  delta: RestorePayrollAmounts;
  projectionChanged: boolean;
  added: boolean;
  deleted: boolean;
};

export type RestorePreflight = {
  backupId: string;
  backupCounts: DatabaseCounts;
  liveCounts: DatabaseCounts;
  journalCoverage: NormalizedBackupPayload['journalCoverage'];
  replacedJournalRows: number;
  requiresJournalConfirmation: boolean;
  changedSalaryRecords: RestoreSalaryRecordImpact[];
  payrollTotals: {
    before: RestorePayrollAmounts;
    after: RestorePayrollAmounts;
    delta: RestorePayrollAmounts;
  };
  confirmationToken: string;
};

export class RestoreSafetyError extends Error {
  readonly status = 409;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RestoreSafetyError';
  }
}

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

/** All authoritative values must come from the same PostgreSQL snapshot. */
async function readAuthoritativeSnapshot(executor: Pick<typeof db, 'select'>): Promise<BackupPayload> {
  const snapshot: BackupPayload = {};
  for (const { payloadKey } of AUTHORITATIVE_BACKUP_TABLES) {
    const rows = await executor.select().from(getSchemaTableByPayloadKey(payloadKey));
    rows.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
    if (payloadKey === 'settings') snapshot.settings = rows[0] as typeof schema.settings.$inferSelect ?? null;
    else snapshot[payloadKey] = rows as never;
  }
  return snapshot;
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
    case 'salaryCorrections':
      return schema.salaryCorrections;
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
    case 'salaryCorrections':
      return payload.salaryCorrections.length;
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
    salaryCorrections: 0,
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
  const legacyJournal = normalizedPayload.journalCoverage === 'legacy-unrevised';
  const missingPayloadKeys = AUTHORITATIVE_BACKUP_PAYLOAD_KEYS.filter((payloadKey) =>
    !(payloadKey in rawPayload) && !(legacyJournal && payloadKey === 'salaryCorrections'));

  if (unexpectedKeys.length > 0) {
    errors.push(`Unexpected backup payload keys: ${unexpectedKeys.join(', ')}`);
  }

  if (missingPayloadKeys.length > 0) {
    errors.push(`Backup payload is missing authoritative tables: ${missingPayloadKeys.join(', ')}`);
  }

  if (!normalizedPayload.metadata?.authorityVersion) {
    warnings.push('Backup metadata is missing authorityVersion; treat as legacy artifact.');
  } else if (normalizedPayload.metadata.authorityVersion !== BACKUP_AUTHORITY_VERSION &&
    !(legacyJournal && normalizedPayload.metadata.authorityVersion === 2)) {
    errors.push(
      `Backup authorityVersion mismatch: expected ${BACKUP_AUTHORITY_VERSION}, received ${normalizedPayload.metadata.authorityVersion}`
    );
  }

  if (!normalizedPayload.metadata?.authoritativeTables) {
    warnings.push('Backup metadata is missing authoritativeTables.');
  } else {
    const actual = [...normalizedPayload.metadata.authoritativeTables].sort();
    const expected = AUTHORITATIVE_TABLE_NAMES.filter(name => !(legacyJournal && name === 'salary_corrections')).sort();

    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(
        `Backup authoritativeTables mismatch: expected ${expected.join(', ')}, received ${actual.join(', ')}`
      );
    }
  }

  if (legacyJournal) {
    if (normalizedPayload.metadata?.authorityVersion === BACKUP_AUTHORITY_VERSION) {
      errors.push('Current authority backups must include salaryCorrections, even when empty.');
    }
    if (normalizedPayload.salaryRecords.some(record => (record.revision ?? 0) !== 0)) {
      errors.push('Legacy backup without salaryCorrections contains revised salary records; journal evidence is unavailable.');
    } else {
      warnings.push('Legacy backup has no correction journal; restore is permitted only when the target has no journal.');
    }
  }

  if (!normalizedPayload.metadata?.excludedTables) {
    warnings.push('Backup metadata is missing excludedTables.');
  } else {
    const actualExcluded = normalizedPayload.metadata.excludedTables
      .map((entry) => entry.tableName)
      .filter((tableName): tableName is string => typeof tableName === 'string')
      .sort();
    const expectedExcluded = EXCLUDED_TABLE_NAMES.filter(name => !(legacyJournal && name === 'monthly_salary_runs')).sort();

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
    salaryCorrections: normalizeRecordArray<typeof schema.salaryCorrections.$inferSelect>(
      parsed.salaryCorrections, 'salaryCorrections'
    ).map(correction => ({ ...correction, createdAt: normalizeTimestampValue(correction.createdAt)! })),
    journalCoverage: Object.prototype.hasOwnProperty.call(parsed, 'salaryCorrections') ? 'complete' : 'legacy-unrevised',
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

const correctionBackupSchema = z.object({
  id: z.number().int().positive(), salaryRecordId: z.number().int().positive().nullable(),
  originalRecordId: z.number().int().positive(), revision: z.number().int().positive(),
  idempotencyKey: z.string().uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  previewTokenHash: z.string().regex(/^[a-f0-9]{64}$/), actorId: z.string().regex(/^[a-f0-9]{64}$/),
  actorRole: z.string().min(1), reason: z.string().min(1).max(1000),
  paymentHandling: z.enum(['unpaid', 'paid_adjustment', 'unknown_adjustment']),
  holidays: z.array(z.record(z.string(), z.unknown())),
  delta: z.object({ grossSalary: z.number().finite(), totalDeductions: z.number().finite(),
    netSalary: z.number().finite(), totalHolidayPay: z.number().finite(), holidayDays: z.number().int() }),
  beforeSnapshot: z.record(z.string(), z.unknown()), afterSnapshot: z.record(z.string(), z.unknown()), createdAt: z.date(),
});

function comparableCorrectionProjection(record: typeof schema.salaryRecords.$inferSelect): unknown {
  // Match the audit producer's payroll fields, not its redacted employee identity.
  // Employee retention can change identity/retention metadata without a revision.
  const payrollKeys = ['id', 'revision', 'salaryYear', 'salaryMonth', 'baseSalary',
    'holidayCalculationBaseSalary', 'housingAllowance', 'welfareAllowance',
    'totalOT1Hours', 'totalOT2Hours', 'totalOvertimePay', 'holidayDays',
    'holidayDailySalary', 'totalHolidayPay', 'grossSalary', 'deductions',
    'allowances', 'totalDeductions', 'netSalary'] as const;
  const attendanceKeys = ['id', 'date', 'clockIn', 'clockOut', 'isHoliday',
    'isBarcodeScanned', 'holidayId', 'holidayType'] as const;
  const leaveKeys = ['usedDays', 'usedDates', 'cashDays', 'cashAmount', 'cashMonth'] as const;
  return {
    ...Object.fromEntries(payrollKeys.map(key => [key, record[key] ?? null])),
    attendanceData: Array.isArray(record.attendanceData) ? record.attendanceData.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      return {
        ...Object.fromEntries(attendanceKeys.map(key => [key, row[key] ?? null])),
        createdAt: normalizeTimestampValue(row.createdAt) ?? null,
      };
    }) : record.attendanceData ?? null,
    specialLeaveInfo: record.specialLeaveInfo
      ? Object.fromEntries(leaveKeys.map(key => [key, record.specialLeaveInfo![key] ?? null])) : null,
    createdAt: normalizeTimestampValue(record.createdAt) ?? null,
  };
}

function collectCorrectionJournalIssues(payload: NormalizedBackupPayload, errors: string[], warnings: string[]): void {
  const projections = new Map(payload.salaryRecords.map(record => [record.id, record]));
  const latestJournals = new Map<number, NormalizedBackupPayload['salaryCorrections'][number]>();
  const revisions = new Set<string>();
  const keys = new Set<string>();
  for (const row of payload.salaryCorrections) {
    if (!correctionBackupSchema.safeParse(row).success) {
      errors.push('salaryCorrections contains an invalid audit row.');
      continue;
    }
    if (row.revision > (latestJournals.get(row.originalRecordId)?.revision ?? 0)) {
      latestJournals.set(row.originalRecordId, row);
    }
    const revisionKey = `${row.originalRecordId}:${row.revision}`;
    const idempotencyKey = `${row.originalRecordId}:${row.idempotencyKey.toLowerCase()}`;
    if (revisions.has(revisionKey) || keys.has(idempotencyKey)) errors.push('salaryCorrections contains duplicate revision or idempotency keys.');
    revisions.add(revisionKey); keys.add(idempotencyKey);
    const projection = row.salaryRecordId === null ? undefined : projections.get(row.salaryRecordId);
    if (row.salaryRecordId !== null && (!projection || row.salaryRecordId !== row.originalRecordId ||
      (projection.revision ?? 0) < row.revision)) errors.push('salaryCorrections has an invalid salary projection link or revision.');
    const before = row.beforeSnapshot, after = row.afterSnapshot;
    if (before.id !== row.originalRecordId || after.id !== row.originalRecordId ||
      after.revision !== row.revision || before.revision !== row.revision - 1) {
      errors.push('salaryCorrections snapshots do not match the original record and revision.');
    }
    for (const key of ['grossSalary', 'totalDeductions', 'netSalary', 'totalHolidayPay', 'holidayDays'] as const) {
      const previous = before[key] ?? (key === 'grossSalary' || key === 'netSalary' ? Number.NaN : 0);
      const next = after[key] ?? (key === 'grossSalary' || key === 'netSalary' ? Number.NaN : 0);
      if (!Number.isFinite(previous) || !Number.isFinite(next) || Math.abs(next - previous - row.delta[key]) > 0.000001) {
        errors.push('salaryCorrections contains inconsistent snapshot amounts or delta.');
        break;
      }
    }
  }
  for (const row of Array.from(latestJournals.values())) {
    const projection = projections.get(row.salaryRecordId ?? row.originalRecordId);
    // A null link cannot hide an extant projection with the same original ID.
    // Absent projections are retained history; higher revisions can originate
    // from historical automation and do not equal older stored snapshots.
    if (projection && projection.revision === row.revision &&
      stableJson(comparableCorrectionProjection(projection)) !==
      stableJson(comparableCorrectionProjection(row.afterSnapshot))) {
      errors.push('salaryCorrections latest snapshot does not match its salary projection.');
    }
  }
  // Older automation can increment projection revisions without creating a journal.
  // Backup promises all stored journal rows, not a fabricated continuous history.
  if (payload.journalCoverage === 'complete' && payload.salaryRecords.some(record =>
    (record.revision ?? 0) > 0 && !payload.salaryCorrections.some(row => row.originalRecordId === record.id))) {
    warnings.push('Some salary revisions have no stored correction journal; pre-journal or automated history cannot be reconstructed.');
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
  collectDuplicateIds(payload.salaryCorrections, 'salaryCorrections', errors);
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
  collectCorrectionJournalIssues(payload, errors, warnings);

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
    journalCoverage: payload.journalCoverage,
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
    salaryCorrections: 0,
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
  // Retained journals reserve original salary IDs even after projections expire.
  const retainedSalaryId = tableName === 'salary_records'
    ? ', COALESCE((SELECT MAX(original_record_id) FROM salary_corrections), 1)' : '';
  await executor.execute(
    sql.raw(
      `SELECT setval(pg_get_serial_sequence('${tableName}', 'id'), GREATEST(COALESCE(MAX(id), 1), COALESCE(pg_sequence_last_value(pg_get_serial_sequence('${tableName}', 'id')::regclass), 1)${retainedSalaryId}), true) FROM ${tableName};`
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
      case 'salaryCorrections':
        if (payload.salaryCorrections.length > 0) {
          await executor.insert(schema.salaryCorrections).values(payload.salaryCorrections);
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

function getStartupBackupDelayMs(): number {
  const configured = process.env.AUTO_BACKUP_STARTUP_DELAY_MS?.trim();

  if (configured) {
    const parsed = Number.parseInt(configured, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }

    log.warn(
      `Ignoring invalid AUTO_BACKUP_STARTUP_DELAY_MS value: ${configured}`
    );
  }

  return process.env.NODE_ENV === 'production'
    ? DEFAULT_PRODUCTION_STARTUP_BACKUP_DELAY_MS
    : 0;
}

function scheduleInitialDailyBackup(lastBackup: BackupTimestamps): void {
  const startupDelayMs = getStartupBackupDelayMs();

  if (startupDelayMs <= 0) {
    void runInitialDailyBackup(lastBackup);
    return;
  }

  log.info(`Delaying startup daily backup by ${startupDelayMs} ms`);
  automaticBackupStartupTimer = setTimeout(() => {
    automaticBackupStartupTimer = null;
    void runInitialDailyBackup(lastBackup);
  }, startupDelayMs);
  automaticBackupStartupTimer.unref?.();
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
    salaryCorrections: [],
    temporaryAttendance: [],
    calculationRules: [],
    taiwanHolidays: []
  };

  try {
    await ensureBackupDirectoryExists(backupDir);

    Object.assign(data, await db.transaction(tx => readAuthoritativeSnapshot(tx), {
      isolationLevel: 'repeatable read', accessMode: 'read only'
    }));
    const normalized = normalizeBackupPayload(data);
    const inspection = inspectNormalizedBackupPayload(backupId, type, backupPath, data, normalized);
    if (inspection.errors.length) throw new Error('Current database cannot produce a valid authoritative backup.');

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

  scheduleInitialDailyBackup(automaticBackupTimestamps);

  return automaticBackupTimer;
}

export function stopAutomaticBackups(timerId?: NodeJS.Timeout): void {
  const targetTimer = timerId ?? automaticBackupTimer;

  if (!targetTimer) {
    return;
  }

  clearInterval(targetTimer);

  if (automaticBackupStartupTimer) {
    clearTimeout(automaticBackupStartupTimer);
    automaticBackupStartupTimer = null;
  }

  if (!timerId || targetTimer === automaticBackupTimer) {
    automaticBackupTimer = null;
    automaticBackupTimestamps = null;
  }

  log.info('Stopped automatic backup scheduler');
}

/**
 * Restore a backup into the live database.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && !(entry instanceof Date)) {
      return Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]));
    }
    return entry;
  });
}

function restorePayrollAmounts(record: NormalizedBackupPayload['salaryRecords'][number] | undefined): RestorePayrollAmounts | null {
  if (!record) return null;
  const amounts = { grossSalary: record.grossSalary, totalDeductions: record.totalDeductions ?? 0, netSalary: record.netSalary };
  if (!Object.values(amounts).every(Number.isFinite)) {
    throw new RestoreSafetyError('INVALID_RESTORE_PAYROLL_TOTALS', 'Payroll amounts cannot be safely summarized for restore.');
  }
  return amounts;
}

function restorePreflightForSnapshot(backupId: string, payload: NormalizedBackupPayload, live: BackupPayload): RestorePreflight {
  const current = normalizeBackupPayload(live);
  if (payload.journalCoverage === 'legacy-unrevised' && (current.salaryCorrections.length > 0 ||
    current.salaryRecords.some(record => (record.revision ?? 0) !== 0))) {
    throw new RestoreSafetyError('LEGACY_BACKUP_JOURNAL_UNAVAILABLE', 'A legacy backup without correction evidence cannot replace a database containing a journal or revised salary projections.');
  }
  const incoming = new Map(payload.salaryCorrections.map(row => [row.id, stableJson(row)]));
  const replacedJournalRows = current.salaryCorrections.filter(row => incoming.get(row.id) !== stableJson(row)).length;
  const currentRecords = new Map(current.salaryRecords.map(row => [row.id, row]));
  const backupRecords = new Map(payload.salaryRecords.map(row => [row.id, row]));
  const changedSalaryRecords: RestoreSalaryRecordImpact[] = [];
  const recordIds = new Set(Array.from(currentRecords.keys()).concat(Array.from(backupRecords.keys())));
  for (const salaryRecordId of Array.from(recordIds).sort((a, b) => a - b)) {
    const currentRecord = currentRecords.get(salaryRecordId), backupRecord = backupRecords.get(salaryRecordId);
    if (stableJson(currentRecord ?? null) === stableJson(backupRecord ?? null)) continue;
    const before = restorePayrollAmounts(currentRecord), after = restorePayrollAmounts(backupRecord);
    changedSalaryRecords.push({ salaryRecordId,
      beforeRevision: currentRecord ? currentRecord.revision ?? 0 : null,
      afterRevision: backupRecord ? backupRecord.revision ?? 0 : null,
      before, after,
      delta: { grossSalary: (after?.grossSalary ?? 0) - (before?.grossSalary ?? 0),
        totalDeductions: (after?.totalDeductions ?? 0) - (before?.totalDeductions ?? 0),
        netSalary: (after?.netSalary ?? 0) - (before?.netSalary ?? 0) },
      projectionChanged: true, added: !currentRecord, deleted: !backupRecord });
  }
  const totals = (records: NormalizedBackupPayload['salaryRecords']) => records.reduce((sum, record) => {
    const amounts = restorePayrollAmounts(record)!;
    for (const key of ['grossSalary', 'totalDeductions', 'netSalary'] as const) {
      sum[key] += amounts[key];
    }
    return sum;
  }, { grossSalary: 0, totalDeductions: 0, netSalary: 0 });
  const before = totals(current.salaryRecords), after = totals(payload.salaryRecords);
  return {
    backupId, backupCounts: buildPayloadCounts(payload), liveCounts: buildPayloadCounts(current),
    journalCoverage: payload.journalCoverage, replacedJournalRows,
    requiresJournalConfirmation: replacedJournalRows > 0, changedSalaryRecords,
    payrollTotals: { before, after, delta: { grossSalary: after.grossSalary - before.grossSalary,
      totalDeductions: after.totalDeductions - before.totalDeductions, netSalary: after.netSalary - before.netSalary } },
    // This is a freshness check, not authorization. The authenticated operator
    // must separately and explicitly confirm the journal replacement impact.
    confirmationToken: crypto.createHash('sha256').update(stableJson({ backupId, payload, current })).digest('hex')
  };
}

/** Metadata-only impact preview; does not create a backup or mutate the database. */
export async function getRestorePreflight(backupId: string, backupType?: BackupType): Promise<RestorePreflight> {
  const backupPath = await resolveBackupPathAsync(backupId, backupType);
  const { inspection, payload } = await readBackupInspectionFromPathAsync(backupPath, { backupId, backupType: backupType ?? 'unknown' });
  if (inspection.errors.length) throw new RestoreSafetyError('INVALID_RESTORE_BACKUP', 'The selected backup failed restore validation.');
  return db.transaction(async tx => restorePreflightForSnapshot(backupId, payload, await readAuthoritativeSnapshot(tx)), {
    isolationLevel: 'repeatable read', accessMode: 'read only'
  });
}

async function lockRestoreTables(executor: RestoreExecutor): Promise<void> {
  await executor.execute(sql.raw(`LOCK TABLE ${[...AUTHORITATIVE_TABLE_NAMES].sort().map(name => `public.${name}`).join(', ')} IN SHARE ROW EXCLUSIVE MODE`));
}

export async function invalidateRestoredAdminSessions(executor: Pick<RestoreExecutor, 'execute'>): Promise<void> {
  // Sessions are intentionally excluded from backups. Invalidate only sessions
  // with administrator authority, atomically with the restored payroll state.
  const epoch = crypto.randomUUID();
  await executor.execute(sql.raw(`DO $restore_sessions$
    BEGIN
      IF to_regclass('public.user_sessions') IS NOT NULL THEN
        EXECUTE 'DELETE FROM public.user_sessions WHERE sess::jsonb ? ''adminAuth''';
        EXECUTE 'INSERT INTO public.user_sessions (sid, sess, expire)
          VALUES (''__payroll_restore_epoch__'', ''{"payrollRestoreEpoch":"${epoch}"}'', ''2140-01-01'')
          ON CONFLICT (sid) DO UPDATE SET sess=EXCLUDED.sess, expire=EXCLUDED.expire';
      END IF;
    END $restore_sessions$;`));
}

export async function restoreFromBackup(
  backupId: string,
  backupType?: BackupType,
  options: RestoreFromBackupOptions = {}
): Promise<boolean> {
  assertRestoreMaintenance();
  try {
    const backupPath = await resolveBackupPathAsync(backupId, backupType);
    const { inspection, payload } = await readBackupInspectionFromPathAsync(backupPath, {
      backupId,
      backupType: backupType ?? 'unknown'
    });

    if (inspection.errors.length > 0) {
      throw new RestoreSafetyError('INVALID_RESTORE_BACKUP', 'Restore failed: the selected backup failed validation.');
    }

    if (inspection.warnings.length > 0) {
      log.warn(`Restore validation warnings: ${inspection.warnings.join('; ')}`);
    }

    if (!options.skipPreRestoreBackup) {
      await createDatabaseBackup(BackupType.MANUAL, `Restore backup ${new Date().toLocaleString()}`);
    }

      await runRestoreTransaction('restore', async (tx) => {
        await lockRestoreTables(tx);
        const impact = restorePreflightForSnapshot(backupId, payload, await readAuthoritativeSnapshot(tx));
        if (options.confirmationToken && options.confirmationToken !== impact.confirmationToken) {
          throw new RestoreSafetyError('RESTORE_STATE_CHANGED', 'The database or backup changed after preflight; review the restore impact again.');
        }
        if (impact.requiresJournalConfirmation && (options.confirmJournalReplacement !== true || options.confirmationToken !== impact.confirmationToken)) {
          throw new RestoreSafetyError('RESTORE_JOURNAL_CONFIRMATION_REQUIRED', 'Restoring this backup replaces stored correction evidence; review preflight and explicitly confirm its current impact.');
        }
        await clearTablesForRestore(tx);
        await restoreTableData(tx, payload);
        await invalidateRestoredAdminSessions(tx);
        await resetRestoreSequences(tx);
      });

    log.info(`Restore completed for ${backupId}`);
    return true;
  } catch (error) {
    log.error('Restore failed', { name: error instanceof Error ? error.name : 'UnknownError', code: getRetryableRestoreErrorCode(error) });
    if (error instanceof RestoreSafetyError) throw error;
    // Driver errors can contain every restored parameter, including HR data.
    throw new Error('Restore failed: transaction could not be completed.');
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

    const rehearsalWarnings = [
      ...inspection.warnings,
      'Restore rehearsal skips sequence reset because PostgreSQL sequences are not transactional.'
    ];

    await runRestoreTransaction('restore rehearsal', async (tx) => {
      await lockRestoreTables(tx);
      const impact = restorePreflightForSnapshot(backupId, payload, await readAuthoritativeSnapshot(tx));
      const liveCountsBefore = impact.liveCounts;
      await clearTablesForRestore(tx);
      await restoreTableData(tx, payload);
      await invalidateRestoredAdminSessions(tx);

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

    log.error('Restore rehearsal failed', { name: error instanceof Error ? error.name : 'UnknownError', code: getRetryableRestoreErrorCode(error) });
    throw new Error('Restore rehearsal failed: transaction could not be completed.');
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
