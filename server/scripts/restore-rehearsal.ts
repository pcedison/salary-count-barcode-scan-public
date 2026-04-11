import fs from 'fs';
import path from 'path';

import { getBackupRootDir } from '../config/runtimePaths';
import '../test-utils/load-env';
import { sql } from '../db';
import {
  BackupType,
  createDatabaseBackup,
  getBackupsList,
  inspectBackupFileAtPath,
  validateBackupId,
  rehearseRestoreFromBackup
} from '../db-monitoring';
import { createLogger } from '../utils/logger';

const log = createLogger('restore-rehearsal');

const REPORT_DIR = path.join(getBackupRootDir(), 'restore-rehearsal', 'reports');

function ensureDirectory(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readArgValue(flag: string): string | undefined {
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];

    if (arg === flag) {
      return process.argv[index + 1];
    }

    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }

  return undefined;
}

function normalizeBackupType(value?: string): BackupType | undefined {
  if (!value) {
    return undefined;
  }

  switch (value) {
    case BackupType.DAILY:
    case BackupType.WEEKLY:
    case BackupType.MONTHLY:
    case BackupType.MANUAL:
      return value;
    default:
      throw new Error(`不支援的 backup type：${value}`);
  }
}

function tryInspectBackup(backup: { id: string; path: string; type: BackupType }) {
  try {
    return inspectBackupFileAtPath(backup.path, {
      backupId: backup.id,
      backupType: backup.type
    });
  } catch (error) {
    log.warn('Skipping backup that could not be inspected', {
      backupId: backup.id,
      path: backup.path,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

async function main() {
  const requestedBackupId = readArgValue('--backup-id');
  const requestedBackupType = normalizeBackupType(readArgValue('--type'));
  const safeRequestedBackupId = requestedBackupId ? validateBackupId(requestedBackupId) : undefined;

  if (!safeRequestedBackupId) {
    const freshBackupType = requestedBackupType ?? BackupType.MANUAL;
    const freshBackupId = await createDatabaseBackup(
      freshBackupType,
      `restore rehearsal seed backup ${new Date().toLocaleString()}`
    );
    log.info('Created fresh backup for rehearsal.', {
      backupId: freshBackupId,
      type: freshBackupType
    });
  }

  const backups = await getBackupsList(requestedBackupType);

  if (backups.length === 0) {
    log.info('No backup files found. Skipping rehearsal.');
    return;
  }

  const inspectableBackups = backups
    .map((backup) => {
      const inspection = tryInspectBackup(backup);
      return inspection ? { backup, inspection } : null;
    })
    .filter((value): value is { backup: (typeof backups)[number]; inspection: ReturnType<typeof inspectBackupFileAtPath> } => value !== null);

  const selectedBackup = safeRequestedBackupId
    ? inspectableBackups.find(({ backup }) => backup.id === safeRequestedBackupId)
    : inspectableBackups.find(({ inspection }) => inspection.errors.length === 0);

  if (!selectedBackup) {
    throw new Error(
      safeRequestedBackupId
        ? `找不到指定備份：${safeRequestedBackupId}`
        : 'No restore-ready backup was found. Create a fresh compatible backup before running restore rehearsal.'
    );
  }

  const result = await rehearseRestoreFromBackup(selectedBackup.backup.id, selectedBackup.backup.type);

  ensureDirectory(REPORT_DIR);

  const reportPath = path.join(
    REPORT_DIR,
    `restore-rehearsal-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );

  const report = {
    metadata: {
      generatedAt: new Date().toISOString(),
      mode: 'restore-rehearsal',
      databaseType: 'postgres',
      rehearsalRolledBack: result.rehearsalRolledBack
    },
    result
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  log.info('Completed and rolled back successfully.', {
    backupId: result.backupId,
    type: result.backupType,
    path: result.path,
    backupCounts: result.backupCounts,
    liveCountsBefore: result.liveCountsBefore,
    restoredCountsInTransaction: result.restoredCountsInTransaction,
    warnings: result.warnings,
    reportPath
  });
}

main()
  .catch((error) => {
    log.error('Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 1 });
  });
