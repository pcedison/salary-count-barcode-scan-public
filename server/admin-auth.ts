import fs from 'fs';
import path from 'path';

import { ensureAuditLogDirExists, getAuditLogDir } from './config/runtimePaths';
import { storage } from './storage';
import {
  hashAdminPin,
  hashAdminPinAsync,
  AdminPinBusyError,
  isHashedPin,
  isSupportedPinInput,
  verifyStoredAdminPinAsync
} from './utils/adminPinAuth';
import { createLogger } from './utils/logger';

const log = createLogger('admin-auth');

let auditLogDirReadyPromise: Promise<void> | null = null;

function ensureAuditLogDir(): Promise<void> {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
    return Promise.resolve();
  }

  if (!auditLogDirReadyPromise) {
    auditLogDirReadyPromise = ensureAuditLogDirExists().catch((error) => {
      auditLogDirReadyPromise = null;
      throw error;
    });
  }

  return auditLogDirReadyPromise;
}

export enum PermissionLevel {
  BASIC = 1,
  STANDARD = 2,
  ADMIN = 3,
  SUPER = 4
}

export enum OperationType {
  AUTHORIZATION = 'authorization',
  VIEW = 'view',
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  DB_CONFIG = 'db_config',
  SYSTEM_CONFIG = 'system_config',
  BACKUP = 'backup',
  RESTORE = 'restore',
  LOGIN = 'login',
  LOGOUT = 'logout'
}

interface AuditLog {
  timestamp: number;
  operation: OperationType;
  userId?: string;
  userName?: string;
  details: string;
  ip?: string;
  success: boolean;
  errorMessage?: string;
}

function getConfiguredSuperAdminPin(): string | null {
  const configured = process.env.SUPER_ADMIN_PIN?.trim();
  return configured ? configured : null;
}

export function isSuperAdminPinConfigured(): boolean {
  const configured = getConfiguredSuperAdminPin();
  return configured !== null && isHashedPin(configured);
}

export async function verifyAdminPermission(
  pin: string,
  _requiredLevel: PermissionLevel = PermissionLevel.ADMIN
): Promise<boolean> {
  return (await verifyAdminCredential(pin)) !== null;
}

/** Retain the exact hash that was verified for a later atomic credential update. */
export async function verifyAdminCredential(pin: string): Promise<{ storedHash: string } | null> {
  if (!isSupportedPinInput(pin)) return null;
  try {
    const settings = await storage.getSettings();

    if (!settings?.adminPin) {
      return null;
    }

    const storedHash = settings.adminPin;
    return await verifyStoredAdminPinAsync(storedHash, pin) ? { storedHash } : null;
  } catch (error) {
    if (error instanceof AdminPinBusyError) throw error;
    log.error('Failed to verify admin permission', { name: error instanceof Error ? error.name : 'UnknownError' });
    return null;
  }
}

export async function verifySuperAdminPermission(pin: string): Promise<boolean> {
  if (!isSupportedPinInput(pin)) return false;
  const configuredSuperPin = getConfiguredSuperAdminPin();
  // SUPER requires its own configured hash in every environment. Tests that
  // bypass credential verification must stub this function explicitly.
  if (!configuredSuperPin || !isHashedPin(configuredSuperPin)) return false;
  return verifyStoredAdminPinAsync(configuredSuperPin, pin);
}

export function logOperation(
  operation: OperationType,
  details: string,
  options?: {
    userId?: string;
    userName?: string;
    ip?: string;
    success?: boolean;
    errorMessage?: string;
  }
): void {
  const timestamp = Date.now();
  const entry: AuditLog = {
    timestamp,
    operation,
    details,
    success: options?.success !== undefined ? options.success : true,
    ...options
  };

  const date = new Date(timestamp);
  const fileName = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}.log`;
  const logPath = path.join(getAuditLogDir(), fileName);
  const logString = `${JSON.stringify(entry)}\n`;
  const shouldWriteAuditLog =
    process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true';

  if (shouldWriteAuditLog) {
    void ensureAuditLogDir()
      .then(() => fs.promises.appendFile(logPath, logString))
      .catch((writeError) => {
        log.error('Failed to write audit log entry', writeError);
      });
  }

  if (
    operation === OperationType.DB_CONFIG ||
    operation === OperationType.SYSTEM_CONFIG ||
    operation === OperationType.BACKUP ||
    operation === OperationType.RESTORE ||
    !entry.success
  ) {
    log.info(
      `[audit] ${new Date(timestamp).toLocaleString()} ${operation}: ${details}${entry.success ? '' : ' (failed)'}`
    );
  }
}

export async function getOperationLogs(date?: Date, filterType?: OperationType): Promise<AuditLog[]> {
  try {
    const targetDate = date || new Date();
    const fileName = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(
      targetDate.getDate()
    ).padStart(2, '0')}.log`;
    const logPath = path.join(getAuditLogDir(), fileName);

    let content: string;
    try {
      content = await fs.promises.readFile(logPath, 'utf8');
    } catch {
      return [];
    }

    const lines = content.split('\n').filter((line) => line.trim());
    let logs: AuditLog[] = [];

    for (const line of lines) {
      try {
        logs.push(JSON.parse(line) as AuditLog);
      } catch (error) {
        log.error('Failed to parse audit log entry', line, error);
      }
    }

    if (filterType) {
      logs = logs.filter((entry) => entry.operation === filterType);
    }

    logs.sort((left, right) => right.timestamp - left.timestamp);
    return logs;
  } catch (error) {
    log.error('Failed to load operation logs', error);
    return [];
  }
}

export async function getAvailableLogDates(): Promise<{ date: Date; count: number }[]> {
  try {
    let files: string[];

    try {
      files = (await fs.promises.readdir(getAuditLogDir())).filter((file) => file.endsWith('.log'));
    } catch {
      return [];
    }

    const results = await Promise.all(
      files.map(async (file) => {
        const [year, month, day] = file.replace('.log', '').split('-').map(Number);
        const date = new Date(year, month - 1, day);

        try {
          const content = await fs.promises.readFile(path.join(getAuditLogDir(), file), 'utf8');
          const count = content.split('\n').filter((line) => line.trim()).length;
          return { date, count };
        } catch {
          return { date, count: 0 };
        }
      })
    );

    return results.sort((left, right) => right.date.getTime() - left.date.getTime());
  } catch (error) {
    log.error('Failed to list available audit log dates', error);
    return [];
  }
}

export function hashPassword(password: string): string {
  return hashAdminPin(password);
}

export async function hashPasswordAsync(password: string): Promise<string> {
  return hashAdminPinAsync(password);
}
